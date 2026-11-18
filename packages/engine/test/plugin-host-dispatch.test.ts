import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Plugin, PluginEventProposal, PluginHandler, PluginHook, PluginRegistry, PluginUses, TSchema } from '@nodeint/migent-contracts';
import { raiseCancellation, resetCancellation } from '@nodeint/migent-kernel';
import { readParsedEvents, SessionLock, SessionStore } from '@nodeint/migent-session';
import { expect, test } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { isSafeOutputName } from '../src/plugin-host/dispatch.ts';
import { registryOf, ScriptedClient, tempDir } from './support.ts';

const FAN = `schema_version: 2
id: chain
concurrency: 2
stages:
  - id: a
    role: developer
  - id: b
    role: developer
  - id: c
    role: developer
    depends_on: [a, b]
`;

const schema = { type: 'object' } as unknown as TSchema;
const DONE = 'status: complete\n\ndone';
const CHAIN = 'schema_version: 2\nid: chain\nstages:\n  - id: a\n    role: developer\n  - id: b\n    role: developer\n    depends_on: [a]\n';
const BASE = 'agents:\n  fake:\n    client: { type: fake }\n    model: m1\nroles:\n  developer:\n    agent: fake\n';

const NO_USES: PluginUses = { operations: [], events: [], session: [], artifacts: [], agents: false, config: [] };
const ARTIFACTS: PluginUses['artifacts'] = [
  { name: 'report.md', mode: 'replace', media_type: 'text/markdown' },
  { name: 'late.md', mode: 'replace', media_type: 'text/plain' },
];

const plugin = (
  id: string,
  handlers: Partial<Record<PluginHook, PluginHandler>>,
  extra: Partial<Plugin['manifest']> = {},
): Plugin => ({
  manifest: {
    id, version: '1.0.0', apiVersion: { major: 1, minor: 0 }, advisory: false, configSchema: schema,
    uses: { ...NO_USES, events: Object.keys(handlers) as PluginHook[], artifacts: ARTIFACTS }, ...extra,
  },
  activate: (_options, migent) => {
    for (const [hook, handler] of Object.entries(handlers)) migent.events.on(hook as PluginHook, handler);
  },
});
const registryOfPlugins = (...plugins: Plugin[]): PluginRegistry => ({
  ids: () => plugins.map((entry) => entry.manifest.id),
  get: (id) => plugins.find((entry) => entry.manifest.id === id),
});

function workspaceWith(plugins: string, workflow = CHAIN): string {
  const workspace = tempDir('migent-plugin-dispatch-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), BASE + plugins, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'chain.yaml'), workflow, 'utf8');
  return workspace;
}
const entries = (spec: Record<string, string>): string =>
  `plugins:\n${Object.entries(spec).map(([id, body]) => `  ${id}:\n    enabled: true\n${body}`).join('')}`;
const directoryOf = (workspace: string, id: string): string => path.join(workspace, '.migent', 'sessions', id);
const eventsOf = (workspace: string, id: string) => readParsedEvents(path.join(directoryOf(workspace, id), 'events.jsonl'));
const names = (workspace: string, id: string, prefix = 'plugin.'): string[] =>
  eventsOf(workspace, id).map((event) => event.event).filter((name) => name.startsWith(prefix));
const statusOf = (workspace: string, id: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(directoryOf(workspace, id), 'status.json'), 'utf8')) as Record<string, unknown>;

interface RunOptions {
  responses?: string[];
  sessionId?: string;
  workspace?: string;
  workflow?: string;
  maxDispatches?: number;
  client?: ScriptedClient;
}

async function run(plugins: Plugin[], config: string, options: RunOptions = {}) {
  const workspace = options.workspace ?? workspaceWith(config, options.workflow);
  const sessionId = options.sessionId ?? '';
  const registry = registryOf({ fake: options.client ?? new ScriptedClient(options.responses ?? [DONE, DONE]) });
  const runner = new AgentToolRunner(registry, 10);
  runner.pluginRegistry = registryOfPlugins(...plugins);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'chain', maxDispatches: options.maxDispatches, ...(sessionId === '' ? { task: 'go' } : { sessionId }) }, runner);
  return { workspace, result };
}

test('happy path: events, output file with sha256, note and none', async () => {
  const intents: PluginEventProposal[] = [
    { kind: 'artifact', name: 'report.md', content: 'hello' },
    { kind: 'note', text: 'n' },
    { kind: 'none' },
  ];
  const demo = plugin('demo', { 'session.started': () => Promise.resolve(intents) });
  const { workspace, result } = await run([demo], entries({ demo: '' }));
  expect(result.code).toBe(0);
  const id = result.sessionId;
  expect(names(workspace, id)).toEqual(['plugin.hook_invoked', 'plugin.decision']);
  expect(readFileSync(path.join(directoryOf(workspace, id), 'plugins', 'demo', 'report.md'), 'utf8')).toBe('hello');
  const decision = eventsOf(workspace, id).find((event) => event.event === 'plugin.decision');
  expect(decision?.data.results).toMatchObject([{ kind: 'artifact', status: 'applied', path: 'plugins/demo/report.md' }, { kind: 'note' }, { kind: 'none' }]);
  expect((decision?.data.results as { sha256: string }[])[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test('execution.finished fires per terminal execution and session.stopped once when new work ran', async () => {
  const seen: string[] = [];
  const hook: PluginHandler = (input) => {
    seen.push(`${input.hook}:${input.execution?.stage_id ?? '-'}`);
    return Promise.resolve([]);
  };
  const demo = plugin('demo', { 'session.started': hook, 'execution.finished': hook, 'session.stopped': hook });
  const { result } = await run([demo], entries({ demo: '' }));
  expect(result.code).toBe(0);
  expect(seen).toEqual(['session.started:-', 'execution.finished:a', 'execution.finished:b', 'session.stopped:-']);
});

const WORKSPACE = { current: '' };

type Kind = 'error' | 'invalid' | 'traversal' | 'conflict';
const FILE_INTENT: PluginEventProposal = { kind: 'artifact', name: 'report.md', content: 'x' };
const handlerFor = (kind: Kind): PluginHandler => {
  switch (kind) {
    case 'error': return () => Promise.reject(new Error('boom'));
    case 'invalid': return () => Promise.resolve([{ kind: 'bogus' }] as unknown as PluginEventProposal[]);
    case 'traversal': return () => Promise.resolve([{ ...FILE_INTENT, name: '../escape.md' }]);
    case 'conflict': return (input) => {
      // The output name is already a directory, so the write fails.
      mkdirSync(path.join(WORKSPACE.current, '.migent', 'sessions', input.session.id, 'plugins', 'demo', 'report.md'), { recursive: true });
      return Promise.resolve([FILE_INTENT]);
    };
  }
};
const REASON: Record<Kind, string> = { error: 'error', invalid: 'invalid_intent', traversal: 'invalid_intent', conflict: 'error' };

/** Hash of every file under each execution directory, so a rewritten outcome or conversation file shows. */
function executionFiles(workspace: string, id: string): Record<string, Record<string, string>> {
  const root = path.join(directoryOf(workspace, id), 'executions');
  const walk = (directory: string, base: string, out: Record<string, string>): Record<string, string> => {
    for (const name of readdirSync(directory)) {
      const full = path.join(directory, name);
      if (statSync(full).isDirectory()) walk(full, `${base}${name}/`, out);
      else out[`${base}${name}`] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
    return out;
  };
  return Object.fromEntries(readdirSync(root).map((dir) => [dir, walk(path.join(root, dir), '', {})] as const));
}
const outcomesOf = (workspace: string, id: string): Record<string, string> =>
  Object.fromEntries(
    new SessionStore(workspace).executionSnapshots(id).map((item) => [item.executionId, item.status] as const),
  );

/** The state of the execution a hook was triggered for, captured when the hook starts. */
interface Snapshot {
  readonly executionId: string;
  readonly files: Record<string, string>;
  readonly status: string | undefined;
}

/** Asserts the triggering execution's files and outcome are identical now to when its hook ran. */
function expectUntouched(workspace: string, id: string, snapshots: readonly Snapshot[]): void {
  expect(snapshots).toHaveLength(1);
  for (const snapshot of snapshots) {
    expect(executionFiles(workspace, id)[snapshot.executionId]).toEqual(snapshot.files);
    expect(outcomesOf(workspace, id)[snapshot.executionId]).toBe(snapshot.status);
  }
}

/** A plugin whose first execution.finished invocation runs `first` and whose later ones succeed. */
const failingFirst = (first: PluginHandler, snapshots: Snapshot[] = []): Plugin => {
  let failed = false;
  return plugin('demo', {
    'execution.finished': (input, call) => {
      if (failed) return Promise.resolve([]);
      failed = true;
      const executionId = input.execution?.id ?? '';
      snapshots.push({
        executionId,
        files: executionFiles(WORKSPACE.current, input.session.id)[executionId] ?? {},
        status: outcomesOf(WORKSPACE.current, input.session.id)[executionId],
      });
      return first(input, call);
    },
  });
};
const failingOnce = (kind: Kind, snapshots: Snapshot[] = []): Plugin => failingFirst(handlerFor(kind), snapshots);

/** Fields of `status.json` that do not depend on timing or the plugin. */
const STABLE_STATUS = ['session_id', 'title', 'workflow_id', 'workflow_path', 'task', 'task_sha256'] as const;
const stablePart = (status: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(STABLE_STATUS.map((key) => [key, status[key]] as const));
/** Fields the execution history alone determines. */
const FINAL_STATUS = [
  'status', 'latest_stage_id', 'latest_execution_status', 'completion_method', 'terminal_execution_id',
] as const;
const finalPart = (status: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(FINAL_STATUS.map((key) => [key, status[key]] as const));

/** The same workflow with no plugin: the baseline a hook failure is compared with. */
async function baselineRun(workflow?: string, client?: ScriptedClient) {
  const { workspace, result } = await run([], '', { workflow, client });
  return { result, status: statusOf(workspace, result.sessionId) };
}

test.each(
  (['error', 'invalid', 'traversal', 'conflict'] as const)
    .flatMap((kind) => (['ignore', 'stop', 'fail'] as const).map((policy) => [kind, policy] as const)),
)('failure matrix: %s under on_error %s', async (kind, policy) => {
  const workspace = workspaceWith(entries({ demo: `    on_error: ${policy}\n` }));
  WORKSPACE.current = workspace;
  const snapshots: Snapshot[] = [];
  const { result } = await run([failingOnce(kind, snapshots)], '', { workspace });
  const id = result.sessionId;
  const baseline = await baselineRun();
  // Failure handling touches neither the execution files nor the committed outcome of the triggering execution.
  expectUntouched(workspace, id, snapshots);
  expect(stablePart(statusOf(workspace, id))).toMatchObject(stablePart(baseline.status));
  const failed = eventsOf(workspace, id).filter((event) => event.event === 'plugin.failed');
  expect(failed).toHaveLength(1);
  expect(failed[0]?.data).toMatchObject({ reason: REASON[kind], on_error: policy, hook: 'execution.finished', plugin: 'demo' });
  expect(typeof failed[0]?.data.invocation_id).toBe('string');
  const invoked = names(workspace, id).filter((name) => name === 'plugin.hook_invoked').length;
  expect(invoked).toBeGreaterThanOrEqual(1);
  expect(names(workspace, id)[1]).toBe('plugin.failed');
  expect(() => readFileSync(path.join(directoryOf(workspace, id), 'plugins', 'escape.md'))).toThrow();
  const stages = new SessionStore(workspace).executionSnapshots(id).map((item) => item.stageId);
  const status = statusOf(workspace, id);
  if (policy === 'ignore') {
    expect(stages).toEqual(['a', 'b']);
    expect(result.code).toBe(0);
    expect(status.status).toBe('completed');
    expect(status).not.toHaveProperty('plugin_holds');
    // Under ignore the final state equals the no-plugin baseline: the failure has no scheduling effect.
    expect(result.code).toBe(baseline.result.code);
    expect(finalPart(status)).toEqual(finalPart(baseline.status));
    return;
  }
  // Under a hold the documented differences are the status, the hold list and the scheduling stop at stage a.
  expect(status.latest_stage_id).toBe('a');
  expect(status.latest_execution_status).toBe('completed');
  expect(result.code).not.toBe(baseline.result.code);
  // The hold commits before the next scheduling pass: the pending stage never starts.
  expect(stages).toEqual(['a']);
  expect(result.code).toBe(1);
  expect(status.status).toBe(policy === 'stop' ? 'blocked' : 'active');
  expect(status.plugin_holds).toMatchObject([{ plugin: 'demo', hook: 'execution.finished', on_error: policy }]);
  if (policy === 'stop') expect(String(status.blocker)).toContain('demo');
  // Committed outcomes and every execution file survive the continue that resolves the hold (plan comment C2).
  const files = executionFiles(workspace, id);
  const outcomes = outcomesOf(workspace, id);
  const resumed = await run([plugin('demo', { 'execution.finished': () => Promise.resolve([]) })], '', { workspace, sessionId: id, responses: [DONE] });
  expect(resumed.result.code).toBe(0);
  const after = executionFiles(workspace, id);
  for (const [dir, hashes] of Object.entries(files)) expect(after[dir]).toEqual(hashes);
  for (const [dir, state] of Object.entries(outcomes)) expect(outcomesOf(workspace, id)[dir]).toBe(state);
});

test('a destination conflict under ignore records one failure and the next plugin still runs', async () => {
  const workspace = workspaceWith(entries({ aaa: '', bbb: '' }));
  WORKSPACE.current = workspace;
  const ran: string[] = [];
  const aaa = plugin('aaa', {
    'session.started': (input) => {
      mkdirSync(path.join(workspace, '.migent', 'sessions', input.session.id, 'plugins', 'aaa', 'report.md'), { recursive: true });
      return Promise.resolve([FILE_INTENT]);
    },
  });
  const bbb = plugin('bbb', { 'session.started': () => { ran.push('bbb'); return Promise.resolve([]); } });
  const { result } = await run([aaa, bbb], '', { workspace });
  expect(result.code).toBe(0);
  expect(ran).toEqual(['bbb']);
  expect(names(workspace, result.sessionId)).toEqual([
    'plugin.hook_invoked', 'plugin.failed', 'plugin.hook_invoked', 'plugin.decision',
  ]);
});

/** One slow second call keeps a sibling in flight while a hook times out. */
class SlowSecondClient extends ScriptedClient {
  public override buildCommand(input: Parameters<ScriptedClient['buildCommand']>[0]) {
    const spec = super.buildCommand(input);
    if (this.calls.length !== 2) return spec;
    return { argv: [process.execPath, '-e', 'setTimeout(() => process.stdout.write(process.argv[1]), 400)', spec.argv[3] ?? ''] };
  }
}

const hangs: PluginHandler = () => new Promise<never>(() => {});

test('a mid-run timeout under ignore records one failure, keeps files, and the remaining stage runs', async () => {
  const workspace = workspaceWith(entries({ demo: '    timeout_sec: 0.05\n' }));
  WORKSPACE.current = workspace;
  const snapshots: Snapshot[] = [];
  const { result } = await run([failingFirst(hangs, snapshots)], '', { workspace });
  const id = result.sessionId;
  const baseline = await baselineRun();
  const failed = eventsOf(workspace, id).filter((event) => event.event === 'plugin.failed');
  expect(failed).toHaveLength(1);
  expect(failed[0]?.data).toMatchObject({ reason: 'timeout', on_error: 'ignore', hook: 'execution.finished' });
  expect(names(workspace, id)[1]).toBe('plugin.failed');
  expect(new SessionStore(workspace).executionSnapshots(id).map((item) => item.stageId)).toEqual(['a', 'b']);
  expectUntouched(workspace, id, snapshots);
  const status = statusOf(workspace, id);
  expect(status).not.toHaveProperty('plugin_holds');
  expect(result.code).toBe(baseline.result.code);
  expect(finalPart(status)).toEqual(finalPart(baseline.status));
  expect(stablePart(status)).toMatchObject(stablePart(baseline.status));
});

test.each(['stop', 'fail'] as const)(
  'a timeout under %s: the in-flight sibling finishes, the pending stage never starts, files are kept',
  async (policy) => {
    const workspace = workspaceWith(entries({ demo: `    on_error: ${policy}\n    timeout_sec: 0.05\n` }), FAN);
    WORKSPACE.current = workspace;
    const snapshots: Snapshot[] = [];
    const { result } = await run([failingFirst(hangs, snapshots)], '', {
      workspace, workflow: FAN, client: new SlowSecondClient([DONE, DONE, DONE]),
    });
    const id = result.sessionId;
    const failed = eventsOf(workspace, id).filter((event) => event.event === 'plugin.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data).toMatchObject({ reason: 'timeout', on_error: policy });
    expect(new SessionStore(workspace).executionSnapshots(id).map((item) => item.stageId).sort()).toEqual(['a', 'b']);
    expect(Object.values(outcomesOf(workspace, id))).toEqual(['completed', 'completed']);
    expectUntouched(workspace, id, snapshots);
    const status = statusOf(workspace, id);
    const baseline = await baselineRun(FAN, new SlowSecondClient([DONE, DONE, DONE]));
    expect(stablePart(status)).toMatchObject(stablePart(baseline.status));
    expect(status.plugin_holds).toMatchObject([{ plugin: 'demo', hook: 'execution.finished', on_error: policy }]);
    expect(result.code).toBe(1);
    expect(result.status).toBe(policy === 'stop' ? 'blocked' : 'active');
    expect(baseline.result.code).toBe(0);
  },
);

test('the lock is held while a hook runs and its terminal record lands before release', async () => {
  const workspace = workspaceWith(entries({ demo: '    on_error: fail\n' }));
  let lockedDuring = false;
  const demo = plugin('demo', {
    'session.stopped': async (input) => {
      try {
        SessionLock.acquire(directoryOf(workspace, input.session.id)).release();
      } catch {
        lockedDuring = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error('late');
    },
  });
  const { result } = await run([demo], '', { workspace });
  const id = result.sessionId;
  expect(lockedDuring).toBe(true);
  expect(names(workspace, id).slice(-2)).toEqual(['plugin.hook_invoked', 'plugin.failed']);
  expect(statusOf(workspace, id).plugin_holds).toMatchObject([{ plugin: 'demo', hook: 'session.stopped' }]);
  // The lock is free again once the run returned.
  SessionLock.acquire(directoryOf(workspace, id)).release();
});

test('cancellation after new work still fires session.stopped, which settles as cancelled', async () => {
  const stopped: string[] = [];
  const demo = plugin('demo', {
    'execution.finished': (input) => {
      if (input.execution?.stage_id === 'a') {
        setTimeout(() => { try { raiseCancellation(2); } catch { /* the flag stays set */ } }, 0);
      }
      return Promise.resolve([]);
    },
    'session.stopped': () => { stopped.push('stopped'); return new Promise<never>(() => {}); },
  });
  try {
    const { workspace, result } = await run([demo], entries({ demo: '' }), { responses: [DONE, DONE] });
    // Cancellation is already set, so the handler is not called: the invocation settles as cancelled at once.
    expect(stopped).toEqual([]);
    const failed = eventsOf(workspace, result.sessionId).filter((event) => event.event === 'plugin.failed');
    // Every invocation queued after the cancellation settles as cancelled, the final stop trigger included.
    expect(failed.every((event) => event.data.reason === 'cancelled')).toBe(true);
    expect(failed.some((event) => event.data.hook === 'session.stopped')).toBe(true);
  } finally {
    resetCancellation();
  }
});

test('a timed-out handler later returning intents has them discarded', async () => {
  let release: (intents: PluginEventProposal[]) => void = () => {};
  const late = new Promise<PluginEventProposal[]>((resolve) => {
    release = resolve;
  });
  const demo = plugin('demo', { 'session.started': () => late });
  const started = Date.now();
  const { workspace, result } = await run([demo], entries({ demo: '    timeout_sec: 0.05\n' }));
  expect(Date.now() - started).toBeLessThan(5000);
  release([{ kind: 'artifact', name: 'late.md', content: 'x' }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(() => readFileSync(path.join(directoryOf(workspace, result.sessionId), 'plugins', 'demo', 'late.md'))).toThrow();
  expect(names(workspace, result.sessionId)).toEqual(['plugin.hook_invoked', 'plugin.failed']);
});

test('cancellation during a hook records cancelled and settles before the run returns', async () => {
  const demo = plugin('demo', {
    'session.started': () => {
      setTimeout(() => {
        try { raiseCancellation(2); } catch { /* the flag stays set */ }
      }, 10);
      return new Promise<never>(() => {});
    },
  });
  try {
    const { workspace, result } = await run([demo], entries({ demo: '' }));
    const failed = eventsOf(workspace, result.sessionId).filter((event) => event.event === 'plugin.failed');
    expect(failed[0]?.data).toMatchObject({ reason: 'cancelled', on_error: 'ignore' });
    expect(names(workspace, result.sessionId)[0]).toBe('plugin.hook_invoked');
  } finally {
    resetCancellation();
  }
});

test.each([['stop', 'blocked'], ['fail', 'active']] as const)(
  'session.stopped failing with %s ends %s with exit 1; the next continue dispatches nothing and completes',
  async (policy, status) => {
    const demo = plugin('demo', { 'session.stopped': () => Promise.reject(new Error('late')) });
    const first = await run([demo], entries({ demo: `    on_error: ${policy}\n` }));
    const id = first.result.sessionId;
    expect(first.result.code).toBe(1);
    expect(first.result.status).toBe(status);
    const second = await run([demo], '', { workspace: first.workspace, sessionId: id, responses: [] });
    expect(names(first.workspace, id).filter((name) => name === 'plugin.hook_invoked')).toHaveLength(1);
    expect(second.result.code).toBe(0);
    expect(second.result.status).toBe('completed');
  },
);

test('session.stopped fires again when a continue runs a pending stage', async () => {
  const calls: string[] = [];
  const demo = plugin('demo', {
    'execution.finished': (input) => {
      calls.push(`f:${input.execution?.stage_id}`);
      return calls.length === 1 ? Promise.reject(new Error('x')) : Promise.resolve([]);
    },
    'session.stopped': () => {
      calls.push('stopped');
      return Promise.resolve([]);
    },
  });
  const first = await run([demo], entries({ demo: '    on_error: fail\n' }), { responses: [DONE] });
  expect(first.result.code).toBe(1);
  const id = first.result.sessionId;
  await run([demo], '', { workspace: first.workspace, sessionId: id, responses: [DONE] });
  expect(calls.filter((name) => name === 'stopped')).toHaveLength(2);
  expect(calls).toContain('f:b');
});

test('an advisory plugin configured on_error stop is recorded as ignore and sets no hold', async () => {
  const note = plugin('note', { 'execution.finished': () => Promise.reject(new Error('x')) }, { advisory: true });
  const { workspace, result } = await run([note], entries({ note: '    on_error: stop\n' }));
  expect(result.code).toBe(0);
  const failed = eventsOf(workspace, result.sessionId).filter((event) => event.event === 'plugin.failed');
  expect(failed.every((event) => event.data.on_error === 'ignore')).toBe(true);
  expect(statusOf(workspace, result.sessionId)).not.toHaveProperty('plugin_holds');
});

const rewriteConfig = (workspace: string, plugins: string): void =>
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), BASE + plugins, 'utf8');

const UNAVAILABLE_CASES = [
  ['a malformed shared field', 'plugins:\n  note:\n    enabled: true\n    timeout_sec: -1\n', true],
  ['a scalar live value', 'plugins:\n  note: 5\n', true],
  ['a null live value', 'plugins:\n  note:\n', true],
  ['an entry removed from the registry', 'plugins:\n  note:\n    enabled: true\n', false],
] as const;

test.each(UNAVAILABLE_CASES)(
  'advisory %s records exactly one unavailable failure at the first trigger and the run continues',
  async (_label, config, registered) => {
    const seen: string[] = [];
    const note = plugin('note', { 'execution.finished': () => { seen.push('f'); return Promise.resolve([]); } }, { advisory: true });
    const workspace = workspaceWith(entries({ note: '' }));
    // The first run leaves stage b pending.
    const first = await run([note], '', { workspace, maxDispatches: 1, responses: [DONE] });
    const id = first.result.sessionId;
    expect(names(workspace, id)).toEqual(['plugin.hook_invoked', 'plugin.decision']);
    rewriteConfig(workspace, config);
    const resumed = await run(registered ? [note] : [], '', { workspace, sessionId: id, responses: [DONE] });
    expect(resumed.result.code).toBe(0);
    expect(resumed.result.status).toBe('completed');
    const failed = eventsOf(workspace, id).filter((event) => event.event === 'plugin.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data).toMatchObject({ plugin: 'note', reason: 'unavailable', on_error: 'ignore', invocation_id: null });
    expect(statusOf(workspace, id)).not.toHaveProperty('plugin_holds');
    expect(new SessionStore(workspace).executionSnapshots(id).map((item) => item.stageId)).toEqual(['a', 'b']);
    expect(seen).toEqual(['f']);
  },
);

test('a resume with no work and an unavailable advisory entry dispatches nothing and does not replay hooks', async () => {
  const note = plugin('note', { 'session.started': () => Promise.resolve([]) }, { advisory: true });
  const workspace = workspaceWith(entries({ note: '' }));
  const first = await run([note], '', { workspace });
  const resumed = await run([], '', { workspace, sessionId: first.result.sessionId, responses: [] });
  expect(resumed.result.code).toBe(0);
  expect(names(workspace, first.result.sessionId)).toEqual(['plugin.hook_invoked', 'plugin.decision']);
});

test('one plugin failing does not skip another of the same trigger, in plugin-id order', async () => {
  const order: string[] = [];
  const a = plugin('aaa', { 'session.started': () => { order.push('aaa'); return Promise.reject(new Error('x')); } });
  const b = plugin('bbb', { 'session.started': () => { order.push('bbb'); return Promise.resolve([]); } });
  const { workspace, result } = await run([b, a], entries({ aaa: '', bbb: '' }));
  expect(order).toEqual(['aaa', 'bbb']);
  expect(names(workspace, result.sessionId)).toEqual([
    'plugin.hook_invoked', 'plugin.failed', 'plugin.hook_invoked', 'plugin.decision',
  ]);
});

test('hooks are not replayed on resume', async () => {
  let started = 0;
  const demo = plugin('demo', { 'session.started': () => { started += 1; return Promise.resolve([]); } });
  const first = await (async () => {
    const workspace = workspaceWith(entries({ demo: '' }));
    const runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient([DONE, DONE]) }), 10);
    runner.pluginRegistry = registryOfPlugins(demo);
    const result = await executeNamedWorkflow(workspace, { workflowId: 'chain', task: 'go', maxDispatches: 1 }, runner);
    return { workspace, result };
  })();
  expect(started).toBe(1);
  await run([demo], '', { workspace: first.workspace, sessionId: first.result.sessionId, responses: [DONE] });
  expect(started).toBe(1);
  expect(names(first.workspace, first.result.sessionId).filter((name) => name === 'plugin.hook_invoked')).toHaveLength(1);
});

test('HookInput is detached, deeply frozen plain data', async () => {
  let captured: unknown = null;
  const demo = plugin('demo', {
    'execution.finished': (input) => {
      captured = input;
      return Promise.resolve([]);
    },
  });
  await run([demo], entries({ demo: '' }));
  const input = captured as { session: { status: Record<string, unknown> }; plugin: { config: unknown } };
  expect(Object.isFrozen(input)).toBe(true);
  expect(Object.isFrozen(input.session.status)).toBe(true);
  expect(Object.isFrozen(input.plugin.config)).toBe(true);
  expect(JSON.parse(JSON.stringify(input))).toEqual(input);
  expect(() => { (input.session as { id: string }).id = 'x'; }).toThrow();
});

test('output names must be one safe path segment', () => {
  expect(['a.md', 'a_b-1.txt'].every(isSafeOutputName)).toBe(true);
  expect(['../a', 'a/b', '.hidden', '', 'a..b', 'a\\b'].some(isSafeOutputName)).toBe(false);
});
