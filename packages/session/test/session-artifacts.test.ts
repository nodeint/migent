import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { ARTIFACT_FILE_BYTES, ARTIFACT_TOTAL_BYTES, readSessionArtifacts } from '../src/session-artifacts.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TIME = '2026-10-20T00:00:10.000+00:00';

/** A session with executions e1..eN (order 1..N); `files[i]` maps a relative path to its bytes. */
function session(files: Record<string, string | Buffer>[]): { workspace: string; directory: string } {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-artifacts-'));
  dirs.push(workspace);
  const directory = path.join(workspace, '.migent', 'sessions', 's1');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'status.json'), JSON.stringify({ session_id: 's1', status: 'active' }));
  writeFileSync(
    path.join(directory, 'events.jsonl'),
    `${JSON.stringify({ v: 2, seq: 1, event: 'baseline.captured', timestamp: TIME, data: {} })}\n`,
  );
  files.forEach((entries, index) => {
    const id = `e${index + 1}`;
    const root = path.join(directory, 'executions', id);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'execution.json'), JSON.stringify({
      execution_id: id, execution_order: index + 1, stage_id: `st${index + 1}`, client: 'fake',
      status: 'completed', created_at: TIME, completed_at: TIME,
    }));
    for (const [relative, content] of Object.entries(entries)) {
      const file = path.join(root, 'artifacts', ...relative.split('/'));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  });
  return { workspace, directory };
}

test('files are listed recursively with relative paths, in execution order, and carry the basis seq', () => {
  const { workspace } = session([{ 'prd.md': 'one', 'notes/a.md': 'two' }, { 'plan.md': 'three' }]);
  const read = readSessionArtifacts(workspace, 's1');
  expect(read.basis_seq).toBe(1);
  const rows = read.entries.map((entry) => [
    entry.execution_id, entry.stage_id, entry.path, entry.content, entry.truncated, entry.skipped,
  ]);
  expect(rows)
    .toEqual([
      ['e1', 'st1', 'notes/a.md', 'two', false, null],
      ['e1', 'st1', 'prd.md', 'one', false, null],
      ['e2', 'st2', 'plan.md', 'three', false, null],
    ]);
});

test('a file over the per-file bound is cut at a UTF-8 boundary and marked truncated', () => {
  // Three-byte characters: the bound falls inside one.
  const { workspace } = session([{ 'big.md': '€'.repeat(Math.ceil(ARTIFACT_FILE_BYTES / 3) + 5) }]);
  const [entry] = readSessionArtifacts(workspace, 's1').entries;
  expect(entry?.truncated).toBe(true);
  expect(entry?.skipped).toBeNull();
  expect(Buffer.byteLength(entry?.content ?? '')).toBe(Math.floor(ARTIFACT_FILE_BYTES / 3) * 3);
  expect(entry?.content).not.toContain('�');
  expect(entry?.content).not.toContain('�');
  expect(entry?.content).not.toContain('�');
});

test('a file exactly at the bound is not truncated', () => {
  const { workspace } = session([{ 'edge.md': 'a'.repeat(ARTIFACT_FILE_BYTES) }]);
  const [entry] = readSessionArtifacts(workspace, 's1').entries;
  expect(entry?.truncated).toBe(false);
  expect(entry?.content).toHaveLength(ARTIFACT_FILE_BYTES);
});

test('the total budget goes to the newest executions first', () => {
  const chunk = 'x'.repeat(ARTIFACT_FILE_BYTES);
  const fits = ARTIFACT_TOTAL_BYTES / ARTIFACT_FILE_BYTES;
  const { workspace } = session(Array.from({ length: fits + 1 }, () => ({ 'a.md': chunk })));
  const { entries } = readSessionArtifacts(workspace, 's1');
  expect(entries).toHaveLength(fits + 1);
  expect(entries[0]).toMatchObject({ execution_id: 'e1', content: null, skipped: 'too_large_total', truncated: false });
  expect(entries.slice(1).every((entry) => entry.content === chunk)).toBe(true);
});

test('a NUL byte or invalid UTF-8 is binary', () => {
  const { workspace } = session([{
    'nul.bin': Buffer.from([0x61, 0x00, 0x62]),
    'bad.txt': Buffer.from([0xff, 0xfe, 0x41]),
    'ok.md': 'fine',
  }]);
  const byPath = Object.fromEntries(readSessionArtifacts(workspace, 's1').entries.map((entry) => [entry.path, entry]));
  expect(byPath['nul.bin']).toMatchObject({ content: null, skipped: 'binary' });
  expect(byPath['bad.txt']).toMatchObject({ content: null, skipped: 'binary' });
  expect(byPath['ok.md']).toMatchObject({ content: 'fine', skipped: null });
});

test('only executions/<id>/artifacts is read: plugins/, handoff/ and other files are excluded', () => {
  const { workspace, directory } = session([{ 'a.md': 'kept' }]);
  for (const outside of ['plugins/demo', 'handoff/1']) {
    mkdirSync(path.join(directory, outside), { recursive: true });
    writeFileSync(path.join(directory, outside, 'secret.md'), 'no');
  }
  writeFileSync(path.join(directory, 'executions', 'e1', 'response.md'), 'no');
  expect(readSessionArtifacts(workspace, 's1').entries.map((entry) => entry.path)).toEqual(['a.md']);
});

test('a missing artifacts directory gives no entries, and a corrupt session gives none', () => {
  const { workspace, directory } = session([{}]);
  expect(readSessionArtifacts(workspace, 's1').entries).toEqual([]);
  writeFileSync(path.join(directory, 'status.json'), '{ not json');
  expect(readSessionArtifacts(workspace, 's1').entries).toEqual([]);
});

test('an artifacts directory that is a link to another directory is not followed', () => {
  const { workspace, directory } = session([{}]);
  mkdirSync(path.join(directory, 'plugins', 'demo'), { recursive: true });
  writeFileSync(path.join(directory, 'plugins', 'demo', 'secret.md'), 'OUTSIDE ARTIFACT ROOT');
  symlinkSync(path.join(directory, 'plugins', 'demo'), path.join(directory, 'executions', 'e1', 'artifacts'), 'junction');
  expect(readSessionArtifacts(workspace, 's1').entries).toEqual([]);
});

test('an execution directory that is a link is not followed', () => {
  const { workspace, directory } = session([{}]);
  const outside = path.join(directory, 'plugins', 'demo');
  mkdirSync(path.join(outside, 'artifacts'), { recursive: true });
  writeFileSync(path.join(outside, 'artifacts', 'secret.md'), 'OUTSIDE VIA LINK');
  writeFileSync(path.join(outside, 'execution.json'), readFileSync(path.join(directory, 'executions', 'e1', 'execution.json')));
  rmSync(path.join(directory, 'executions', 'e1'), { recursive: true });
  symlinkSync(outside, path.join(directory, 'executions', 'e1'), 'junction');
  expect(readSessionArtifacts(workspace, 's1').entries).toEqual([]);
});

test('an execution id that traverses out of executions/ is not read', () => {
  const { workspace, directory } = session([{ 'a.md': 'inside' }]);
  mkdirSync(path.join(directory, 'plugins', 'demo', 'artifacts'), { recursive: true });
  writeFileSync(path.join(directory, 'plugins', 'demo', 'artifacts', 'secret.md'), 'OUTSIDE VIA EXECUTION ID');
  writeFileSync(path.join(directory, 'executions', 'e1', 'execution.json'), JSON.stringify({
    execution_id: '../plugins/demo', execution_order: 1, stage_id: 'st1', client: 'fake',
    status: 'completed', created_at: TIME, completed_at: TIME,
  }));
  expect(readSessionArtifacts(workspace, 's1').entries).toEqual([]);
});
