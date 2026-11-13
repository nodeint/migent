import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigurationError } from '@nodeint/migent-kernel';
import { afterEach, expect, test } from 'vitest';

import { listSessionRows } from '../src/query.ts';
import { deletePlannedSession, planSessionDeletion, setDeleteHooks, sweepDeletionLeftovers } from '../src/session-delete.ts';
import { createNumericSessionDirectory } from '../src/session-id.ts';
import { SESSION_LOCK_FILENAME, SessionLock } from '../src/session-lock.ts';
import { tempDir } from './support.ts';

afterEach(() => setDeleteHooks(null));

const DAY = 86_400_000;

function workspace(): { ws: string; root: string } {
  const ws = tempDir('migent-del-');
  const root = path.join(ws, '.migent', 'sessions');
  mkdirSync(root, { recursive: true });
  return { ws, root };
}

function session(root: string, id: string, status = 'completed', updatedAt = new Date().toISOString()): string {
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ status, updated_at: updatedAt, task: 't' }));
  writeFileSync(path.join(dir, 'data.txt'), 'x'.repeat(100));
  return dir;
}

function link(target: string, at: string): void {
  symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

test('plans mixed id formats in list order, dedupes, and treats dot names as not-found', () => {
  const { ws, root } = workspace();
  session(root, '1');
  session(root, '0e2c1e32-aaaa');
  session(root, '2026-01-01--x');
  const plan = planSessionDeletion(ws, { ids: ['1', '1', '0e2c1e32-aaaa', '.deleting', 'nope'] }, Date.now());
  expect(plan.planned.map((p) => p.session_id)).toEqual(['1', '0e2c1e32-aaaa']);
  expect(plan.refused).toEqual([
    { session_id: '.deleting', reason: 'not-found' },
    { session_id: 'nope', reason: 'not-found' },
  ]);
});

test('filters combine AND/OR and fall back to mtime for unreadable status', () => {
  const { ws, root } = workspace();
  const now = Date.now();
  session(root, '1', 'completed', new Date(now - 40 * DAY).toISOString());
  session(root, '2', 'cancelled', new Date(now - 40 * DAY).toISOString());
  session(root, '3', 'blocked', new Date(now - 40 * DAY).toISOString());
  session(root, '4', 'completed', new Date(now).toISOString());
  const bare = path.join(root, '5');
  mkdirSync(bare);
  utimesSync(bare, new Date(now - 50 * DAY), new Date(now - 50 * DAY));
  const ids = (selection: Parameters<typeof planSessionDeletion>[1]) =>
    planSessionDeletion(ws, selection, now).planned.map((p) => p.session_id);
  expect(ids({ olderThanMs: 30 * DAY, statuses: ['completed', 'cancelled'] }).sort()).toEqual(['1', '2']);
  expect(ids({ olderThanMs: 30 * DAY }).sort()).toEqual(['1', '2', '3', '5']);
  expect(ids({ statuses: ['completed'] }).sort()).toEqual(['1', '4']);
});

test('a live lock is refused, a stale one planned', () => {
  const { ws, root } = workspace();
  const dir = session(root, '1');
  session(root, '2');
  const lock = SessionLock.acquire(dir);
  try {
    const plan = planSessionDeletion(ws, { ids: ['1', '2'] }, Date.now());
    expect(plan.refused).toEqual([{ session_id: '1', reason: 'running' }]);
    expect(plan.planned.map((p) => p.session_id)).toEqual(['2']);
    expect(deletePlannedSession(ws, { ...plan.planned[0]!, session_id: '1' })).toEqual({ ok: false, error: 'running' });
  } finally {
    lock.release();
  }
});

test('deleting removes the session and never reissues its number', () => {
  const { ws, root } = workspace();
  for (const id of ['1', '2', '3']) session(root, id);
  const plan = planSessionDeletion(ws, { ids: ['3'] }, Date.now());
  const result = deletePlannedSession(ws, plan.planned[0]!);
  expect(result.ok).toBe(true);
  expect(listSessionRows(ws).map((row) => row[1]).sort()).toEqual(['1', '2']);
  expect(createNumericSessionDirectory(root)[0]).toBe('4');
  expect(readdirSync(path.join(root, '.deleting'))).toEqual([]);
});

test('a named link exits as a configuration error; a filter skips it', () => {
  const { ws, root } = workspace();
  const outside = tempDir('migent-outside-');
  writeFileSync(path.join(outside, 'cancel.requested'), '{}');
  link(outside, path.join(root, '7'));
  session(root, '8');
  expect(() => planSessionDeletion(ws, { ids: ['7'] }, Date.now())).toThrow(ConfigurationError);
  const plan = planSessionDeletion(ws, { statuses: ['completed'] }, Date.now());
  expect(plan.skippedLinks).toEqual(['7']);
  expect(plan.planned.map((p) => p.session_id)).toEqual(['8']);
  expect(existsSync(path.join(outside, 'cancel.requested'))).toBe(true);
});

test('a linked root, .deleting, or .last-id fails before any mutation', () => {
  const outside = tempDir('migent-outside-');
  const a = workspace();
  session(a.root, '1');
  link(outside, path.join(a.root, '.deleting'));
  expect(() => planSessionDeletion(a.ws, { ids: ['1'] }, Date.now())).toThrow(ConfigurationError);
  const b = workspace();
  writeFileSync(path.join(outside, 'f'), '9');
  symlinkSync(path.join(outside, 'f'), path.join(b.root, '.last-id'));
  expect(() => planSessionDeletion(b.ws, { ids: ['1'] }, Date.now())).toThrow(ConfigurationError);
  const c = tempDir('migent-del-');
  mkdirSync(path.join(c, '.migent'));
  link(outside, path.join(c, '.migent', 'sessions'));
  expect(() => planSessionDeletion(c, { ids: ['1'] }, Date.now())).toThrow(ConfigurationError);
  expect(readdirSync(outside)).toEqual(['f']);
});

test('plan-to-delete swap fails as not-contained and touches nothing outside', () => {
  const { ws, root } = workspace();
  const outside = tempDir('migent-outside-');
  writeFileSync(path.join(outside, 'cancel.requested'), '{}');
  session(root, '1');
  session(root, '2');
  const plan = planSessionDeletion(ws, { ids: ['1', '2'] }, Date.now());
  renameSync(path.join(root, '1'), path.join(root, '..', 'moved-1'));
  link(outside, path.join(root, '1'));
  expect(deletePlannedSession(ws, plan.planned[0]!)).toEqual({ ok: false, error: 'not-contained' });
  expect(deletePlannedSession(ws, plan.planned[1]!).ok).toBe(true);
  expect(readdirSync(outside)).toEqual(['cancel.requested']);
});

test('a swap between acquire and check 2 is rejected without touching the target', () => {
  const { ws, root } = workspace();
  const outside = tempDir('migent-outside-');
  session(root, '1');
  const plan = planSessionDeletion(ws, { ids: ['1'] }, Date.now());
  setDeleteHooks({
    afterAcquire: () => {
      renameSync(path.join(root, '1'), path.join(root, '..', 'moved-1'));
      link(outside, path.join(root, '1'));
    },
  });
  expect(deletePlannedSession(ws, plan.planned[0]!)).toEqual({ ok: false, error: 'not-contained' });
  expect(readdirSync(outside)).toEqual([]);
  expect(existsSync(path.join(root, '..', 'moved-1', SESSION_LOCK_FILENAME))).toBe(true);
  expect(SessionLock.tryAcquire(path.join(root, '..', 'moved-1'))).toBeNull();
});

test('an injected rename failure leaves the session whole', () => {
  const { ws, root } = workspace();
  session(root, '1');
  const plan = planSessionDeletion(ws, { ids: ['1'] }, Date.now());
  setDeleteHooks({ renameFailure: () => { throw new Error('rename boom'); } });
  expect(deletePlannedSession(ws, plan.planned[0]!)).toEqual({ ok: false, error: 'rename boom' });
  expect(listSessionRows(ws)).toHaveLength(1);
  expect(existsSync(path.join(root, '1', SESSION_LOCK_FILENAME))).toBe(false);
});

test('a removal failure hides the session; naming it again or sweeping finishes it', () => {
  const { ws, root } = workspace();
  session(root, '1');
  session(root, '2');
  const plan = planSessionDeletion(ws, { ids: ['1'] }, Date.now());
  setDeleteHooks({ removeFailure: () => { throw new Error('rm boom'); } });
  expect(deletePlannedSession(ws, plan.planned[0]!)).toEqual({ ok: false, error: 'rm boom', hidden: true });
  setDeleteHooks(null);
  expect(listSessionRows(ws).map((row) => row[1])).toEqual(['2']);
  const retry = planSessionDeletion(ws, { ids: ['1'] }, Date.now());
  expect(retry.planned[0]).toMatchObject({ session_id: '1', leftover: true, title: null });
  expect(retry.planned[0]!.bytes).toBeGreaterThan(0);
  expect(deletePlannedSession(ws, retry.planned[0]!).ok).toBe(true);
  // sweep path
  session(root, '3');
  const p3 = planSessionDeletion(ws, { ids: ['3'] }, Date.now());
  setDeleteHooks({ removeFailure: () => { throw new Error('rm boom'); } });
  deletePlannedSession(ws, p3.planned[0]!);
  setDeleteHooks(null);
  expect(sweepDeletionLeftovers(ws, [])).toEqual(['3']);
  expect(readdirSync(path.join(root, '.deleting'))).toEqual([]);
});

test('a symlink inside a tombstone is unlinked, not followed', () => {
  const { ws, root } = workspace();
  const outside = tempDir('migent-outside-');
  const file = path.join(outside, 'keep.txt');
  writeFileSync(file, 'keep');
  const dir = session(root, '1');
  link(outside, path.join(dir, 'ext'));
  const plan = planSessionDeletion(ws, { ids: ['1'] }, Date.now());
  expect(deletePlannedSession(ws, plan.planned[0]!).ok).toBe(true);
  expect(existsSync(file)).toBe(true);
});

test('list ignores bookkeeping entries', () => {
  const { ws, root } = workspace();
  session(root, '1');
  mkdirSync(path.join(root, '.deleting', '9.abc'), { recursive: true });
  writeFileSync(path.join(root, '.last-id'), '5');
  writeFileSync(path.join(root, '.last-id.lock'), '{}');
  expect(listSessionRows(ws)).toHaveLength(1);
  expect(os.platform()).toBeTruthy();
  rmSync(path.join(root, '.deleting'), { recursive: true });
});

test('an invalid timestamp falls back to mtime with a null status that never matches --status', () => {
  const { ws, root } = workspace();
  const bad = session(root, '1', 'completed', 'invalid');
  const old = new Date(Date.now() - 50 * DAY);
  utimesSync(bad, old, old);
  const byStatus = planSessionDeletion(ws, { statuses: ['completed'] }, Date.now());
  expect(byStatus.planned).toEqual([]);
  const byAge = planSessionDeletion(ws, { olderThanMs: 30 * DAY }, Date.now());
  expect(byAge.planned[0]).toMatchObject({ session_id: '1', status: null, updated_at: null });
});

test('a sparse file with zero allocated blocks counts zero bytes', () => {
  if (process.platform === 'win32') return;
  const { ws, root } = workspace();
  const dir = path.join(root, '1');
  mkdirSync(dir, { recursive: true });
  const sparse = path.join(dir, 'sparse.bin');
  writeFileSync(sparse, '');
  truncateSync(sparse, 1024 ** 3);
  const stat = lstatSync(sparse);
  expect(stat.size).toBe(1024 ** 3);
  // Filesystems that do not support holes allocate blocks; the zero-block trigger cannot be built there.
  if (stat.blocks !== 0) return;
  const probe = planSessionDeletion(ws, { ids: ['1'] }, Date.now()).planned[0]!.bytes;
  rmSync(sparse);
  const empty = planSessionDeletion(ws, { ids: ['1'] }, Date.now()).planned[0]!.bytes;
  expect(probe).toBe(empty);
});

test('parent swaps before a check are rejected; hooks after the last check run only once the checks passed', () => {
  const { ws, root } = workspace();
  const outside = tempDir('migent-outside-');
  session(root, '1');
  session(root, '2');
  const plan = planSessionDeletion(ws, { ids: ['1', '2'] }, Date.now());
  // Swap .deleting before check 2 and 3: rejected, nothing leaves the root.
  mkdirSync(path.join(root, '.deleting'));
  setDeleteHooks({
    afterAcquire: (id) => {
      if (id !== '1') return;
      renameSync(path.join(root, '.deleting'), path.join(root, '..', 'moved-deleting'));
      link(outside, path.join(root, '.deleting'));
    },
  });
  expect(deletePlannedSession(ws, plan.planned[0]!)).toEqual({ ok: false, error: 'not-contained' });
  expect(readdirSync(outside)).toEqual([]);
  expect(existsSync(path.join(root, '1'))).toBe(true);
  setDeleteHooks(null);
  // The hook after the last check is reached only when every check passed (accepted R4 limit).
  rmSync(path.join(root, '.deleting'), { recursive: true, force: true });
  rmSync(path.join(root, '..', 'moved-deleting'), { recursive: true, force: true });
  let reached = 0;
  setDeleteHooks({ beforeRename: () => { reached += 1; } });
  expect(deletePlannedSession(ws, plan.planned[1]!).ok).toBe(true);
  expect(reached).toBe(1);
});

test('a sweep rejects a .deleting swapped before its checks and reaches its hook only after them', () => {
  const { ws, root } = workspace();
  const outside = tempDir('migent-outside-');
  mkdirSync(path.join(root, '.deleting', '5.abc'), { recursive: true });
  let reached = 0;
  setDeleteHooks({ afterSweepChecks: () => { reached += 1; } });
  expect(sweepDeletionLeftovers(ws, [])).toEqual(['5']);
  expect(reached).toBe(1);
  mkdirSync(path.join(root, '.deleting', '6.abc'), { recursive: true });
  renameSync(path.join(root, '.deleting'), path.join(root, '..', 'moved-deleting'));
  link(outside, path.join(root, '.deleting'));
  expect(() => sweepDeletionLeftovers(ws, [])).toThrow(ConfigurationError);
  expect(readdirSync(outside)).toEqual([]);
});

test('R4 rename schedule: .deleting replaced by a link after the last check is reproduced and documents the accepted limit', () => {
  const { ws, root } = workspace();
  const outside = tempDir('migent-outside-');
  session(root, '1');
  const plan = planSessionDeletion(ws, { ids: ['1'] }, Date.now());
  mkdirSync(path.join(root, '.deleting'));
  let swapped = false;
  setDeleteHooks({
    beforeRename: () => {
      renameSync(path.join(root, '.deleting'), path.join(root, '..', 'moved-deleting'));
      link(outside, path.join(root, '.deleting'));
      swapped = true;
    },
  });
  const outcome = deletePlannedSession(ws, plan.planned[0]!);
  expect(swapped).toBe(true);
  // A swap after the last check is not defended: the rename and removal resolve through the link.
  // The session leaves the root either way; the guarantee asserted here is only the before-check rejection above.
  expect(outcome.ok || outcome.error.length > 0).toBe(true);
  expect(existsSync(path.join(root, '1'))).toBe(false);
  expect(readdirSync(path.join(root, '..', 'moved-deleting'))).toEqual([]);
});

test('R4 sweep schedule: .deleting moved out and replaced by a link after the sweep checks is reproduced', () => {
  const { ws, root } = workspace();
  const outside = tempDir('migent-outside-');
  mkdirSync(path.join(root, '.deleting', '6.abc'), { recursive: true });
  const aside = path.join(root, '..', 'moved-deleting');
  setDeleteHooks({
    afterSweepChecks: () => {
      renameSync(path.join(root, '.deleting'), aside);
      link(outside, path.join(root, '.deleting'));
    },
  });
  expect(() => sweepDeletionLeftovers(ws, [])).not.toThrow();
  // Removal resolved through the replaced parent: the moved-aside leftover is untouched (accepted R4 limit).
  expect(readdirSync(aside)).toEqual(['6.abc']);
  expect(readdirSync(outside)).toEqual([]);
});
