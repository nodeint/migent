import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ConfigurationError } from '@nodeint/migent-kernel';
import { expect, test, vi } from 'vitest';

import { readStatusFileState } from '../src/query.js';
import { freezeSessionTask } from '../src/task-file.js';

function temp(): string {
  return mkdtempSync(path.join(tmpdir(), 'migent-atomic-'));
}

test('readStatusFileState tells missing from corrupt', () => {
  const dir = temp();
  try {
    const file = path.join(dir, 'status.json');
    expect(readStatusFileState(file).state).toBe('missing');
    writeFileSync(file, '{');
    expect(readStatusFileState(file).state).toBe('corrupt');
    writeFileSync(file, '[]');
    expect(readStatusFileState(file).state).toBe('corrupt');
    writeFileSync(file, '{"status":"active"}');
    expect(readStatusFileState(file).state).toBe('ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('freezeSessionTask does not overwrite a corrupt status.json', () => {
  const workspace = temp();
  try {
    const session = path.join(workspace, '.migent', 'sessions', 's1');
    fs.mkdirSync(session, { recursive: true });
    writeFileSync(path.join(session, 'status.json'), '{"task_sha');
    writeFileSync(path.join(session, 'task.md'), 'do it\n');
    expect(() => freezeSessionTask(workspace, 's1')).toThrow(ConfigurationError);
    expect(readFileSync(path.join(session, 'status.json'), 'utf8')).toBe('{"task_sha');
  } finally {
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
  }
});
