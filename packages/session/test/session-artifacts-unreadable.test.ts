import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

// A fault at the filesystem boundary: opening one listed file fails, as a permission or sharing error would.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: ((file: string, ...rest: unknown[]) => {
      if (String(file).endsWith('locked.md')) throw new Error('EACCES: permission denied');
      return (actual.openSync as (...args: unknown[]) => number)(file, ...rest);
    }) as typeof actual.openSync,
  };
});

const { readSessionArtifacts } = await import('../src/session-artifacts.ts');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('a file that cannot be read is unreadable, and the readable artifacts are still delivered', () => {
  const time = '2026-10-20T00:00:10.000+00:00';
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-unreadable-'));
  dirs.push(workspace);
  const directory = path.join(workspace, '.migent', 'sessions', 's1');
  const root = path.join(directory, 'executions', 'e1');
  mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  writeFileSync(path.join(directory, 'status.json'), JSON.stringify({ session_id: 's1', status: 'active' }));
  writeFileSync(path.join(directory, 'events.jsonl'), '');
  writeFileSync(path.join(root, 'execution.json'), JSON.stringify({
    execution_id: 'e1', execution_order: 1, stage_id: 'st1', client: 'fake', status: 'completed', created_at: time, completed_at: time,
  }));
  writeFileSync(path.join(root, 'artifacts', 'locked.md'), 'secret');
  writeFileSync(path.join(root, 'artifacts', 'ok.md'), 'fine');
  const { entries } = readSessionArtifacts(workspace, 's1');
  expect(entries.map((entry) => [entry.path, entry.content, entry.skipped])).toEqual([
    ['locked.md', null, 'unreadable'],
    ['ok.md', 'fine', null],
  ]);
});
