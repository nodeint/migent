import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { main } from '../src/index.ts';
import { capture } from './support.ts';

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'migent-provider-removed-'));
}

test('provider list exits 2 and names the replacement commands', async () => {
  const workspace = tempDir();
  try {
    for (const argv of [['provider', 'list'], ['provider', 'list', '--json']]) {
      const captured = await capture(() => main(argv, workspace));
      expect(captured.value, argv.join(' ')).toBe(2);
      expect(captured.stdout).toBe('');
      expect(captured.stderr).toContain('provider list has been removed');
      for (const replacement of ['get clients', 'get models', 'get options', 'get efforts']) {
        expect(captured.stderr).toContain(replacement);
      }
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('get providers exits 2 and points at get clients', async () => {
  const workspace = tempDir();
  try {
    for (const argv of [['get', 'providers'], ['get', 'provider']]) {
      const captured = await capture(() => main(argv, workspace));
      expect(captured.value, argv.join(' ')).toBe(2);
      expect(captured.stderr).toContain('get providers has been removed; use `migent get clients`.');
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('provider no longer appears in help', async () => {
  const workspace = tempDir();
  try {
    const captured = await capture(() => main(['--help'], workspace));
    expect(captured.value).toBe(0);
    expect(captured.stdout).not.toMatch(/\n {2}provider\b/);
    expect(captured.stdout).not.toContain('provider list');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
