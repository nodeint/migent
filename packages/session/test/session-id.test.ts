import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ConfigurationError } from '@nodeint/migent-kernel';
import { parseYamlDocument } from '@nodeint/migent-workflow';
import { expect, test } from 'vitest';

import { readSessionManifest } from '../src/session-fold.ts';
import { createNumericSessionDirectory, MAX_SESSION_NUMBER } from '../src/session-id.ts';
import { createPreparedSession, createWorkflowSession } from '../src/session-records.ts';
import { tempDir, writeSessionConfig } from './support.ts';

function sessions(): string {
  return path.join(tempDir('migent-ids-'), 'sessions');
}

test('empty directory yields 1, then 2', () => {
  const dir = sessions();
  expect(createNumericSessionDirectory(dir)[0]).toBe('1');
  expect(createNumericSessionDirectory(dir)[0]).toBe('2');
});

test('only canonical numeric names count; gaps are not filled', () => {
  const dir = sessions();
  for (const name of ['3f2a-uuid-like', '2026--agent--x', 'session_ab', '007', '5x', '-4', '2']) mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, '9'), 'stray');
  expect(createNumericSessionDirectory(dir)[0]).toBe('10');
});

test('range ceiling', () => {
  const dir = sessions();
  mkdirSync(path.join(dir, '9007199254740990'), { recursive: true });
  expect(createNumericSessionDirectory(dir)[0]).toBe(String(MAX_SESSION_NUMBER));
  expect(() => createNumericSessionDirectory(dir)).toThrow(ConfigurationError);
});

test('names above the ceiling are ignored', () => {
  const dir = sessions();
  mkdirSync(path.join(dir, '9007199254740992'), { recursive: true });
  mkdirSync(path.join(dir, '9'.repeat(30)), { recursive: true });
  expect(createNumericSessionDirectory(dir)[0]).toBe('1');
});

test('manifests keep numeric ids as strings, including prior', () => {
  const workspace = tempDir('migent-ids-ws-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeSessionConfig(workspace);
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'solo.yaml'), 'schema_version: 5\nid: solo\nstages:\n  - id: work\n    role: developer\n');
  const first = createWorkflowSession(workspace, 'solo', 'task one');
  writeFileSync(path.join(workspace, '.migent', 'sessions', first, 'status.json'), JSON.stringify({ session_id: first, workflow_id: 'solo', status: 'completed' }));
  const second = createPreparedSession(workspace, 'task two', 'solo', first);
  expect([first, second]).toEqual(['1', '2']);
  const dir = path.join(workspace, '.migent', 'sessions', second);
  expect(readFileSync(path.join(dir, 'manifest.yaml'), 'utf8')).toContain('prior_session_id: "1"');
  const raw = parseYamlDocument(readFileSync(path.join(dir, 'manifest.yaml'), 'utf8')) as Record<string, unknown>;
  expect(raw.session_id).toBe('2');
  expect(raw.prior_session_id).toBe('1');
  const status = JSON.parse(readFileSync(path.join(dir, 'status.json'), 'utf8')) as { prior_session_id?: string };
  expect(status.prior_session_id).toBe('1');
});

test('reader accepts an unquoted integer identity', () => {
  const dir = path.join(sessions(), '4');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'manifest.yaml'), 'session_id: 4\nprior_session_id: 3\n');
  const manifest = readSessionManifest(dir);
  expect([manifest.sessionId, manifest.priorSessionId]).toEqual(['4', '3']);
});

test('concurrent processes get distinct contiguous ids', async () => {
  const dir = sessions();
  mkdirSync(dir, { recursive: true });
  const start = path.join(path.dirname(dir), 'go');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const children = Array.from({ length: 6 }, () => {
    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', '--import', pathToFileURL(path.join(here, 'ts-register.mjs')).href, path.join(here, 'session-id-worker.ts'), dir, start, '10'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return new Promise<string[]>((resolve, reject) => {
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
      child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out) as string[]) : reject(new Error(err))));
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  writeFileSync(start, '');
  const all = (await Promise.all(children)).flat().map(Number).sort((a, b) => a - b);
  expect(all).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
}, 60000);
