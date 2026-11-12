import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { ClientCommandFailed } from '../src/client.js';
import { cliHooks } from '../src/hooks.ts';
import { main } from '../src/index.ts';
import { capture } from './support.ts';

interface TestHooks {
  which: (command: string) => string | null;
  runCommand: (argv: string[], input?: string) => string;
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'migent-machine-'));
}

function helpFor(argv: readonly string[]): string | null {
  if (!argv.includes('--help')) return null;
  const client = argv[0] === 'claude' ? 'claude-code' : argv[0];
  return readFileSync(new URL(`../../adapters/src/options/${client}.txt`, import.meta.url), 'utf8');
}

const CODEX_CATALOG = JSON.stringify({
  models: [{ slug: 'gpt-5', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }],
});
const GROK_CATALOG = ['Available models:', '* grok-4 (default)', ''].join('\n');
const AGY_CATALOG = 'agi-pro\n';
const OPENCODE_CATALOG = 'dola-2.0\n';
const CLAUDE_CATALOG = JSON.stringify({
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'migent-models',
    response: { models: [{ value: 'opus', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'high'] }] },
  },
});

function catalogFor(command: string): string | null {
  switch (command) {
    case 'codex':
      return CODEX_CATALOG;
    case 'grok':
      return GROK_CATALOG;
    case 'agy':
      return AGY_CATALOG;
    case 'opencode':
      return OPENCODE_CATALOG;
    case 'claude':
      return CLAUDE_CATALOG;
    default:
      return null;
  }
}

/** A runner that answers help, catalogs, and grok's per-model effort probe. */
function fakeRunner(calls: string[][] = []): (argv: string[]) => string {
  return (argv) => {
    calls.push([...argv]);
    const help = helpFor(argv);
    if (help !== null) return help;
    if (argv[0] === 'grok' && argv.includes('--reasoning-effort')) {
      throw new ClientCommandFailed('grok: invalid effort; use one of: low, medium.');
    }
    const catalog = catalogFor(argv[0] ?? '');
    if (catalog === null) throw new ClientCommandFailed(`unexpected command: ${argv.join(' ')}`);
    return catalog;
  };
}

const allOnPath: TestHooks = {
  which: (command) => `/bin/${command}`,
  runCommand: fakeRunner(),
};

const nothingOnPath: TestHooks = {
  which: () => null,
  runCommand: () => {
    throw new Error('discovery must not run');
  },
};

async function run(
  workspace: string,
  hooks: TestHooks,
  argv: string[],
): Promise<{ stdout: string; stderr: string; value: unknown }> {
  cliHooks.which = hooks.which;
  cliHooks.runCommand = hooks.runCommand;
  return capture(() => main(['get', ...argv], workspace));
}

test('get providers reports the removal without running a command', async () => {
  const workspace = tempDir();
  try {
    for (const argv of [['providers', '-o', 'json'], ['provider', 'byteplus', '-o', 'json']]) {
      const captured = await run(workspace, nothingOnPath, argv);
      expect(captured.value, argv.join(' ')).toBe(2);
      expect(captured.stdout).toBe('');
      expect(captured.stderr).toContain('get providers has been removed; use `migent get clients`.');
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('get clients reports PATH facts only and never runs discovery', async () => {
  const workspace = tempDir();
  const hooks: TestHooks = {
    which: (command) => (command === 'claude' ? '/bin/claude' : null),
    runCommand: () => {
      throw new Error('discovery must not run');
    },
  };
  try {
    const captured = await run(workspace, hooks, ['clients', '-o', 'json']);
    expect(captured.value).toBe(0);
    const rows = JSON.parse(captured.stdout) as Record<string, unknown>[];
    expect(rows.map((row) => row.name)).toEqual(['agy', 'claude-code', 'codex', 'grok', 'opencode']);
    expect(rows.find((row) => row.name === 'claude-code')).toMatchObject({
      command: 'claude',
      available: true,
      path: '/bin/claude',
      effort_option: 'effort',
      problems: [],
    });
    expect(rows.find((row) => row.name === 'codex')).toMatchObject({
      available: false,
      path: null,
      problems: ['codex is not on PATH.'],
    });
    const table = await run(workspace, hooks, ['clients']);
    expect(table.stdout).toMatch(/^NAME\s+COMMAND\s+AVAILABLE\s+PATH\s+EFFORT_OPTION/);
    const one = await run(workspace, hooks, ['client', 'codex', '-o', 'json']);
    expect(JSON.parse(one.stdout)).toMatchObject({ kind: 'client', name: 'codex', available: false });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('get models lists one row per client model and warns once per skipped client', async () => {
  const workspace = tempDir();
  const calls: string[][] = [];
  const hooks: TestHooks = {
    which: (command) => (command === 'codex' ? '/bin/codex' : null),
    runCommand: fakeRunner(calls),
  };
  try {
    const captured = await run(workspace, hooks, ['models', '-o', 'json']);
    expect(captured.value).toBe(0);
    expect(JSON.parse(captured.stdout)).toEqual([{ kind: 'model', name: 'gpt-5', client: 'codex', default: false }]);
    expect(calls).toHaveLength(1);
    const warnings = captured.stderr.split('\n').filter((line) => line.startsWith('warning: '));
    expect(warnings).toHaveLength(4);
    expect(warnings).toContain('warning: claude-code: claude is not on PATH; skipped.');
    expect(warnings).toContain('warning: agy: agy is not on PATH; skipped.');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a failing catalog warns with the error and keeps stdout clean', async () => {
  const workspace = tempDir();
  const hooks: TestHooks = {
    which: (command) => `/bin/${command}`,
    runCommand: (argv) => {
      if (argv[0] === 'codex') throw new ClientCommandFailed('codex exploded');
      if (argv[0] === 'grok') return GROK_CATALOG;
      throw new ClientCommandFailed(`${argv[0]} unavailable`);
    },
  };
  try {
    const captured = await run(workspace, hooks, ['models', '-o', 'json']);
    expect(captured.value).toBe(0);
    expect((JSON.parse(captured.stdout) as Record<string, unknown>[]).map((row) => row.name)).toEqual(['grok-4']);
    expect(captured.stderr).toContain('warning: codex: codex exploded');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('get model implements the client-keyed lookup contract', async () => {
  const workspace = tempDir();
  const hooks: TestHooks = {
    which: (command) => (command === 'codex' || command === 'grok' ? `/bin/${command}` : null),
    runCommand: (argv) => {
      if (argv[0] === 'codex') {
        return JSON.stringify({ models: [{ slug: 'gpt-5', visibility: 'list' }, { slug: 'shared', visibility: 'list' }] });
      }
      return ['Available models:', '* grok-4', '* shared', ''].join('\n');
    },
  };
  try {
    const one = await run(workspace, hooks, ['model', 'gpt-5', '-o', 'json']);
    expect(one.value).toBe(0);
    expect(JSON.parse(one.stdout)).toMatchObject({ kind: 'model', name: 'gpt-5', client: 'codex' });

    const ambiguous = await run(workspace, hooks, ['model', 'shared']);
    expect(ambiguous.value).toBe(2);
    expect(ambiguous.stderr).toContain('matches more than one client: codex, grok');
    expect(ambiguous.stderr).toContain('--client');

    const scoped = await run(workspace, hooks, ['model', 'shared', '--client', 'grok', '-o', 'json']);
    expect(scoped.value).toBe(0);
    expect(JSON.parse(scoped.stdout)).toMatchObject({ name: 'shared', client: 'grok' });

    const missingScoped = await run(workspace, hooks, ['model', 'nope', '--client', 'codex']);
    expect(missingScoped.value).toBe(2);
    expect(missingScoped.stderr).toContain('Model not found: nope for client codex');

    const missing = await run(workspace, hooks, ['model', 'nope']);
    expect(missing.value).toBe(2);
    expect(missing.stderr).toContain('No model nope found');
    expect(missing.stderr).toContain('Searched: codex, grok');
    expect(missing.stderr).toContain('Skipped: agy');

    const skipped = await run(workspace, hooks, ['model', 'nope', '--client', 'claude-code']);
    expect(skipped.value).toBe(2);
    expect(skipped.stderr).toContain('client claude-code');
    expect(skipped.stderr).toContain('not on PATH');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('get options reports configured metadata without a subprocess and reports ambiguity', async () => {
  const workspace = tempDir();
  const calls: string[][] = [];
  const hooks: TestHooks = { which: (command) => `/bin/${command}`, runCommand: fakeRunner(calls) };
  try {
    const captured = await run(workspace, hooks, ['options', '-o', 'json']);
    expect(captured.value).toBe(0);
    const rows = JSON.parse(captured.stdout) as Record<string, unknown>[];
    expect(rows.find((row) => row.client === 'claude-code' && row.name === 'effort')).toMatchObject({
      kind: 'option',
      source: 'configured',
      prompt: true,
      allow_default: true,
      overridable: true,
    });
    expect(rows.every((row) => row.source === 'configured')).toBe(true);
    expect(calls).toEqual([]);

    const table = await run(workspace, hooks, ['options', '--client', 'claude-code']);
    expect(table.value).toBe(0);
    expect(table.stdout).toMatch(/^CLIENT\s+NAME\s+PROMPT\s+ALLOW_DEFAULT\s+OVERRIDABLE/);
    expect(table.stdout).toContain('effort');
    expect(table.stdout).toContain('true');

    const ambiguous = await run(workspace, hooks, ['option', 'effort']);
    expect(ambiguous.value).toBe(2);
    expect(ambiguous.stderr).toContain('claude-code');
    expect(ambiguous.stderr).toContain('agy');
    expect(ambiguous.stderr).toContain('--client');
    expect(calls).toEqual([]);

    const scoped = await run(workspace, hooks, ['option', 'effort', '--client', 'claude-code', '-o', 'json']);
    expect(scoped.value).toBe(0);
    expect(JSON.parse(scoped.stdout)).toMatchObject({ name: 'effort', client: 'claude-code', source: 'configured' });
    expect(calls).toEqual([]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('get options --native parses the CLI help and is the lookup source too', async () => {
  const workspace = tempDir();
  const calls: string[][] = [];
  const hooks: TestHooks = { which: (command) => `/bin/${command}`, runCommand: fakeRunner(calls) };
  try {
    const captured = await run(workspace, hooks, ['options', '--native', '--client', 'codex', '-o', 'json']);
    expect(captured.value).toBe(0);
    const rows = JSON.parse(captured.stdout) as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.source === 'native')).toBe(true);
    const model = rows.find((row) => row.name === 'model');
    expect(model).toMatchObject({ kind: 'option', client: 'codex', argument: '<MODEL>', value_mode: 'required' });
    expect(typeof model!.description).toBe('string');

    const one = await run(workspace, hooks, ['option', 'model', '--native', '--client', 'codex', '-o', 'json']);
    expect(one.value).toBe(0);
    expect(JSON.parse(one.stdout)).toMatchObject({ name: 'model', client: 'codex', source: 'native' });

    const table = await run(workspace, hooks, ['options', '--native', '--client', 'codex']);
    expect(table.value).toBe(0);
    expect(table.stdout).toMatch(/^CLIENT\s+NAME\s+ARGUMENT\s+VALUE_MODE\s+TYPE\s+CHOICES\s+DEFAULT/);

    const conflict = await run(workspace, hooks, ['models', '--native']);
    expect(conflict.value).toBe(2);
    expect(conflict.stderr).toContain('--native is only valid for options');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('get efforts reads catalog values and falls back to the per-model command', async () => {
  const workspace = tempDir();
  const calls: string[][] = [];
  const hooks: TestHooks = {
    which: (command) => (command === 'codex' || command === 'grok' ? `/bin/${command}` : null),
    runCommand: fakeRunner(calls),
  };
  try {
    const codex = await run(workspace, hooks, ['efforts', '--client', 'codex', '-o', 'json']);
    expect(codex.value).toBe(0);
    expect(JSON.parse(codex.stdout)).toEqual([
      { kind: 'effort', name: 'gpt-5', client: 'codex', model: 'gpt-5', option: 'model_reasoning_effort', values: ['low', 'high'] },
    ]);
    expect(calls.some((argv) => argv[0] === 'codex' && argv.includes('debug'))).toBe(true);

    const grok = await run(workspace, hooks, ['efforts', '--client', 'grok', '-o', 'json']);
    expect(grok.value).toBe(0);
    expect(JSON.parse(grok.stdout)).toEqual([
      { kind: 'effort', name: 'grok-4', client: 'grok', model: 'grok-4', option: 'reasoning-effort', values: ['low', 'medium'] },
    ]);
    expect(calls.some((argv) => argv[0] === 'grok' && argv.includes('--reasoning-effort'))).toBe(true);

    const one = await run(workspace, hooks, ['effort', 'grok-4', '--client', 'grok', '-o', 'json']);
    expect(one.value).toBe(0);
    expect(JSON.parse(one.stdout)).toMatchObject({ name: 'grok-4', client: 'grok', values: ['low', 'medium'] });

    const table = await run(workspace, hooks, ['efforts', '--client', 'codex']);
    expect(table.stdout).toMatch(/^CLIENT\s+MODEL\s+OPTION\s+VALUES/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("get effort only matches models in the client's catalog", async () => {
  const workspace = tempDir();
  const hooks: TestHooks = {
    which: (command) => (command === 'agy' || command === 'grok' ? `/bin/${command}` : null),
    runCommand: fakeRunner(),
  };
  try {
    const scoped = await run(workspace, hooks, ['effort', 'not-a-model', '--client', 'agy']);
    expect(scoped.value).toBe(2);
    expect(scoped.stderr).toContain('Effort not found: not-a-model for client agy');
    expect(scoped.stdout).toBe('');

    const unscoped = await run(workspace, hooks, ['effort', 'not-a-model']);
    expect(unscoped.value).toBe(2);
    expect(unscoped.stderr).toContain('No effort not-a-model found');
    expect(unscoped.stderr).toContain('Searched: agy, grok');
    expect(unscoped.stderr).not.toContain('matches more than one client');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('get effort keeps a listed model with no effort values', async () => {
  const workspace = tempDir();
  const hooks: TestHooks = {
    which: (command) => (command === 'codex' ? '/bin/codex' : null),
    runCommand: () =>
      JSON.stringify({
        models: [{ slug: 'gpt-5', visibility: 'list', supported_reasoning_levels: [] }],
      }),
  };
  try {
    const list = await run(workspace, hooks, ['efforts', '--client', 'codex', '-o', 'json']);
    expect(list.value).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([
      { kind: 'effort', name: 'gpt-5', client: 'codex', model: 'gpt-5', option: 'model_reasoning_effort', values: [] },
    ]);

    const one = await run(workspace, hooks, ['effort', 'gpt-5', '--client', 'codex', '-o', 'json']);
    expect(one.value).toBe(0);
    expect(JSON.parse(one.stdout)).toMatchObject({ name: 'gpt-5', client: 'codex', values: [] });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('get effort asks for --client when two clients report the same model', async () => {
  const workspace = tempDir();
  const hooks: TestHooks = {
    which: (command) => (command === 'codex' || command === 'grok' ? `/bin/${command}` : null),
    runCommand: (argv) => {
      if (argv[0] === 'codex') {
        return JSON.stringify({
          models: [{ slug: 'shared', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] }],
        });
      }
      if (argv[0] === 'grok' && argv.includes('--reasoning-effort')) {
        throw new ClientCommandFailed('grok: invalid effort; use one of: low, medium.');
      }
      return ['Available models:', '* shared', ''].join('\n');
    },
  };
  try {
    const ambiguous = await run(workspace, hooks, ['effort', 'shared']);
    expect(ambiguous.value).toBe(2);
    expect(ambiguous.stderr).toContain('matches more than one client: codex, grok');
    expect(ambiguous.stderr).toContain('--client');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('machine types reject flags they do not take and unknown client ids', async () => {
  const workspace = tempDir();
  try {
    const cases: [string[], string][] = [
      [['providers', '--client', 'codex'], 'get providers has been removed'],
      [['clients', '--client', 'codex'], '--client is not valid for clients'],
      [['models', '--client', 'nope'], 'Unknown client: nope. Valid clients:'],
      [['options', '--native', '--client', 'nope'], 'Unknown client: nope'],
      [['model', '--client', 'nope', 'x'], 'Unknown client: nope'],
      [['efforts', '--client', 'nope'], 'Unknown client: nope'],
    ];
    for (const [argv, text] of cases) {
      const captured = await run(workspace, allOnPath, argv);
      expect(captured.value, argv.join(' ')).toBe(2);
      expect(captured.stderr).toContain(text);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('machine types work outside a project while project types still need one', async () => {
  const workspace = tempDir();
  try {
    expect((await run(workspace, allOnPath, ['clients'])).value).toBe(0);
    expect((await run(workspace, allOnPath, ['providers'])).value).toBe(2);
    const project = await run(workspace, allOnPath, ['workflows']);
    expect(project.value).toBe(2);
    expect(project.stderr).toContain('.migent');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
