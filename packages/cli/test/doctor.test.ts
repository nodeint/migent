import { execFileSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadYamlMapping } from '@nodeint/migent-kernel';
import { activatePreparedSession } from '@nodeint/migent-session';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { clientRegistry } from '../src/client.ts';
import { cliHooks } from '../src/hooks.ts';
import { main } from '../src/index.ts';
import { capture, repoWorkflowText } from './support.ts';

// Never reach the developer's real provider CLIs: model lists are unavailable unless a test injects them.
const offline = (): string => { throw new Error('offline'); };
beforeEach(() => { cliHooks.runCommand = offline; });
afterEach(() => { cliHooks.runCommand = null; });

function whichBoth(command: string): string | null {
  if (command === 'codex' || command === 'grok') return `/bin/${command}`;
  return null;
}

function writeProject(workspace: string): void {
  const workflows = path.join(workspace, '.migent', 'workflows');
  mkdirSync(workflows, { recursive: true });
  const config = `\
schema_version: 7
agents:
  planner-model:
    client:
      type: codex
    model: gpt-5
  reviewer-model:
    client:
      type: grok
    model: grok-4
roles:
  planner:
    agent: planner-model
  reviewer:
    agent: reviewer-model
  developer:
    agent: planner-model
`;
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), config, 'utf8');
  writeFileSync(path.join(workflows, 'plan.yaml'), repoWorkflowText('plan'), 'utf8');
}

test('doctor passes from a project subdirectory', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-cli-'));
  try {
    writeProject(workspace);
    const child = path.join(workspace, 'src');
    mkdirSync(child);
    cliHooks.which = whichBoth;
    const captured = await capture(() => main(['doctor'], child));
    expect(captured.value).toBe(0);
    expect(captured.stdout).toContain('ok');
    expect(captured.stdout).toContain('developer');
    expect(captured.stdout).toContain('plan');
    expect(captured.stdout).toContain('/bin/grok');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('doctor json fails when a client command is missing', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-cli-'));
  try {
    writeProject(workspace);
    cliHooks.which = (command) => (command === 'codex' ? '/bin/codex' : null);
    const captured = await capture(() => main(['doctor', '--json'], workspace));
    const payload = JSON.parse(captured.stdout) as {
      ok: boolean;
      checks: { name: string; problems: string[]; items: string[] }[];
    };
    expect(captured.value).toBe(1);
    expect(payload.ok).toBe(false);
    const clients = payload.checks.find((check) => check.name === 'clients');
    expect(clients?.problems).toEqual(['grok is not on PATH']);
    expect(clients?.items).toContain('codex  /bin/codex');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('doctor stops when the schema is outdated', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-cli-'));
  try {
    writeProject(workspace);
    const configPath = path.join(workspace, '.migent', 'config.yaml');
    const original = readFileSync(configPath, 'utf8').replace('schema_version: 7\n', '');
    writeFileSync(configPath, original, 'utf8');
    const captured = await capture(() => main(['doctor'], workspace));
    expect(captured.value).toBe(2);
    expect(captured.stderr).toContain('Run `migent migrate` to update.');
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('doctor exits 2 when the workspace is missing', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-cli-'));
  try {
    const captured = await capture(() => main(['doctor'], workspace));
    expect(captured.value).toBe(2);
    expect(captured.stderr).toContain('.migent/config.yaml');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function writeClientlessProject(workspace: string, client: string | null): void {
  writeProject(workspace);
  const configPath = path.join(workspace, '.migent', 'config.yaml');
  const clientLine = client === null ? '' : `    client:\n      type: ${client}\n`;
  const text = readFileSync(configPath, 'utf8').replace(
    'roles:\n',
    `  bp-model:\n${clientLine}    model: seed-1\nroles:\n`,
  );
  writeFileSync(configPath, text, 'utf8');
}

function configProblems(stdout: string): string[] {
  const payload = JSON.parse(stdout) as { checks: { name: string; problems: string[] }[] };
  return payload.checks.find((check) => check.name === 'config')?.problems ?? [];
}

test('doctor reports an agent that names no client', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-cli-'));
  try {
    writeClientlessProject(workspace, null);
    cliHooks.which = whichBoth;
    const captured = await capture(() => main(['doctor', '--json'], workspace));
    expect(captured.value).toBe(1);
    // With no client.type, the client is inferred from the model; no client lists seed-1 here.
    expect(configProblems(captured.stdout).join('\n')).toMatch(
      /No client lists model seed-1 .*set agents\.bp-model\.client\.type\./,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("doctor accepts an agent with a client and checks that client's command", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-cli-'));
  try {
    writeClientlessProject(workspace, 'codex');
    cliHooks.which = whichBoth;
    const captured = await capture(() => main(['doctor', '--json'], workspace));
    expect(captured.value).toBe(0);
    expect(configProblems(captured.stdout)).toEqual([]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('doctor rejects an agent with an unknown client', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-cli-'));
  try {
    writeClientlessProject(workspace, 'nope');
    cliHooks.which = whichBoth;
    const captured = await capture(() => main(['doctor', '--json'], workspace));
    expect(captured.value).toBe(1);
    expect(configProblems(captured.stdout).join('\n')).toMatch(/agents\.bp-model\.client\.type is not supported: .*Unknown CLI client: nope/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('doctor prints and returns a tracked config.local.yaml warning without failing', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-cli-'));
  try {
    writeProject(workspace);
    writeFileSync(path.join(workspace, '.migent', 'config.local.yaml'), 'schema_version: 7\nagents: {}\n', 'utf8');
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    execFileSync('git', ['add', '.migent/config.local.yaml'], { cwd: workspace });
    cliHooks.which = whichBoth;
    const text = await capture(() => main(['doctor'], workspace));
    expect(text.value).toBe(0);
    expect(text.stdout).toContain('warning: .migent/config.local.yaml is tracked by git');
    cliHooks.which = whichBoth;
    cliHooks.runCommand = offline;
    const json = await capture(() => main(['doctor', '--json'], workspace));
    expect(json.value).toBe(0);
    const {checks} = (JSON.parse(json.stdout) as { checks: { name: string; warnings: string[] }[] });
    expect(checks.find((check) => check.name === 'config')?.warnings.filter((warning) => !warning.startsWith('Could not validate'))).toHaveLength(1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('doctor warns about a missing or outdated Migent skill without failing', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-cli-'));
  const home = mkdtempSync(path.join(tmpdir(), 'migent-home-'));
  try {
    writeProject(workspace);
    const skills = (await import('../src/skill-check.ts')).skillCheck;
    const none = skills(workspace, home);
    expect(none.ok).toBe(true);
    expect(none.warnings.join('\n')).toContain('migent skill install');

    const installed = path.join(home, '.agents', 'skills', 'migent');
    const { skillSourceDirectory } = await import('../src/commands/skill.ts');
    cpSync(skillSourceDirectory(), installed, { recursive: true });
    const current = skills(workspace, home);
    expect(current.warnings).toEqual([]);
    expect(current.items[0]).toContain('~/.agents/skills/migent');

    writeFileSync(path.join(installed, 'SKILL.md'), '---\nname: migent\n---\nold\n', 'utf8');
    const different = skills(workspace, home);
    expect(different.ok).toBe(true);
    expect(different.warnings[0]).toContain('migent skill update --global');

    cliHooks.which = whichBoth;
    const captured = await capture(() => main(['doctor', '--json'], workspace));
    expect(captured.value).toBe(0);
    const names = (JSON.parse(captured.stdout) as { checks: { name: string }[] }).checks.map((check) => check.name);
    expect(names).toContain('skill');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});


test('doctor and session prepare resolve model effort through adapter clients', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-effort-cli-'));
  try {
    writeProject(workspace);
    const configPath = path.join(workspace, '.migent', 'config.yaml');
    writeFileSync(configPath, readFileSync(configPath, 'utf8')
      .replace('    model: gpt-5', '    model: gpt-5\n    effort: high')
      .replace('    model: grok-4', '    model: grok-4\n    effort: medium'));
    cliHooks.which = whichBoth;
    cliHooks.runCommand = () => '';
    const checked = await capture(() => main(['doctor', '--json'], workspace));
    expect(checked.value).toBe(0);
    const prepared = await capture(() => main(['session', 'prepare', 'effort test', '--workflow', 'plan'], workspace));
    expect(prepared.value).toBe(0);
    const { session_id: sessionId } = JSON.parse(prepared.stdout) as { session_id: string };
    writeFileSync(path.join(workspace, '.migent', 'sessions', sessionId, 'task.md'), 'Check effort at start\n');
    activatePreparedSession(workspace, sessionId, clientRegistry());
    const frozen = loadYamlMapping(path.join(workspace, '.migent', 'sessions', sessionId, 'workflow.frozen.yaml'));
    type FrozenTarget = { client: string; options: Record<string, string> };
    const targets = Object.values(frozen.targets as Record<string, FrozenTarget>);
    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ client: 'codex', options: { model_reasoning_effort: 'high' } }),
      expect.objectContaining({ client: 'grok', options: { 'reasoning-effort': 'medium' } }),
    ]));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

async function prepareSession(workspace: string): Promise<string> {
  const prepared = await capture(() => main(['session', 'prepare', 'doctor session', '--workflow', 'plan'], workspace));
  expect(prepared.value).toBe(0);
  return (JSON.parse(prepared.stdout) as { session_id: string }).session_id;
}

function treeText(directory: string): string {
  const parts: string[] = [];
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) visit(full);
      else parts.push(`${path.relative(directory, full)}\n${readFileSync(full, 'utf8')}`);
    }
  };
  visit(directory);
  return parts.join('\n--\n');
}

test('doctor --session validates a prepared draft in text and JSON without writing', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-cli-'));
  try {
    writeProject(workspace);
    const sessionId = await prepareSession(workspace);
    cliHooks.which = whichBoth;
    cliHooks.runCommand = offline;
    const before = treeText(path.join(workspace, '.migent'));
    const text = await capture(() => main(['doctor', '--session', sessionId], workspace));
    expect(text.value).toBe(0);
    expect(text.stdout).toContain(`source  draft  .migent/sessions/${sessionId}/workflow.yaml`);
    expect(text.stdout).not.toContain('skill');
    cliHooks.which = whichBoth;
    cliHooks.runCommand = offline;
    const json = await capture(() => main(['doctor', '--session', sessionId, '--json'], workspace));
    expect(json.value).toBe(0);
    expect(json.stderr).toBe('');
    const payload = JSON.parse(json.stdout) as {
      ok: boolean;
      session: Record<string, string>;
      checks: { name: string }[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.session).toEqual({
      id: sessionId,
      workflow_id: 'plan',
      source: 'draft',
      path: `.migent/sessions/${sessionId}/workflow.yaml`,
    });
    expect(payload.checks.map((check) => check.name)).toEqual(['session', 'workflow', 'bindings', 'clients']);
    expect(treeText(path.join(workspace, '.migent'))).toBe(before);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('doctor --session exits 1 for a broken draft and a missing executable', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-cli-'));
  try {
    writeProject(workspace);
    const sessionId = await prepareSession(workspace);
    const draft = path.join(workspace, '.migent', 'sessions', sessionId, 'workflow.yaml');
    cliHooks.which = (command) => (command === 'codex' ? '/bin/codex' : null);
    const missing = await capture(() => main(['doctor', '--session', sessionId, '--json'], workspace));
    expect(missing.value).toBe(1);
    const clients = (JSON.parse(missing.stdout) as { checks: { name: string; problems: string[] }[] }).checks
      .find((check) => check.name === 'clients');
    expect(clients?.problems.join('\n')).toContain('grok is not on PATH (stages:');
    writeFileSync(draft, 'id: plan\nstages: nope\n', 'utf8');
    cliHooks.which = whichBoth;
    const broken = await capture(() => main(['doctor', '--session', sessionId], workspace));
    expect(broken.value).toBe(1);
    expect(broken.stdout).toContain('failed');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('doctor --session validates a frozen session without live workflows or an unrelated broken catalog', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-cli-'));
  try {
    writeProject(workspace);
    const sessionId = await prepareSession(workspace);
    writeFileSync(path.join(workspace, '.migent', 'sessions', sessionId, 'task.md'), 'Task\n');
    activatePreparedSession(workspace, sessionId, clientRegistry());
    rmSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
    mkdirSync(path.join(workspace, '.migent', 'workflows'));
    writeFileSync(path.join(workspace, '.migent', 'workflows', 'bad.yaml'), 'id: bad\nstages: nope\n');
    const draft = path.join(workspace, '.migent', 'sessions', sessionId, 'workflow.yaml');
    writeFileSync(draft, `${readFileSync(draft, 'utf8')}# edited after start
`);
    cliHooks.which = whichBoth;
    const workspaceDoctor = await capture(() => main(['doctor'], workspace));
    expect(workspaceDoctor.value).not.toBe(0);
    cliHooks.which = whichBoth;
    const captured = await capture(() => main(['doctor', '--session', sessionId, '--json'], workspace));
    expect(captured.value).toBe(0);
    expect(captured.stderr).toBe('');
    const payload = JSON.parse(captured.stdout) as {
      session: Record<string, string>;
      checks: { warnings: string[] }[];
    };
    expect(payload.session.source).toBe('frozen');
    expect(payload.checks.flatMap((check) => check.warnings).join('\n')).toContain('The workflow file differs.');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('doctor --session uses the CLI exit conventions for unusable sessions', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-cli-'));
  try {
    writeProject(workspace);
    cliHooks.which = whichBoth;
    const invalid = await capture(() => main(['doctor', '--session', '../escape'], workspace));
    expect(invalid.value).toBe(2);
    expect(invalid.stderr).toContain('Invalid session id: ../escape.');
    const unknown = await capture(() => main(['doctor', '--session', 'missing', '--json'], workspace));
    expect(unknown.value).toBe(1);
    const payload = JSON.parse(unknown.stdout) as {
      ok: boolean;
      session: { id: string; source: null };
      checks: { problems: string[] }[];
    };
    expect(payload.ok).toBe(false);
    expect(payload.session).toMatchObject({ id: 'missing', source: null });
    expect(payload.checks[0]?.problems).toEqual(['Session not found: missing.']);
    const help = await capture(() => main(['doctor', '--help'], workspace));
    expect(help.stdout).toContain('--session <id>');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
