import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { GROK_CONFIG, PROVIDER_BIN, removeWorkspace, SOLO, tempWorkspace, writeWorkspace } from './support.ts';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'cli', 'dist', 'index.js');

function migent(workspace: string, ...argv: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...argv], {
    cwd: workspace,
    env: { ...process.env, PATH: `${PROVIDER_BIN}${path.delimiter}${process.env.PATH ?? ''}`, MIGENT_NO_INPUT: '1' },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function sessionDir(workspace: string, id: string): string {
  return path.join(workspace, '.migent', 'sessions', id);
}

function addSession(workspace: string, id: string, status = 'completed'): string {
  const directory = sessionDir(workspace, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'status.json'), JSON.stringify({ session_id: id, status, updated_at: new Date().toISOString() }));
  return directory;
}

function writeLock(directory: string, pid: number): void {
  const now = new Date().toISOString();
  writeFileSync(path.join(directory, 'session.lock'), JSON.stringify({ pid, host: os.hostname(), started_at: now, heartbeat_at: now, nonce: 'n' }));
}

test('a live holder is refused, a dead holder is deleted, and list and show forget the session', () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, { solo: SOLO });
    writeLock(addSession(workspace, 'live'), process.pid);
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    writeLock(addSession(workspace, 'dead'), dead.pid ?? 2_147_483_000);

    const refused = migent(workspace, 'session', 'delete', 'live', 'dead', '--yes', '--json');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('migent session cancel live');
    const json = JSON.parse(refused.stdout);
    expect(json.deleted).toEqual(['dead']);
    expect(json.refused).toEqual([{ session_id: 'live', reason: 'running' }]);
    expect(existsSync(sessionDir(workspace, 'live'))).toBe(true);

    expect(migent(workspace, 'session', 'list').stdout).not.toContain('dead');
    const show = migent(workspace, 'session', 'show', 'dead');
    expect(show.status).not.toBe(0);
  } finally {
    removeWorkspace(workspace);
  }
}, 60_000);

test('without --yes and without a terminal nothing is deleted and stdout is one JSON object', () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, {});
    addSession(workspace, 'a');
    const result = migent(workspace, 'session', 'delete', 'a', '--json');
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'confirmation-required', deleted: [] });
    expect(existsSync(sessionDir(workspace, 'a'))).toBe(true);
  } finally {
    removeWorkspace(workspace);
  }
}, 60_000);

test('deleted numbers are never reissued, and a prepared dependent of a deleted source fails', () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, { solo: SOLO });
    for (let n = 1; n <= 90; n += 1) addSession(workspace, String(n));
    const deleted = migent(workspace, 'session', 'delete', '89', '90', '--yes');
    expect(deleted.status, deleted.stderr).toBe(0);
    expect(deleted.stdout).toContain('Deleted 2 sessions');
    const prepared = migent(workspace, 'session', 'prepare', 'next one', '--workflow', 'solo');
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(existsSync(sessionDir(workspace, '91'))).toBe(true);
    expect(existsSync(sessionDir(workspace, '89'))).toBe(false);

    const dependent = migent(workspace, 'session', 'prepare', 'dep', '--workflow', 'solo', '--prior', '88');
    expect(dependent.status, dependent.stderr).toBe(0);
    const removal = migent(workspace, 'session', 'delete', '88', '--yes');
    expect(removal.status, removal.stderr).toBe(0);
    expect(removal.stderr).not.toMatch(/depend/iu);
    writeFileSync(path.join(sessionDir(workspace, '92'), 'task.md'), 'Do it.\n');
    const start = migent(workspace, 'session', 'run', '--session', '92');
    expect(start.status).not.toBe(0);
    expect(start.stderr).toMatch(/88/u);
  } finally {
    removeWorkspace(workspace);
  }
}, 60_000);
