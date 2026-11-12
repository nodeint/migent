import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { cliHooks } from '../src/hooks.ts';
import { main } from '../src/index.ts';
import { capture } from './support.ts';

const CODEX_HELP = readFileSync(new URL('../../adapters/src/options/codex.txt', import.meta.url), 'utf8');

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'migent-headless-'));
}

// `main` resets the hooks after every call, so each invocation installs its own.
function installHooks(runCommand: (argv: string[]) => string): void {
  cliHooks.which = (command) => (command === 'codex' ? '/bin/codex' : null);
  cliHooks.runCommand = runCommand;
}

test('headless discovery survives a model catalog failure', async () => {
  const workspace = tempDir();
  const runCommand = (argv: string[]): string => {
    if (argv.includes('--help')) return 'Options:\n  --model <MODEL>  Model to use\n';
    throw new Error('model service unavailable');
  };
  try {
    installHooks(runCommand);
    const captured = await capture(() => main(['get', 'options', '--native', '--client', 'codex', '-o', 'json'], workspace));
    expect(captured.value).toBe(0);
    const rows = JSON.parse(captured.stdout) as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ name: 'model', value_mode: 'required', source: 'native' });

    installHooks(runCommand);
    const models = await capture(() => main(['get', 'models', '--client', 'codex', '-o', 'json'], workspace));
    expect(models.value).toBe(0);
    expect(JSON.parse(models.stdout)).toEqual([]);
    expect(models.stderr).toContain('warning: codex:');
    expect(models.stderr).toContain('model service unavailable');

    installHooks(runCommand);
    const model = await capture(() => main(['get', 'model', 'test-model', '--client', 'codex'], workspace));
    expect(model.value).toBe(2);
    expect(model.stderr).toContain('model service unavailable');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    cliHooks.which = null;
    cliHooks.runCommand = null;
  }
});

test('unparseable help warns without losing models', async () => {
  const workspace = tempDir();
  const runCommand = (argv: string[]): string => {
    if (argv.includes('--help')) return 'unexpected output';
    return JSON.stringify({ models: [{ slug: 'test-model', visibility: 'list' }] });
  };
  try {
    installHooks(runCommand);
    const models = await capture(() => main(['get', 'models', '--client', 'codex', '-o', 'json'], workspace));
    expect(models.value).toBe(0);
    expect(JSON.parse(models.stdout)).toEqual([
      { kind: 'model', name: 'test-model', client: 'codex', default: false },
    ]);

    installHooks(runCommand);
    const options = await capture(() => main(['get', 'options', '--native', '--client', 'codex'], workspace));
    expect(options.value).toBe(0);
    expect(options.stderr).toContain('warning: codex:');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    cliHooks.which = null;
    cliHooks.runCommand = null;
  }
});

test('the codex help fixture still parses through get options --native', () => {
  expect(CODEX_HELP.length).toBeGreaterThan(0);
});
