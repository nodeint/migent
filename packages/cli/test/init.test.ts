import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { diagnose } from '@nodeint/migent-doctor';
import { loadWorkspaceConfig, resolveStageTarget } from '@nodeint/migent-kernel';
import { loadWorkflowDocument } from '@nodeint/migent-workflow';
import { afterEach, expect, test } from 'vitest';

import { clientRegistry } from '../src/client.ts';
import { type ModelSelection,type Prompter, runInit } from '../src/commands/init.ts';
import { cliHooks } from '../src/hooks.ts';
import { main } from '../src/index.ts';
import { capture } from './support.ts';

function skillRecorder(code = 0): { calls: { argv: string[]; cwd: string }[] } {
  const calls: { argv: string[]; cwd: string }[] = [];
  cliHooks.skillRunner = (argv, cwd) => {
    calls.push({ argv, cwd });
    return code;
  };
  return { calls };
}

afterEach(() => {
  cliHooks.skillRunner = null;
  cliHooks.which = null;
  cliHooks.runCommand = null;
});

function runCommand(argv: string[]): string {
  if (argv[0] === 'codex' && argv[1] === 'debug') {
    return JSON.stringify({
      models: [
        {
          slug: 'gpt-5',
          visibility: 'list',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }],
        },
        { slug: 'hidden', visibility: 'hide' },
      ],
    });
  }
  if (argv[0] === 'grok' && argv[1] === 'models') {
    return 'Default model: grok-4.7\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n';
  }
  if (argv[0] === 'grok' && argv.includes('--reasoning-effort')) return 'use one of: xhigh, high, medium, low';
  throw new Error(JSON.stringify(argv));
}

class ScriptedPrompt implements Prompter {
  private readonly answers: string[];
  private index = 0;

  constructor(answers: readonly string[]) {
    this.answers = [...answers];
  }

  selectModel(models: readonly ModelSelection[]): ModelSelection {
    const client = this.answers[this.index++] ?? '';
    const model = this.answers[this.index++] ?? '';
    const selected = models.find((item) => (!client || item.client === client) && (!model || item.model === model));
    if (!selected) throw new Error(`Unknown model: ${client}/${model}.`);
    return selected;
  }

  selectOption(_name: string, values: readonly string[]): string {
    const raw = this.answers[this.index++] ?? '';
    if (raw === '') return '';
    if (!values.includes(raw)) throw new Error(`Unknown option value: ${raw}.`);
    return raw;
  }
}

function which(found: ReadonlySet<string>): (command: string) => string | null {
  return (command) => (found.has(command) ? `/bin/${command}` : null);
}

const ALL_CODEX = ['planning=codex:gpt-5', 'review=codex:gpt-5', 'coding=codex:gpt-5'];

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'migent-cli-'));
}

test('writes inline role models and both working presets', async () => {
  const workspace = tempDir();
  try {
    const captured = await capture(() =>
      runInit(workspace, {
        agents: ALL_CODEX,
        runCommand,
        which: which(new Set(['codex', 'grok'])),
      }),
    );
    const config = readFileSync(path.join(workspace, '.migent', 'config.yaml'), 'utf8');
    const workflow = readFileSync(path.join(workspace, '.migent', 'workflows', 'implement.yaml'), 'utf8');
    const gitignore = readFileSync(path.join(workspace, '.migent', '.gitignore'), 'utf8');
    expect(captured.value).toBe(0);
    expect(captured.stdout).toContain('Roles:');
    expect(captured.stdout).toMatch(/architect\s+Designs the structure and plan/);
    expect(captured.stdout).toContain('planning (architect): codex/gpt-5. review (reviewer): codex/gpt-5. coding (developer, operator): codex/gpt-5. Workflows: implement, plan.');
    expect(config).toContain('schema_version: 7');
    expect(config).toContain('agent');
    expect(workflow).toContain('schema_version: 7');
    expect(loadWorkspaceConfig(workspace)).toMatchObject({
      schema_version: 7,
      roles: {
        developer: { agent: 'coding' },
        architect: { agent: 'planning' },
        reviewer: { agent: 'review' },
        operator: { agent: 'coding' },
      },
      agents: {
        planning: { model: 'gpt-5', client: { type: 'codex' } },
        review: { model: 'gpt-5', client: { type: 'codex' } },
        coding: { model: 'gpt-5', client: { type: 'codex' } },
      },
    });
    type RoleShape = { responsibilities: string[]; description: string };
    const roles = loadWorkspaceConfig(workspace).roles as Record<string, RoleShape>;
    expect(Object.keys(roles).sort()).toEqual(['architect', 'developer', 'operator', 'reviewer']);
    for (const role of Object.values(roles)) {
      expect(role.responsibilities.length).toBeGreaterThan(0);
      expect(role.description).toMatch(/\S/);
    }
    expect(roles.architect?.responsibilities.join('\n')).toContain('do not modify project files');
    expect(roles.reviewer?.responsibilities.join('\n')).toContain('Do not modify project files');
    const localConfig = readFileSync(path.join(workspace, '.migent', 'config.local.yaml'), 'utf8');
    expect(localConfig).not.toContain('{{');
    expect(localConfig).toContain('roles: {}');
    expect(workflow).toContain('id: implement');
    expect(workflow).toContain('role: developer');
    expect(gitignore).toBe('sessions/\nconfig.local.yaml\n');
    const clients = clientRegistry();
    expect(diagnose(workspace, { clients, which: which(new Set(['codex'])) }).every((check) => check.ok)).toBe(true);
    for (const [flow, stage] of [['implement', 'implement'], ['implement', 'review_work'], ['plan', 'plan'], ['plan', 'review_plan']] as const) {
      expect(resolveStageTarget(workspace, { workflowId: flow, stageId: stage }, { registry: clients })).toEqual({
        client: 'codex', model: 'gpt-5', options: {},
      });
    }
    expect(captured.stdout).toContain('.migent/workflows/plan.yaml');
    expect(captured.stdout).toContain('.migent/workflows/implement.yaml');
    expect(captured.stdout).toContain('migent session run --workflow implement --task "<what you want done>"');
    expect(captured.stdout).not.toContain('providers');
    expect(captured.stderr).not.toContain('Doctor reported problems:');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('refuses a partial project and leaves it unchanged', async () => {
  const workspace = tempDir();
  try {
    const root = path.join(workspace, '.migent');
    mkdirSync(root);
    const config = path.join(root, 'config.yaml');
    writeFileSync(config, 'partial: true\n', 'utf8');
    const captured = await capture(() =>
      runInit(workspace, {
        agents: ALL_CODEX,
        runCommand,
        which: which(new Set(['codex'])),
      }),
    );
    expect(captured.value).toBe(1);
    expect(readFileSync(config, 'utf8')).toBe('partial: true\n');
    expect(existsSync(path.join(root, 'workflows'))).toBe(false);
    expect(captured.stderr).toContain('.migent/config.yaml');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('reports an existing valid project without changing it', async () => {
  const workspace = tempDir();
  try {
    expect(
      await runInit(workspace, {
        agents: ALL_CODEX,
        runCommand,
        which: which(new Set(['codex'])),
      }),
    ).toBe(0);
    const config = path.join(workspace, '.migent', 'config.yaml');
    const original = readFileSync(config, 'utf8');
    const captured = await capture(() =>
      runInit(workspace, {
        agents: ['planning=codex:gpt-5', 'review=codex:gpt-5', 'coding=grok:grok-4'],
        runCommand,
        which: which(new Set()),
      }),
    );
    expect(captured.value).toBe(0);
    expect(readFileSync(config, 'utf8')).toBe(original);
    expect(captured.stdout).toContain('Already initialized.');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a lone config.local.yaml is a conflict and is left unchanged', async () => {
  const workspace = tempDir();
  try {
    const root = path.join(workspace, '.migent');
    mkdirSync(root);
    const local = path.join(root, 'config.local.yaml');
    writeFileSync(local, 'agents: {}\n', 'utf8');
    const captured = await capture(() =>
      runInit(workspace, { agents: ALL_CODEX, runCommand, which: which(new Set(['codex'])) }),
    );
    expect(captured.value).toBe(1);
    expect(readFileSync(local, 'utf8')).toBe('agents: {}\n');
    expect(existsSync(path.join(root, 'config.yaml'))).toBe(false);
    expect(captured.stderr).toContain('.migent/config.local.yaml');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('architect has its own model and each workflow uses the reviewer model', async () => {
  const workspace = tempDir();
  try {
    const code = await runInit(workspace, {
      agents: ['planning=grok:grok-4.6', 'review=grok:grok-4.7', 'coding=codex:gpt-5'],
      runCommand,
      which: which(new Set(['codex', 'grok'])),
    });
    const config = readFileSync(path.join(workspace, '.migent', 'config.yaml'), 'utf8');
    const workflow = readFileSync(path.join(workspace, '.migent', 'workflows', 'plan.yaml'), 'utf8');
    expect(code).toBe(0);
    const resolve = clientRegistry();
    expect(resolveStageTarget(workspace, { workflowId: 'plan', stageId: 'plan' }, { registry: resolve })).toMatchObject({ client: 'grok', model: 'grok-4.6' });
    expect(resolveStageTarget(workspace, { workflowId: 'plan', stageId: 'review_plan' }, { registry: resolve })).toMatchObject({ client: 'grok', model: 'grok-4.7' });
    expect(config).toContain('agents:');
    expect(config).toContain('architect:');
    expect(workflow).toContain('role: architect');
    expect(resolveStageTarget(workspace, { workflowId: 'implement', stageId: 'review_work' }, { registry: resolve })).toMatchObject({ client: 'grok', model: 'grok-4.7' });
    expect(workflow).toContain('id: plan');
    expect(loadWorkflowDocument(path.join(workspace, '.migent', 'workflows', 'plan.yaml')).stages.review_plan?.routes.revise).toBe('plan');
    expect(workflow).toBe(readFileSync(new URL('../../../templates/workflows/plan.yaml', import.meta.url), 'utf8'));
    expect(workflow).not.toContain('reasoning-effort');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('interactive prefers an installed client', async () => {
  const workspace = tempDir();
  try {
    const captured = await capture(() =>
      runInit(workspace, {
        interactive: true,
        runCommand,
        which: which(new Set(['grok'])),
        prompter: new ScriptedPrompt(['', '', '', '', '', '', '', '', '']),
      }),
    );
    const config = readFileSync(path.join(workspace, '.migent', 'config.yaml'), 'utf8');
    expect(captured.value).toBe(0);
    expect(captured.stdout).toContain('clients');
    expect(captured.stdout).toContain('ok');
    expect(config).toContain('type: grok');
    expect(config).toContain('model: grok-4.7');
    expect(config).not.toContain('codex');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('writes an option only when it is passed', async () => {
  const workspace = tempDir();
  try {
    const code = await runInit(workspace, {
      agents: ALL_CODEX,
      agentOptions: ['coding:model_reasoning_effort=high'],
      runCommand,
      which: which(new Set(['codex'])),
    });
    const config = readFileSync(path.join(workspace, '.migent', 'config.yaml'), 'utf8');
    expect(code).toBe(0);
    expect(config).toContain('model_reasoning_effort: high');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('rejects a model the client cli did not list', async () => {
  const workspace = tempDir();
  try {
    const captured = await capture(() =>
      runInit(workspace, {
        agents: ['planning=codex:gpt-5', 'review=codex:gpt-5', 'coding=codex:hidden'],
        runCommand,
        which: which(new Set(['codex'])),
      }),
    );
    expect(captured.value).toBe(2);
    expect(existsSync(path.join(workspace, '.migent'))).toBe(false);
    expect(captured.stderr).toContain('Unknown model: hidden');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('rejects an option value the client does not list', async () => {
  const workspace = tempDir();
  try {
    const captured = await capture(() =>
      runInit(workspace, {
        agents: ALL_CODEX,
        agentOptions: ['coding:model_reasoning_effort=max'],
        runCommand,
        which: which(new Set(['codex'])),
      }),
    );
    expect(captured.value).toBe(2);
    expect(existsSync(path.join(workspace, '.migent'))).toBe(false);
    expect(captured.stderr).toContain('model_reasoning_effort must be one of');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('init succeeds without npx and suggests a separate skill command', async () => {
  const workspace = tempDir();
  const { calls } = skillRecorder(1);
  try {
    const result = await capture(() => runInit(workspace, {
      agents: ALL_CODEX,
      runCommand, which: which(new Set(['codex'])),
    }));
    expect(result.value).toBe(0);
    expect(calls).toEqual([]);
    expect(existsSync(path.join(workspace, '.migent/config.yaml'))).toBe(true);
    expect(result.stdout).toContain('migent skill install --project');
    expect(result.stdout).toContain('migent session run --workflow implement');
    expect(result.stdout.indexOf('migent skill install --project'))
      .toBeLessThan(result.stdout.indexOf('migent session run'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test.each(['missing npx', 'installer failure'])('skill %s after init preserves the project and can be retried', async (failure) => {
  const workspace = tempDir();
  const { calls } = skillRecorder(1);
  try {
    const initialized = await capture(() => runInit(workspace, {
      agents: ['planning=codex:gpt-5', 'review=grok:grok-4.7', 'coding=codex:gpt-5'],
      agentOptions: ['coding:model_reasoning_effort=low', 'review:reasoning-effort=high'],
      runCommand, which: which(new Set(['codex', 'grok'])),
    }));
    expect(initialized.value, initialized.stderr).toBe(0);
    expect(calls).toEqual([]);
    const files = ['.migent/config.yaml', '.migent/workflows/implement.yaml', '.migent/workflows/plan.yaml', '.migent/.gitignore'];
    const snapshot = () => files.map(file => readFileSync(path.join(workspace, file), 'utf8'));
    const original = snapshot();
    cliHooks.which = which(new Set(failure === 'missing npx' ? [] : ['npx']));
    const failed = await capture(() => main(['skill', 'install', '--project', '-y'], workspace));
    expect(failed.value).toBe(1);
    expect(failed.stderr).toContain(failure === 'missing npx' ? 'not found on PATH' : 'npx skills exited with code 1');
    expect(snapshot()).toEqual(original);
    expect(calls).toHaveLength(failure === 'missing npx' ? 0 : 1);

    const retry = skillRecorder();
    cliHooks.which = which(new Set(['npx']));
    const installed = await capture(() => main(['skill', 'install', '--project', '-y'], workspace));
    expect(installed.value).toBe(0);
    expect(retry.calls).toHaveLength(1);
    expect(retry.calls[0]?.argv).toEqual(expect.arrayContaining(['-a', 'codex', 'grok']));
    expect(retry.calls[0]?.cwd).toBe(workspace);
    expect(snapshot()).toEqual(original);

    const existing = await capture(() => runInit(workspace, { runCommand, which: which(new Set()) }));
    expect(existing.value).toBe(0);
    expect(existing.stdout).toContain('Already initialized.');
    expect(existing.stdout).toContain('migent skill install --project');
    expect(retry.calls).toHaveLength(1);
    expect(snapshot()).toEqual(original);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('init --skill reports the replacement before prompting or writing files and is hidden from help', async () => {
  const workspace = tempDir();
  const { calls } = skillRecorder();
  try {
    const result = await capture(() => main(['init', '--skill'], workspace));
    expect(result.value).toBe(2);
    expect(result.stderr).toContain('init --skill has been removed');
    expect(result.stderr).toContain('migent init');
    expect(result.stderr).toContain('migent skill install --project');
    expect(existsSync(path.join(workspace, '.migent'))).toBe(false);
    expect(calls).toEqual([]);
    const help = await capture(() => main(['init', '--help'], workspace));
    expect(help.value).toBe(0);
    expect(help.stdout).not.toContain('--skill');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('init exits 0 when doctor later reports a missing client', async () => {
  const workspace = tempDir();
  try {
    let seen = 0;
    const captured = await capture(() =>
      runInit(workspace, {
        agents: ALL_CODEX,
        runCommand,
        which: (command) => {
          seen += 1;
          return command === 'codex' && seen <= 1 ? '/bin/codex' : null;
        },
      }),
    );
    expect(captured.value).toBe(0);
    expect(existsSync(path.join(workspace, '.migent', 'config.yaml'))).toBe(true);
    expect(captured.stdout).toContain('migent session run --workflow implement --task "<what you want done>"');
    expect(captured.stdout).not.toContain('failed');
    expect(captured.stderr).toContain('Doctor reported problems:');
    expect(captured.stderr).toContain('not on PATH');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('already initialized ignores model selection flags', async () => {
  const workspace = tempDir();
  try {
    expect(
      await runInit(workspace, {
        agents: ALL_CODEX,
        runCommand,
        which: which(new Set(['codex'])),
      }),
    ).toBe(0);
    const captured = await capture(() =>
      runInit(workspace, {
        agents: ['planning=codex:gpt-5', 'review=codex:gpt-5', 'coding=grok:grok-4'],
        agentOptions: ['coding:reasoning=high'],
        runCommand,
        which: which(new Set()),
      }),
    );
    expect(captured.value).toBe(0);
    expect(captured.stderr).toContain('Already initialized; ignoring model selection flags.');
    expect(captured.stdout).toContain('Already initialized.');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test.each([
  { agentEfforts: ['coding=high'] },
  { agentOptions: ['coding:model_reasoning_effort=high'] },
  { agents: ['oldslot=codex:gpt-5'] },
  { agents: ['coding=codex:gpt-5', 'coding=codex:gpt-5'] },
  { agents: ['malformed'] },
])('already initialized ignores invalid selection flags: %j', async (flags) => {
  const workspace = tempDir();
  try {
    const created = await capture(() => runInit(workspace, {
      agents: ALL_CODEX, runCommand, which: which(new Set(['codex'])),
    }));
    expect(created.value, created.stderr).toBe(0);
    const configPath = path.join(workspace, '.migent', 'config.yaml');
    const before = readFileSync(configPath, 'utf8');
    const calls: string[][] = [];
    const result = await capture(() => runInit(workspace, {
      ...flags,
      interactive: true,
      which: which(new Set()),
      runCommand: (argv) => { calls.push(argv); throw new Error('Unexpected client command'); },
      prompter: new ScriptedPrompt([]),
    }));
    expect(result.value, result.stderr).toBe(0);
    expect(result.stdout).toContain('Already initialized.');
    expect(result.stderr).toContain('Already initialized; ignoring model selection flags.');
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(calls).toEqual([]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('requires every agent when not interactive', async () => {
  const workspace = tempDir();
  const message = 'Pass --agent NAME=CLIENT:MODEL for planning (architect), review (reviewer), coding (developer, operator)';
  try {
    const first = await capture(() => main(['init'], workspace));
    expect(first.value).toBe(2);
    expect(existsSync(path.join(workspace, '.migent'))).toBe(false);
    expect(first.stderr).toContain(message + ' when init is not interactive.');
    expect(first.stderr).toContain('Example: migent init --agent planning=codex:gpt-5');
    const second = await capture(() => main(['init', '--agent', 'coding=codex:gpt-5'], workspace));
    expect(second.value).toBe(2);
    expect(second.stderr).toContain('Pass --agent NAME=CLIENT:MODEL for planning (architect), review (reviewer) when');
    const previous = process.env.MIGENT_NO_INPUT;
    process.env.MIGENT_NO_INPUT = '1';
    try {
      const third = await capture(() => main(['init'], workspace));
      expect(third.value).toBe(2);
      expect(third.stderr).toContain(message);
    } finally {
      if (previous === undefined) delete process.env.MIGENT_NO_INPUT;
      else process.env.MIGENT_NO_INPUT = previous;
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('initializes over an empty .migent directory', async () => {
  const workspace = tempDir();
  try {
    mkdirSync(path.join(workspace, '.migent'));
    const captured = await capture(() =>
      runInit(workspace, { agents: ALL_CODEX, runCommand, which: which(new Set(['codex'])) }),
    );
    expect(captured.value).toBe(0);
    expect(existsSync(path.join(workspace, '.migent', 'config.yaml'))).toBe(true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('initializes over an empty .migent/workflows directory', async () => {
  const workspace = tempDir();
  try {
    mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
    const captured = await capture(() =>
      runInit(workspace, { agents: ALL_CODEX, runCommand, which: which(new Set(['codex'])) }),
    );
    expect(captured.value).toBe(0);
    expect(existsSync(path.join(workspace, '.migent', 'workflows', 'implement.yaml'))).toBe(true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('init runs only catalog listing commands, never an inference call', async () => {
  const workspace = tempDir();
  try {
    const seen: string[][] = [];
    const code = await runInit(workspace, {
      agents: ALL_CODEX,
      runCommand: (argv) => {
        seen.push(argv);
        return runCommand(argv);
      },
      which: which(new Set(['codex'])),
    });
    expect(code).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    for (const argv of seen) expect(argv.slice(0, 2)).toEqual(['codex', 'debug']);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});


test('non-interactive CLI requires every agent and accepts the same model for several', async () => {
  const workspace = tempDir();
  cliHooks.which = which(new Set(['codex']));
  cliHooks.runCommand = runCommand;
  try {
    const missing = await capture(() => main(['init', '--no-input', '--agent', 'coding=codex:gpt-5'], workspace));
    expect(missing.value).toBe(2);
    expect(missing.stderr).toContain('planning (architect)');
    expect(existsSync(path.join(workspace, '.migent'))).toBe(false);
    cliHooks.which = which(new Set(['codex']));
    cliHooks.runCommand = runCommand;
    const result = await capture(() => main([
      'init', '--no-input',
      '--agent', 'coding=codex:gpt-5', '--agent', 'planning=codex:gpt-5', '--agent', 'review=codex:gpt-5',
      '--agent-option', 'planning:model_reasoning_effort=medium',
      '--agent-option', 'coding:model_reasoning_effort=low', '--agent-option', 'review:model_reasoning_effort=high',
    ], workspace));
    expect(result.value, result.stderr).toBe(0);
    const resolve = clientRegistry();
    expect(resolveStageTarget(workspace, { workflowId: 'plan', stageId: 'plan' }, { registry: resolve }).options).toEqual({ model_reasoning_effort: 'medium' });
    expect(resolveStageTarget(workspace, { workflowId: 'plan', stageId: 'review_plan' }, { registry: resolve }).options).toEqual({ model_reasoning_effort: 'high' });
    expect(resolveStageTarget(workspace, { workflowId: 'implement', stageId: 'implement' }, { registry: resolve }).options).toEqual({ model_reasoning_effort: 'low' });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('init accepts independent effort flags and rejects conflicting or invalid values', async () => {
  const workspace = tempDir();
  const args = ['init', '--no-input', '--agent', 'planning=codex:gpt-5', '--agent', 'review=codex:gpt-5', '--agent', 'coding=codex:gpt-5'];
  const attempt = (extra: string[]) => {
    cliHooks.which = which(new Set(['codex']));
    cliHooks.runCommand = runCommand;
    return capture(() => main([...args, ...extra], workspace));
  };
  try {
    const conflict = await attempt(['--agent-effort', 'coding=high', '--agent-option', 'coding:model_reasoning_effort=low']);
    expect(conflict.value).toBe(2);
    expect(conflict.stderr).toContain('conflicts');
    const invalid = await attempt(['--agent-effort', 'planning=invalid']);
    expect(invalid.value).toBe(2);
    expect(existsSync(path.join(workspace, '.migent'))).toBe(false);
    const result = await attempt(['--agent-effort', 'planning=medium', '--agent-effort', 'review=high', '--agent-effort', 'coding=low']);
    expect(result.value, result.stderr).toBe(0);
    const local = readFileSync(path.join(workspace, '.migent', 'config.yaml'), 'utf8');
    expect(local).toContain('effort: medium');
    expect(local).toContain('effort: high');
    expect(local).toContain('effort: low');
    const resolve = clientRegistry();
    expect(resolveStageTarget(workspace, { workflowId: 'plan', stageId: 'plan' }, { registry: resolve }).options.model_reasoning_effort).toBe('medium');
    expect(resolveStageTarget(workspace, { workflowId: 'plan', stageId: 'review_plan' }, { registry: resolve }).options.model_reasoning_effort).toBe('high');
    expect(resolveStageTarget(workspace, { workflowId: 'implement', stageId: 'implement' }, { registry: resolve }).options.model_reasoning_effort).toBe('low');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('interactive init saves each role independently without installing the skill', async () => {
  const workspace = tempDir();
  const { calls } = skillRecorder();
  const messages: string[] = [];
  const prompt = new ScriptedPrompt(['codex', 'gpt-5', 'low', 'grok', 'grok-4.7', 'high', 'codex', 'gpt-5', 'xhigh']);
  const modelPrompt = prompt.selectModel.bind(prompt);
  const prompter: Prompter = {
    selectModel(models, message) { messages.push(message); return modelPrompt(models); },
    selectOption: prompt.selectOption.bind(prompt),
  };
  try {
    const result = await capture(() => runInit(workspace, {
      interactive: true, prompter, runCommand, which: which(new Set(['codex', 'grok'])),
    }));
    expect(result.value, result.stderr).toBe(0);
    expect(messages).toEqual(['planning (architect) model', 'review (reviewer) model', 'coding (developer, operator) model']);
    expect(Object.keys(loadWorkspaceConfig(workspace).roles)).toEqual(['architect', 'reviewer', 'developer', 'operator']);
    expect(result.stdout).toContain('migent skill install --project');
    const resolve = clientRegistry();
    expect(resolveStageTarget(workspace, { workflowId: 'implement', stageId: 'implement' }, { registry: resolve })).toEqual({
      client: 'codex', model: 'gpt-5', options: { model_reasoning_effort: 'xhigh' },
    });
    expect(resolveStageTarget(workspace, { workflowId: 'plan', stageId: 'review_plan' }, { registry: resolve })).toEqual({
      client: 'grok', model: 'grok-4.7', options: { 'reasoning-effort': 'high' },
    });
    expect(resolveStageTarget(workspace, { workflowId: 'plan', stageId: 'plan' }, { registry: resolve })).toEqual({
      client: 'codex', model: 'gpt-5', options: { model_reasoning_effort: 'low' },
    });
    expect(calls).toEqual([]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test.each([
  [['planning=codex:hidden']],
  [['planning=codex:gpt-5', 'review=codex:gpt-5', 'coding=codex:gpt-5', 'review=codex:hidden']],
  [['planning=codex:gpt-5', 'review=codex:gpt-5', 'coding=codex:gpt-5', 'review=codex:gpt-5']],
])('invalid agent selection leaves the project unwritten: %j', async (agents) => {
  const workspace = tempDir();
  try {
    const result = await capture(() => runInit(workspace, {
      agents: agents.length === 1 ? [...agents, 'review=codex:gpt-5', 'coding=codex:gpt-5'] : agents,
      runCommand, which: which(new Set(['codex'])),
    }));
    expect(result.value).toBe(2);
    expect(existsSync(path.join(workspace, '.migent'))).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test.each([
  [{ agentOptions: ['planning:model_reasoning_effort=high'] }, 'Pass --agent planning=CLIENT:MODEL with --agent-option.'],
  [{ agentEfforts: ['planning=high'] }, 'Pass --agent planning=CLIENT:MODEL with --agent-effort.'],
  [{ agents: ['nope=codex:gpt-5'] }, 'Unknown agent "nope" for --agent. Agents in this template: planning (architect)'],
  [{ agents: ['planning=codex:gpt-5', 'planning=codex:gpt-5'] }, '--agent planning was given more than once.'],
  [{ agents: ['planning=codex'] }, 'Invalid --agent "planning=codex"; use NAME=CLIENT:MODEL.'],
  [{ agents: ['planning=:gpt-5'] }, 'Invalid --agent "planning=:gpt-5"'],
  [{ agents: ['planning=codex:gpt-5'], agentEfforts: ['planning'] }, 'Invalid --agent-effort "planning"; use NAME=EFFORT.'],
  [{ agents: ALL_CODEX, agentOptions: ['planning:key'] }, 'Option must be KEY=VALUE: key.'],
] as const)('malformed agent flags exit 2 before writing: %j', async (flags, message) => {
  const workspace = tempDir();
  try {
    const result = await capture(() => runInit(workspace, { ...flags, runCommand, which: which(new Set(['codex'])) }));
    expect(result.value).toBe(2);
    expect(result.stderr).toContain(message);
    expect(existsSync(path.join(workspace, '.migent'))).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('--agent splits at the first colon so model IDs may contain colons', async () => {
  const workspace = tempDir();
  try {
    const result = await capture(() => runInit(workspace, {
      agents: ['planning=codex:gpt-5', 'review=codex:gpt-5', 'coding=codex:hidden:1'],
      runCommand, which: which(new Set(['codex'])),
    }));
    expect(result.value).toBe(2);
    expect(result.stderr).toContain('Unknown model: hidden:1');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('removed per-role flags are rejected as unknown options', async () => {
  const workspace = tempDir();
  try {
    for (const flag of ['--planner-client', '--reviewer-model', '--developer-effort', '--client', '--model', '--effort', '--option', '--provider', '--planner-provider']) {
      const result = await capture(() => main(['init', '--no-input', flag, 'x'], workspace));
      expect(result.value, flag).toBe(2);
      expect(result.stderr, flag).toContain('unknown option');
    }
    const help = await capture(() => main(['init', '--help'], workspace));
    expect(help.stdout).toContain('--agent <spec>');
    expect(help.stdout).toContain('--agent-effort <spec>');
    expect(help.stdout).toContain('--agent-option <spec>');
    expect(help.stdout).not.toMatch(/--(planner|reviewer|developer|client|model|effort|option)\b/);
    expect(existsSync(path.join(workspace, '.migent'))).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('fully flagged init loads only the selected client catalogs', async () => {
  const workspace = tempDir();
  const seen: string[] = [];
  try {
    const result = await capture(() => runInit(workspace, {
      agents: ALL_CODEX,
      runCommand: (argv) => { seen.push(argv[0] ?? ''); return runCommand(argv); },
      which: which(new Set(['codex', 'grok'])),
    }));
    expect(result.value, result.stderr).toBe(0);
    expect(new Set(seen)).toEqual(new Set(['codex']));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a template with an extra role and slot needs no code change', async () => {
  const workspace = tempDir();
  const template = path.join(workspace, 'template');
  try {
    cpSync(new URL('../../../templates/', import.meta.url), template, { recursive: true });
    const config = readFileSync(path.join(template, 'config.yaml'), 'utf8')
      .replace('agents:\n', 'agents:\n  docs:\n    model: "{{agent}}"\n')
      .concat('  writer:\n    description: Writes docs.\n    agent: docs\n    responsibilities:\n      - "Write docs."\n');
    writeFileSync(path.join(template, 'config.yaml'), config);
    const project = path.join(workspace, 'project');
    mkdirSync(project);
    const missing = await capture(() => runInit(project, { agents: ALL_CODEX, templateDirectory: template, runCommand, which: which(new Set(['codex'])) }));
    expect(missing.value).toBe(2);
    expect(missing.stderr).toContain('docs (writer)');
    const result = await capture(() => runInit(project, {
      agents: [...ALL_CODEX, 'docs=grok:grok-4.6'], templateDirectory: template, runCommand, which: which(new Set(['codex', 'grok'])),
    }));
    expect(result.value, result.stderr).toBe(0);
    expect(result.stdout).toContain('docs (writer): grok/grok-4.6');
    const roles = loadWorkspaceConfig(project).roles as Record<string, { agent: unknown }>;
    expect(roles.writer?.agent).toBe('docs');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a broken template fails before any prompt or catalog load', async () => {
  const workspace = tempDir();
  const template = path.join(workspace, 'template');
  try {
    cpSync(new URL('../../../templates/', import.meta.url), template, { recursive: true });
    const config = readFileSync(path.join(template, 'config.yaml'), 'utf8').replace('agent: coding', 'agent: missing');
    writeFileSync(path.join(template, 'config.yaml'), config);
    const project = path.join(workspace, 'project');
    mkdirSync(project);
    const seen: string[][] = [];
    const result = await capture(() => runInit(project, {
      interactive: true, templateDirectory: template, which: which(new Set(['codex'])),
      runCommand: (argv) => { seen.push(argv); return runCommand(argv); },
    }));
    expect(result.value).toBe(2);
    expect(result.stderr).toContain('roles.developer.agent');
    expect(seen).toEqual([]);
    expect(existsSync(path.join(project, '.migent'))).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('interactive init loads each available catalog once and tolerates a failed client', async () => {
  const workspace = tempDir();
  const catalogCalls: string[] = [];
  const modelsSeen: ModelSelection[][] = [];
  try {
    const prompt = new ScriptedPrompt(['codex', 'gpt-5', 'low', 'codex', 'gpt-5', 'medium', 'codex', 'gpt-5', 'high']);
    const result = await capture(() => runInit(workspace, {
      interactive: true,
      which: which(new Set(['codex', 'grok'])),
      runCommand: (argv) => {
        if (argv[0] === 'codex' && argv[1] === 'debug' || argv[0] === 'grok' && argv[1] === 'models') {
          catalogCalls.push(argv[0]);
          if (argv[0] === 'grok') throw new Error('offline');
        }
        return runCommand(argv);
      },
      prompter: {
        selectModel(models) { modelsSeen.push([...models]); return prompt.selectModel(models); },
        selectOption: prompt.selectOption.bind(prompt),
      },
    }));
    expect(result.value, result.stderr).toBe(0);
    expect(catalogCalls.filter((name) => name === 'codex')).toHaveLength(1);
    expect(catalogCalls.filter((name) => name === 'grok')).toHaveLength(1);
    expect(modelsSeen).toHaveLength(3);
    expect(modelsSeen.every((models) => models.some((item) => item.client === 'codex' && item.model === 'gpt-5'))).toBe(true);
    expect(result.stderr).toContain('offline');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
