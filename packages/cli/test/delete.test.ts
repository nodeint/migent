import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DeleteResult } from '@nodeint/migent-contracts';
import { isValid } from '@nodeint/migent-contracts';
import { SessionLock, setDeleteHooks } from '@nodeint/migent-session';
import { afterEach, expect, test, vi } from 'vitest';

import { formatBytes } from '../src/commands/delete.ts';
import { cliHooks } from '../src/hooks.ts';
import { main } from '../src/index.ts';
import { capture, removeWorkspace, writeFakeWorkflowWorkspace } from './support.ts';

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) removeWorkspace(workspace);
  cliHooks.confirm = null;
  cliHooks.interactive = null;
  setDeleteHooks(null);
  vi.unstubAllEnvs();
});

const DAY = 86_400_000;

function setup(sessions: Record<string, { status: string; ageDays: number }>): string {
  const workspace = writeFakeWorkflowWorkspace({});
  workspaces.push(workspace);
  for (const [id, { status, ageDays }] of Object.entries(sessions)) {
    const directory = path.join(workspace, '.migent', 'sessions', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'status.json'), JSON.stringify({ status, updated_at: new Date(Date.now() - ageDays * DAY).toISOString() }));
  }
  return workspace;
}

const dir = (workspace: string, id: string) => path.join(workspace, '.migent', 'sessions', id);
const run = (workspace: string, ...argv: string[]) => capture(() => main(['session', 'delete', ...argv], workspace));

test.each([
  [['--json']],
  [['1', '--older-than', '1d', '--json']],
  [['--older-than', '30', '--json']],
  [['--older-than', '0d', '--json']],
  [['--status', 'corrupt', '--json']],
  [['--status', 'bogus', '--json']],
  [['../x', '--json']],
])('invalid input %j exits 2 with empty stdout', async (argv) => {
  const workspace = setup({ '1': { status: 'completed', ageDays: 40 } });
  const result = await run(workspace, ...argv);
  expect(result.value).toBe(2);
  expect(result.stdout).toBe('');
  expect(existsSync(dir(workspace, '1'))).toBe(true);
});

test('dry run, decline, and no terminal delete nothing', async () => {
  const workspace = setup({ '1': { status: 'completed', ageDays: 40 }, '2': { status: 'blocked', ageDays: 1 } });
  const dry = await run(workspace, '--older-than', '30d', '--dry-run', '--json');
  expect(dry.value).toBe(0);
  const dryJson = JSON.parse(dry.stdout);
  expect(isValid(DeleteResult, dryJson)).toBe(true);
  expect(dryJson).toMatchObject({ outcome: 'dry-run', deleted: [] });
  expect(dryJson.planned.map((p: { session_id: string }) => p.session_id)).toEqual(['1']);

  cliHooks.interactive = true;
  cliHooks.confirm = () => false;
  const declined = await run(workspace, '1', '--json');
  expect(declined.value).toBe(0);
  expect(JSON.parse(declined.stdout)).toMatchObject({ outcome: 'declined', deleted: [] });

  cliHooks.interactive = false;
  const none = await run(workspace, '1', '--json');
  expect(none.value).toBe(2);
  expect(none.stderr).toContain('Pass --yes to delete without confirmation.');
  expect(JSON.parse(none.stdout)).toMatchObject({ outcome: 'confirmation-required', deleted: [] });

  cliHooks.interactive = true;
  vi.stubEnv('MIGENT_NO_INPUT', '1');
  const noInput = await run(workspace, '1');
  expect(noInput.value).toBe(2);
  expect(existsSync(dir(workspace, '1'))).toBe(true);
});

test('a confirmed delete lists IDs, the summary line, and equals the dry run plan', async () => {
  const workspace = setup({ '1': { status: 'completed', ageDays: 40 }, '2': { status: 'cancelled', ageDays: 50 }, '3': { status: 'completed', ageDays: 1 } });
  const dry = JSON.parse((await run(workspace, '--older-than', '30d', '--status', 'completed', '--status', 'cancelled', '--dry-run', '--json')).stdout);
  cliHooks.interactive = true;
  cliHooks.confirm = () => true;
  const result = await run(workspace, '--older-than', '30d', '--status', 'completed', '--status', 'cancelled');
  expect(result.value).toBe(0);
  expect(result.stdout).toContain('Deleted 2');
  expect(result.stdout).toMatch(/Deleted 2 sessions, freed [\d.]+ (B|KB|MB)\.\n$/u);
  expect(dry.planned.map((p: { session_id: string }) => p.session_id).sort()).toEqual(['1', '2']);
  expect(existsSync(dir(workspace, '1'))).toBe(false);
  expect(existsSync(dir(workspace, '3'))).toBe(true);
});

test('named partial selection deletes the valid ones, exits 1, and hints cancel for running', async () => {
  const workspace = setup({ '1': { status: 'completed', ageDays: 1 }, '2': { status: 'active', ageDays: 1 } });
  const lock = SessionLock.acquire(dir(workspace, '2'));
  try {
    const result = await run(workspace, '1', '2', 'nope', '--yes', '--json');
    expect(result.value).toBe(1);
    expect(result.stderr).toContain('migent session cancel 2');
    const json = JSON.parse(result.stdout);
    expect(isValid(DeleteResult, json)).toBe(true);
    expect(json.deleted).toEqual(['1']);
    expect(json.refused).toEqual([{ session_id: '2', reason: 'running' }, { session_id: 'nope', reason: 'not-found' }]);
  } finally {
    lock.release();
  }
});

test('a failure lists only removed IDs and counts only their bytes', async () => {
  const workspace = setup({ '1': { status: 'completed', ageDays: 1 }, '2': { status: 'completed', ageDays: 1 } });
  setDeleteHooks({ renameFailure: (id) => { if (id === '1') throw new Error('boom'); } });
  const result = await run(workspace, '1', '2', '--yes', '--json');
  expect(result.value).toBe(1);
  const json = JSON.parse(result.stdout);
  expect(json.deleted).toEqual(['2']);
  expect(json.failed).toEqual([{ session_id: '1', error: 'boom' }]);
  const {bytes} = json.planned.find((p: { session_id: string }) => p.session_id === '2');
  expect(json.total_bytes).toBe(bytes);
});

test('an empty filter match exits 0', async () => {
  const workspace = setup({});
  const result = await run(workspace, '--status', 'completed', '--json');
  expect(result.value).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ planned: [], total_bytes: 0 });
});

test('formatBytes', () => {
  expect(formatBytes(512)).toBe('512 B');
  expect(formatBytes(2048)).toBe('2.0 KB');
  expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
});

test('dry run and a declined prompt exit 0 even with a refused named ID', async () => {
  const workspace = setup({ '1': { status: 'completed', ageDays: 1 } });
  const dry = await run(workspace, '1', 'nope', '--dry-run', '--json');
  expect(dry.value).toBe(0);
  expect(JSON.parse(dry.stdout).refused).toEqual([{ session_id: 'nope', reason: 'not-found' }]);
  cliHooks.interactive = true;
  cliHooks.confirm = () => false;
  const declined = await run(workspace, '1', 'nope', '--json');
  expect(declined.value).toBe(0);
  expect(JSON.parse(declined.stdout)).toMatchObject({ outcome: 'declined', deleted: [] });
  const real = await run(workspace, '1', 'nope', '--yes', '--json');
  expect(real.value).toBe(1);
});

test('a leftover from a failed removal is finished by rerunning the same filter, and the failure tells how', async () => {
  const workspace = setup({ '1': { status: 'completed', ageDays: 1 } });
  setDeleteHooks({ removeFailure: () => { throw new Error('rm boom'); } });
  const first = await run(workspace, '--status', 'completed', '--yes', '--json');
  expect(first.value).toBe(1);
  expect(first.stderr).toContain('already hidden');
  expect(first.stderr).toContain('reclaims');
  setDeleteHooks(null);
  const tombstones = path.join(workspace, '.migent', 'sessions', '.deleting');
  expect(readdirSync(tombstones)).toHaveLength(1);
  const second = await run(workspace, '--status', 'completed', '--yes', '--json');
  expect(second.value).toBe(0);
  expect(second.stderr).toContain('Cleared leftovers');
  expect(readdirSync(tombstones)).toEqual([]);
  const dry = await run(workspace, '--status', 'completed', '--dry-run');
  expect(dry.value).toBe(0);
});
