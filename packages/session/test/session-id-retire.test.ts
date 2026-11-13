import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  createNumericSessionDirectory,
  readLastIdMark,
  retireSessionNumber,
  setAfterNumericClaim,
  setBeforeNumericClaim,
} from '../src/session-id.ts';
import { NumberingLockHeldError, SESSION_LOCK_FILENAME, sessionLockState, withNumberingLock } from '../src/session-lock.ts';
import { tempDir } from './support.ts';

afterEach(() => {
  setBeforeNumericClaim(null);
  setAfterNumericClaim(null);
});

function sessions(): string {
  return path.join(tempDir('migent-retire-'), 'sessions');
}

function seed(dir: string, count: number): void {
  for (let n = 1; n <= count; n += 1) mkdirSync(path.join(dir, String(n)), { recursive: true });
}

test('retiring 89 and 90 gives 91 next', () => {
  const dir = sessions();
  seed(dir, 90);
  retireSessionNumber(dir, 89);
  retireSessionNumber(dir, 90);
  rmSync(path.join(dir, '89'), { recursive: true });
  rmSync(path.join(dir, '90'), { recursive: true });
  expect(createNumericSessionDirectory(dir)[0]).toBe('91');
});

test('the mark never lowers', () => {
  const dir = sessions();
  seed(dir, 1);
  retireSessionNumber(dir, 90);
  retireSessionNumber(dir, 89);
  expect(readLastIdMark(dir)).toBe(90);
});

test('a missing or garbage mark falls back to the directory scan', () => {
  const dir = sessions();
  seed(dir, 3);
  expect(createNumericSessionDirectory(dir)[0]).toBe('4');
  writeFileSync(path.join(dir, '.last-id'), 'garbage');
  expect(readLastIdMark(dir)).toBe(0);
  expect(createNumericSessionDirectory(dir)[0]).toBe('5');
});

test('an allocator that paused before claiming a retired number moves on', () => {
  const dir = sessions();
  seed(dir, 89);
  let first = true;
  setBeforeNumericClaim((candidate) => {
    if (!first) return;
    first = false;
    expect(candidate).toBe(90);
    mkdirSync(path.join(dir, '90'));
    retireSessionNumber(dir, 90);
    renameSync(path.join(dir, '90'), path.join(dir, '..', 'gone-90'));
  });
  expect(createNumericSessionDirectory(dir)[0]).toBe('91');
  expect(existsSync(path.join(dir, '90'))).toBe(false);
});

test('a live numbering lock waits then fails; a stale one is taken over', () => {
  const dir = sessions();
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.last-id.lock');
  const info = (pid: number, host: string, heartbeat: string) =>
    JSON.stringify({ pid, host, started_at: heartbeat, heartbeat_at: heartbeat, nonce: 'x' });
  writeFileSync(lock, info(process.pid, os.hostname(), new Date().toISOString()));
  expect(() => withNumberingLock(dir, () => 1, { waitMs: 50 })).toThrow(NumberingLockHeldError);
  writeFileSync(lock, info(2_147_483_000, os.hostname(), new Date().toISOString()));
  expect(withNumberingLock(dir, () => 'ok')).toBe('ok');
  expect(existsSync(lock)).toBe(false);
});

test('sessionLockState covers none, live, elsewhere, dead pid, expired heartbeat', () => {
  const dir = tempDir('migent-state-');
  const file = path.join(dir, SESSION_LOCK_FILENAME);
  const write = (pid: number, host: string, heartbeat: Date) =>
    writeFileSync(file, JSON.stringify({ pid, host, started_at: '', heartbeat_at: heartbeat.toISOString(), nonce: 'n' }));
  expect(sessionLockState(dir)).toBe('stopped');
  write(process.pid, os.hostname(), new Date());
  expect(sessionLockState(dir)).toBe('running');
  write(process.pid, 'other-host', new Date());
  expect(sessionLockState(dir)).toBe('running-elsewhere');
  write(2_147_483_000, os.hostname(), new Date());
  expect(sessionLockState(dir)).toBe('stopped');
  write(process.pid, os.hostname(), new Date(Date.now() - 60_000));
  expect(sessionLockState(dir)).toBe('stopped');
  expect(readFileSync(file, 'utf8')).toContain('nonce');
});

test('an unreadable mark propagates instead of counting as 0', () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const dir = sessions();
  seed(dir, 4);
  const mark = path.join(dir, '.last-id');
  writeFileSync(mark, '90\n');
  chmodSync(mark, 0o000);
  try {
    expect(() => createNumericSessionDirectory(dir)).toThrow(/EACCES/u);
    expect(() => retireSessionNumber(dir, 5)).toThrow(/EACCES/u);
    expect(existsSync(path.join(dir, '5'))).toBe(false);
  } finally {
    chmodSync(mark, 0o600);
  }
  expect(readFileSync(mark, 'utf8')).toBe('90\n');
});

test('a retirement waits on a held numbering lock and cannot interleave', () => {
  const dir = sessions();
  seed(dir, 1);
  withNumberingLock(dir, () => {
    expect(() => retireSessionNumber(dir, 89, { waitMs: 50 })).toThrow(NumberingLockHeldError);
  });
  expect(readLastIdMark(dir)).toBe(0);
  retireSessionNumber(dir, 89, { waitMs: 50 });
  expect(readLastIdMark(dir)).toBe(89);
});

test('a dropped claim that cannot be removed stays an invisible empty directory and allocation goes higher', () => {
  const dir = sessions();
  seed(dir, 89);
  let first = true;
  setBeforeNumericClaim(() => {
    if (!first) return;
    first = false;
    retireSessionNumber(dir, 90);
  });
  setAfterNumericClaim((candidate, directory) => {
    if (candidate === 90) writeFileSync(path.join(directory, 'blocker'), 'x');
  });
  expect(createNumericSessionDirectory(dir)[0]).toBe('91');
  expect(existsSync(path.join(dir, '90', 'blocker'))).toBe(true);
  expect(existsSync(path.join(dir, '90', 'status.json'))).toBe(false);
});
