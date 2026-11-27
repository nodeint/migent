import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { BuildCommandInput, CommandSpec } from '@nodeint/migent-kernel';
import { pluginEntryIssues, pluginValidationProblems, registryManifests } from '@nodeint/migent-kernel';
import { createPluginRegistry } from '@nodeint/migent-plugins';
import { createWorkflowSession, readParsedEvents } from '@nodeint/migent-session';
import { afterEach, expect, test } from 'vitest';

import { AgentToolRunner, completeSessionManually, executeNamedWorkflow } from '../src/index.ts';
import { pluginFreezeInput } from '../src/plugin-host/freeze.ts';
import { registryOf, ScriptedClient, tempDir } from './support.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const pluginRegistry = createPluginRegistry();
const PLUGIN_PROMPT = 'You write a short status summary';
const BODY = '## Done stage one ## Current state x ## Needs attention none';

type Mode = 'ok' | 'fail' | 'hang';

/** Serves summary prompts with a process that prints a body, fails or hangs; other prompts are scripted stage turns. */
class SummaryClient extends ScriptedClient {
  public readonly summaryPrompts: string[] = [];
  constructor(responses: string[], private readonly mode: Mode = 'ok', artifacts?: string[]) {
    super(responses, artifacts);
  }

  override buildCommand(input: BuildCommandInput): CommandSpec {
    if (!input.prompt.startsWith(PLUGIN_PROMPT)) return super.buildCommand(input);
    this.summaryPrompts.push(input.prompt);
    this.calls.push({
      model: input.model, workspace: input.workspace, prompt: input.prompt, agentId: input.agentId,
      newAgentId: input.newAgentId, promptFile: input.promptFile, options: { ...input.options },
    });
    const codes: Record<Mode, string> = {
      ok: `process.stdout.write('summary-answer:${BODY}')`,
      fail: "process.stdout.write('summary-answer:x'); process.exit(3)",
      hang: 'setInterval(() => {}, 1000);',
    };
    return { argv: [process.execPath, '-e', codes[this.mode]] };
  }

  override parseResponse(stdout: string): [string, string | null] {
    if (stdout.startsWith('summary-answer:')) return [stdout.slice('summary-answer:'.length), null];
    return super.parseResponse();
  }
}

const QUESTION = 'status: question\n\n' + JSON.stringify({ schema_version: 1, questions: [{
  id: '1', question: 'Scope?', context: 'Needed.', selection: 'single',
  options: [{ id: 'A', label: 'Small' }, { id: 'B', label: 'Large' }],
}] });
const DONE = 'status: complete\n\ndone';
const BLOCKED = 'status: blocked\nblocker: No access to the repository';
const ONE = 'stages:\n  - id: one\n    role: developer\n    ask: human\n';
const TWO = 'stages:\n  - id: one\n    role: developer\n  - id: two\n    role: developer\n    depends_on: [one]\n';
const PRODUCING = 'artifacts:\n  notes: { file: notes.md }\nstages:\n  - id: one\n    role: developer\n    artifacts: [notes]\n';
const ENABLED = 'plugins:\n  summarizer:\n    enabled: true\n    agent: fake\n';
const DISABLED = 'plugins:\n  summarizer:\n    enabled: false\n    agent: fake\n';

interface Session { workspace: string; sessionId: string; directory: string }

const configOf = (plugins: string): string =>
  `agents:\n  fake:\n    client: { type: fake }\n    model: m1\nroles:\n  developer:\n    agent: fake\n${plugins}`;
const setPlugins = (session: Session, plugins: string): void =>
  writeFileSync(path.join(session.workspace, '.migent', 'config.yaml'), configOf(plugins), 'utf8');

function start(plugins: string, stages = ONE): Session {
  const workspace = tempDir('migent-summarizer-');
  roots.push(workspace);
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), configOf(plugins), 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), `schema_version: 8\nid: wf\n${stages}`, 'utf8');
  const clients = registryOf({ fake: new SummaryClient([]) });
  const sessionId = createWorkflowSession(workspace, 'wf', {
    task: 'task', resolveClient: clients, plugins: pluginFreezeInput(pluginRegistry, clients),
  });
  return { workspace, sessionId, directory: path.join(workspace, '.migent', 'sessions', sessionId) };
}

const run = (session: Session, client: SummaryClient, extra: Record<string, unknown> = {}) => {
  const runner = new AgentToolRunner(registryOf({ fake: client }), 10);
  runner.pluginRegistry = pluginRegistry;
  return executeNamedWorkflow(session.workspace, { workflowId: 'wf', sessionId: session.sessionId, ...extra }, runner);
};

const summaryOf = (session: Session): string | null => {
  const file = path.join(session.directory, 'plugins', 'summarizer', 'summary.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
};
const basisOf = (content: string | null): number => Number(/basis_seq=(\d+)/u.exec(content ?? '')?.[1] ?? Number.NaN);
const summarizerEvents = (session: Session) =>
  readParsedEvents(path.join(session.directory, 'events.jsonl'))
    .filter((event) => event.event.startsWith('plugin.') && event.data.plugin === 'summarizer');

test('a question stop writes a summary that names the question, with one recorded agent call', async () => {
  const session = start(ENABLED);
  const client = new SummaryClient([QUESTION]);
  expect((await run(session, client)).code).toBe(9);
  expect(client.summaryPrompts).toHaveLength(1);
  expect(client.summaryPrompts[0]).toContain('Scope?');
  const content = summaryOf(session) ?? '';
  expect(content.split('\n')[0]).toMatch(/^<!-- migent-summary v1 basis_seq=\d+ -->$/u);
  expect(content.split('\n')[1]).toContain('question');
  expect(content).toContain('## Needs attention');
  const events = summarizerEvents(session);
  expect(events.map((event) => event.event)).toEqual(['plugin.hook_invoked', 'plugin.decision']);
  expect(events[1]?.data.agent_calls).toHaveLength(1);
});

test('a completing run writes one summary whose title says completed', async () => {
  const session = start(ENABLED);
  const client = new SummaryClient([DONE]);
  expect((await run(session, client)).code).toBe(0);
  expect(client.summaryPrompts).toHaveLength(1);
  expect(summaryOf(session)?.split('\n')[1]).toContain('completed');
});

test('session complete writes a summary whose title says completed', async () => {
  const session = start(ENABLED);
  const client = new SummaryClient([QUESTION]);
  expect((await run(session, client)).code).toBe(9);
  expect(summaryOf(session)?.split('\n')[1]).toContain('question');
  const outcome = await completeSessionManually(session.workspace, session.sessionId, {
    pluginRegistry, clients: registryOf({ fake: client }),
  });
  expect(outcome.pluginWarning).toBeNull();
  expect(client.summaryPrompts).toHaveLength(2);
  expect(summaryOf(session)?.split('\n')[1]).toContain('completed');
});

test('a blocked stop writes a summary that carries the blocker when blocked is configured', async () => {
  const session = start(`${ENABLED}    triggers: [blocked]\n`);
  const client = new SummaryClient([BLOCKED]);
  await run(session, client);
  expect(client.summaryPrompts).toHaveLength(1);
  expect(client.summaryPrompts[0]).toContain('No access to the repository');
  expect(summaryOf(session)?.split('\n')[1]).toContain('blocked');
});

test('completed-only skips a question stop; [] never calls the agent', async () => {
  const only = start(`${ENABLED}    triggers: [completed]\n`);
  const first = new SummaryClient([QUESTION]);
  expect((await run(only, first)).code).toBe(9);
  expect(first.summaryPrompts).toHaveLength(0);
  expect(summaryOf(only)).toBeNull();

  const none = start(`${ENABLED}    triggers: []\n`);
  const second = new SummaryClient([DONE]);
  expect((await run(none, second)).code).toBe(0);
  expect(second.summaryPrompts).toHaveLength(0);
  expect(summaryOf(none)).toBeNull();
});

test('execution-only invokes once per finished execution and never on completion', async () => {
  const session = start(`${ENABLED}    triggers: [execution]\n`, TWO);
  const client = new SummaryClient([DONE, DONE]);
  expect((await run(session, client)).code).toBe(0);
  expect(client.summaryPrompts).toHaveLength(2);
  const hooks = summarizerEvents(session).filter((event) => event.event === 'plugin.hook_invoked');
  expect(hooks.map((event) => event.data.hook)).toEqual(['execution.finished', 'execution.finished']);
  const failed = summarizerEvents(session).filter((event) => event.event === 'plugin.failed');
  expect(failed).toEqual([]);
  expect(summaryOf(session)).not.toBeNull();
});

test('a stage artifact reaches the summary prompt, and an oversized one is named as shortened', async () => {
  const small = start(ENABLED, PRODUCING);
  const smallClient = new SummaryClient([DONE], 'ok', ['# notes\nPRD-MARKER-7\n']);
  expect((await run(small, smallClient)).code).toBe(0);
  expect(smallClient.summaryPrompts[0]).toContain('PRD-MARKER-7');

  const big = start(ENABLED, PRODUCING);
  const bigClient = new SummaryClient([DONE], 'ok', [`${'A'.repeat(40_000)}\nTAIL-MARKER\n`]);
  expect((await run(big, bigClient)).code).toBe(0);
  const [prompt] = bigClient.summaryPrompts;
  expect(prompt).toContain('notes.md: shortened');
  expect(prompt).not.toContain('TAIL-MARKER');
});

test('a failing summary agent records plugin.failed, keeps the exit code and writes no file', async () => {
  const session = start(ENABLED);
  const client = new SummaryClient([DONE], 'fail');
  expect((await run(session, client)).code).toBe(0);
  expect(summaryOf(session)).toBeNull();
  expect(summarizerEvents(session).map((event) => event.event)).toContain('plugin.failed');
});

test('a timed-out summary agent records a timeout and keeps the exit code', async () => {
  const session = start(`${ENABLED}    timeout_sec: 1\n`);
  const client = new SummaryClient([DONE], 'hang');
  expect((await run(session, client)).code).toBe(0);
  expect(summaryOf(session)).toBeNull();
  const failed = summarizerEvents(session).find((event) => event.event === 'plugin.failed');
  expect(failed?.data.reason).toBe('timeout');
}, 30_000);

test('a disabled entry writes nothing', async () => {
  const session = start(DISABLED);
  const client = new SummaryClient([DONE]);
  expect((await run(session, client)).code).toBe(0);
  expect(client.summaryPrompts).toHaveLength(0);
  expect(summaryOf(session)).toBeNull();
});

test('enabling the plugin after the session started writes a summary on the next stop', async () => {
  const session = start('');
  const client = new SummaryClient([QUESTION, DONE]);
  expect((await run(session, client)).code).toBe(9);
  expect(client.summaryPrompts).toHaveLength(0);
  setPlugins(session, ENABLED);
  expect((await run(session, client, { reply: 'Small' })).code).toBe(0);
  expect(client.summaryPrompts).toHaveLength(1);
  expect(summaryOf(session)?.split('\n')[1]).toContain('completed');
});

test('disabling the plugin after a summary keeps the stored file and writes nothing new', async () => {
  const session = start(ENABLED);
  const client = new SummaryClient([QUESTION, DONE]);
  expect((await run(session, client)).code).toBe(9);
  const before = summaryOf(session);
  expect(before).not.toBeNull();
  setPlugins(session, DISABLED);
  expect((await run(session, client, { reply: 'Small' })).code).toBe(0);
  expect(client.summaryPrompts).toHaveLength(1);
  expect(summaryOf(session)).toBe(before);
});

test('two triggers replace one file with the newer basis_seq', async () => {
  const session = start(ENABLED);
  const client = new SummaryClient([QUESTION, DONE]);
  expect((await run(session, client)).code).toBe(9);
  const first = basisOf(summaryOf(session));
  expect((await run(session, client, { reply: 'Small' })).code).toBe(0);
  const second = basisOf(summaryOf(session));
  expect(second).toBeGreaterThan(first);
  const files = readdirSync(path.join(session.directory, 'plugins', 'summarizer')).filter((name) => name !== 'calls');
  expect(files).toEqual(['summary.md']);
});

/** Values that differ between runs: clocks, process ids, the provider pipe and event sequence numbers. */
const VOLATILE_KEYS = new Set(['owner_pid', 'provider_pid', 'provider_endpoint', 'seq']);
const isClock = (key: string): boolean => key === 'timestamp' || key.endsWith('_at');

/** Replaces only the known volatile values, at any depth; every other field is kept as persisted. */
function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalized(item));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => {
    if (VOLATILE_KEYS.has(key) || isClock(key)) return [key, '<volatile>'];
    return [key, normalized(inner)];
  }));
}

const readJson = (file: string): unknown => normalized(JSON.parse(readFileSync(file, 'utf8')));

/** Every file below a directory, as relative path to raw bytes, including nested files. */
function bytesOf(directory: string): Record<string, Buffer> {
  if (!existsSync(directory)) return {};
  const files = readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  return Object.fromEntries(files.map((entry) => {
    const file = path.join(entry.parentPath, entry.name);
    return [path.relative(directory, file).split(path.sep).join('/'), readFileSync(file)];
  }));
}

/** Complete status.json, every execution.json and every stage artifact byte: what a plugin must never change. */
function observed(session: Session): unknown {
  const executions = path.join(session.directory, 'executions');
  return {
    status: readJson(path.join(session.directory, 'status.json')),
    executions: readdirSync(executions).sort().map((name) => ({
      name,
      record: readJson(path.join(executions, name, 'execution.json')),
      artifacts: bytesOf(path.join(executions, name, 'artifacts')),
    })),
  };
}

const ARTIFACT = '# notes\nsame \u00e9\u0000\n';
const RUNS: [string, string, string[]][] = [
  ['a completed stage that publishes an artifact', DONE, [ARTIFACT]],
  ['a blocked stage with a blocker', BLOCKED, [ARTIFACT]],
];

test.each(RUNS)('status, executions and artifacts match a run without the plugin for %s', async (_name, reply, files) => {
  const withPlugin = start(ENABLED, PRODUCING);
  const without = start('', PRODUCING);
  const a = await run(withPlugin, new SummaryClient([reply], 'ok', files));
  const b = await run(without, new SummaryClient([reply], 'ok', files));
  expect(a.code).toBe(b.code);
  const seen = observed(withPlugin);
  expect(seen).toEqual(observed(without));
  expect(JSON.stringify(seen)).toContain(reply === BLOCKED ? 'No access to the repository' : '"status":"complete"');
  expect(summaryOf(withPlugin)).not.toBeNull();
  expect(summaryOf(without)).toBeNull();
});

const BAD_ENTRIES: [string, Record<string, unknown>, string][] = [
  ['a missing agent', { enabled: true }, 'plugins.summarizer'],
  ['an unknown trigger', { enabled: true, agent: 'fake', triggers: ['weekly'] }, 'plugins.summarizer'],
  ['a duplicate trigger', { enabled: true, agent: 'fake', triggers: ['completed', 'completed'] }, 'plugins.summarizer.triggers[1]'],
];

test.each(BAD_ENTRIES)('%s is reported by the validators and refused by createWorkflowSession (command exit codes: cli summarizer-config)', (_name, entry, field) => {
  const config = { plugins: { summarizer: entry } };
  const issues = pluginEntryIssues({ plugins: config.plugins, manifests: registryManifests(pluginRegistry) });
  const problems = pluginValidationProblems(pluginRegistry, config, {});
  const reported = [...issues.map((issue) => issue.path?.join('.') ?? ''), ...problems.map((problem) => problem.path.join('.'))];
  expect(reported.some((where) => where.startsWith(field.replace('[1]', '')))).toBe(true);

  const workspace = tempDir('migent-summarizer-bad-');
  roots.push(workspace);
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  const yaml = Object.entries(entry).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`).join('\n');
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), configOf(`plugins:\n  summarizer:\n${yaml}\n`), 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), `schema_version: 8\nid: wf\n${ONE}`, 'utf8');
  const clients = registryOf({ fake: new SummaryClient([]) });
  expect(() => createWorkflowSession(workspace, 'wf', {
    task: 'task', resolveClient: clients, plugins: pluginFreezeInput(pluginRegistry, clients),
  })).toThrow(/summarizer/u);
});
