import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { listSealedMetrics, readSealedMetrics } from '../src/commands/metrics-read.ts';
import { removeTempDirs, tempDir } from './metrics-fixtures.ts';

afterEach(removeTempDirs);

const ALL = { workflow: null, status: null, limit: null };

function session(workspace: string, id: string, workflow: string, updatedAt: string): string {
  const directory = path.join(workspace, '.migent', 'sessions', id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'status.json'), JSON.stringify({ session_id: id, workflow_id: workflow, status: 'completed', updated_at: updatedAt }));
  return directory;
}

function pluginFile(directory: string, body: string): string {
  const file = path.join(directory, 'plugins', 'metrics', 'metrics.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

const doc = (marker: string): Record<string, unknown> => ({ session_id: 's', workflow_id: 'plan', status: 'completed', marker });

test('a root-only session is read through the fallback', () => {
  const workspace = tempDir('migent-read-root-');
  const directory = session(workspace, 's1', 'plan', '2026-10-20T00:00:01.000+00:00');
  writeFileSync(path.join(directory, 'metrics.json'), JSON.stringify(doc('root')));
  expect(readSealedMetrics(workspace, 's1')).toEqual({ state: 'ok', metrics: doc('root') });
});

test('a new-path session is read', () => {
  const workspace = tempDir('migent-read-new-');
  const directory = session(workspace, 's1', 'plan', '2026-10-20T00:00:01.000+00:00');
  pluginFile(directory, JSON.stringify(doc('plugin')));
  expect(readSealedMetrics(workspace, 's1')).toEqual({ state: 'ok', metrics: doc('plugin') });
});

test('the new file wins when both files exist', () => {
  const workspace = tempDir('migent-read-both-');
  const directory = session(workspace, 's1', 'plan', '2026-10-20T00:00:01.000+00:00');
  pluginFile(directory, JSON.stringify(doc('plugin')));
  writeFileSync(path.join(directory, 'metrics.json'), JSON.stringify(doc('root')));
  expect(readSealedMetrics(workspace, 's1')).toEqual({ state: 'ok', metrics: doc('plugin') });
  expect(listSealedMetrics(workspace, ALL)).toEqual([doc('plugin')]);
});

test('a missing file is reported as missing and omitted from the list', () => {
  const workspace = tempDir('migent-read-missing-');
  session(workspace, 's1', 'plan', '2026-10-20T00:00:01.000+00:00');
  expect(readSealedMetrics(workspace, 's1')).toEqual({ state: 'missing' });
  expect(listSealedMetrics(workspace, ALL)).toEqual([]);
});

test('a corrupt file on either path is reported and left in place', () => {
  const workspace = tempDir('migent-read-corrupt-');
  const rootDirectory = session(workspace, 'root', 'plan', '2026-10-20T00:00:01.000+00:00');
  const rootFile = path.join(rootDirectory, 'metrics.json');
  writeFileSync(rootFile, 'not-json');
  const pluginDirectory = session(workspace, 'plug', 'plan', '2026-10-20T00:00:02.000+00:00');
  const pluginPath = pluginFile(pluginDirectory, '[]');
  expect(readSealedMetrics(workspace, 'root')).toEqual({ state: 'corrupt' });
  expect(readSealedMetrics(workspace, 'plug')).toEqual({ state: 'corrupt' });
  expect(readFileSync(rootFile, 'utf8')).toBe('not-json');
  expect(readFileSync(pluginPath, 'utf8')).toBe('[]');
  expect(listSealedMetrics(workspace, ALL)).toEqual([]);
});

test('a corrupt new file does not fall back to a valid root file', () => {
  const workspace = tempDir('migent-read-nofallback-');
  const directory = session(workspace, 's1', 'plan', '2026-10-20T00:00:01.000+00:00');
  pluginFile(directory, 'not-json');
  writeFileSync(path.join(directory, 'metrics.json'), JSON.stringify(doc('root')));
  expect(readSealedMetrics(workspace, 's1')).toEqual({ state: 'corrupt' });
});

test('list filters by workflow, status and limit, newest first', () => {
  const workspace = tempDir('migent-read-filter-');
  const a = session(workspace, 'a', 'plan', '2026-10-20T00:00:01.000+00:00');
  const b = session(workspace, 'b', 'other', '2026-10-20T00:00:02.000+00:00');
  const c = session(workspace, 'c', 'plan', '2026-10-20T00:00:03.000+00:00');
  writeFileSync(path.join(a, 'metrics.json'), JSON.stringify({ workflow_id: 'plan', status: 'completed', n: 'a' }));
  pluginFile(b, JSON.stringify({ workflow_id: 'other', status: 'completed', n: 'b' }));
  pluginFile(c, JSON.stringify({ workflow_id: 'plan', status: 'completed', n: 'c' }));
  const names = (rows: Record<string, unknown>[]): unknown[] => rows.map((row) => row.n);
  expect(names(listSealedMetrics(workspace, ALL))).toEqual(['c', 'b', 'a']);
  expect(names(listSealedMetrics(workspace, { ...ALL, workflow: 'plan' }))).toEqual(['c', 'a']);
  expect(names(listSealedMetrics(workspace, { ...ALL, limit: 1 }))).toEqual(['c']);
  expect(names(listSealedMetrics(workspace, { ...ALL, status: 'failed' }))).toEqual([]);
});
