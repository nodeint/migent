import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type {
  Plugin, PluginCallContext, PluginHandler, PluginInterceptor, PluginRegistry, PluginUses, TSchema,
} from '@nodeint/migent-contracts';
import { PluginContextClosed } from '@nodeint/migent-contracts';
import type { BuildCommandInput, CommandSpec } from '@nodeint/migent-kernel';
import { utcNow } from '@nodeint/migent-kernel';
import { readParsedEvents, readPluginsInspection, resumeFacts, sessionEventLog } from '@nodeint/migent-session';
import { afterEach, expect, test } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { buildCallContext } from '../src/plugin-host/context.ts';
import { HostInterceptorChain } from '../src/plugin-host/interception.ts';
import { InvocationState } from '../src/plugin-host/invocation.ts';
import { registryOf, ScriptedClient, tempDir as makeTempDir } from './support.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const root = makeTempDir(prefix);
  roots.push(root);
  return root;
}

const schema = { type: 'object' } as unknown as TSchema;
const DONE = 'status: complete\n\ndone';
const BASE = 'agents:\n  fake:\n    client: { type: fake }\n    model: m1\nroles:\n  developer:\n    agent: fake\n';
const ONE = 'schema_version: 2\nid: chain\nstages:\n  - id: a\n    role: developer\n';
const USES: PluginUses = {
  operations: [{ target: 'agent.turn', phases: ['before', 'after'] }],
  events: ['session.started'],
  session: ['snapshot', 'resume_facts'],
  artifacts: [{ name: 'report.md', mode: 'replace', media_type: 'text/markdown', fresh: true }],
  agents: false,
  config: [],
};

const plugin = (activate: Plugin['activate']): Plugin => ({
  manifest: { id: 'demo', version: '1.0.0', apiVersion: { major: 1, minor: 0 }, advisory: false, configSchema: schema, uses: USES },
  activate,
});
const intercepting = (interceptor: PluginInterceptor): Plugin =>
  plugin((_options, migent) => { migent.operations.intercept('agent.turn', interceptor); });
const registryOfPlugins = (...plugins: Plugin[]): PluginRegistry => ({
  ids: () => plugins.map((entry) => entry.manifest.id),
  get: (id) => plugins.find((entry) => entry.manifest.id === id),
});

const sessionsOf = (workspace: string): string => path.join(workspace, '.migent', 'sessions');
const directoryOf = (workspace: string): string =>
  path.join(sessionsOf(workspace), readdirSync(sessionsOf(workspace)).find((name) => /^\d+$/.test(name)) ?? '');

/** Appends a non-plugin event, as another stage finishing would. */
function appendEvent(workspace: string): void {
  const directory = directoryOf(workspace);
  sessionEventLog.record(directory, { event: 'baseline.captured', timestamp: utcNow(), data: { commit: null, error: null } });
  sessionEventLog.commit(workspace, directory);
}

/** Changes a fact `resumeFacts` returns for the running execution. */
function changeFacts(workspace: string, tick: number): void {
  const executions = path.join(directoryOf(workspace), 'executions');
  const id = readdirSync(executions)[0] ?? '';
  const file = path.join(executions, id, 'execution.json');
  const row = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...row, completed_at: `2026-10-20T00:00:0${tick}.000+00:00` }), 'utf8');
}
const executionId = (workspace: string): string =>
  readdirSync(path.join(directoryOf(workspace), 'executions'))[0] ?? '';

async function run(plugins: Plugin[], workspace: string, options: { agent?: boolean; client?: ScriptedClient } = {}) {
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), `${BASE}plugins:\n  demo:\n    enabled: true\n${options.agent === true ? '    agent: fake\n' : ''}`, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'chain.yaml'), ONE, 'utf8');
  const client = options.client ?? new ScriptedClient([DONE, DONE]);
  const runner = new AgentToolRunner(registryOf({ fake: client }), 10);
  runner.pluginRegistry = registryOfPlugins(...plugins);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'chain', task: 'go' }, runner);
  const events = readParsedEvents(path.join(workspace, '.migent', 'sessions', result.sessionId, 'events.jsonl'))
    .filter((event) => event.event.startsWith('plugin.'));
  const all = readParsedEvents(path.join(workspace, '.migent', 'sessions', result.sessionId, 'events.jsonl'));
  return { client, result, events, workspace, all };
}
const failures = (events: { event: string; data: Record<string, unknown> }[]): unknown[] =>
  events.filter((event) => event.event === 'plugin.failed').map((event) => event.data.reason);

test('a resumeFacts reader re-runs once when its execution facts change, and the provider gets the re-run prompt', async () => {
  const workspace = tempDir('migent-freshness-');
  let calls = 0;
  const demo = intercepting({
    before: async (request, call) => {
      calls += 1;
      await call.session.resumeFacts(executionId(workspace));
      if (calls === 1) changeFacts(workspace, 1);
      return { kind: 'patch', fields: { prompt: `RUN${calls} ${String(request.prompt)}` } };
    },
  });
  const { client, result } = await run([demo], workspace);
  expect(result.code).toBe(0);
  expect(calls).toBe(2);
  expect(client.calls[0]?.prompt).toMatch(/^RUN2 /);
});

test('a change to another execution causes no re-run', async () => {
  const workspace = tempDir('migent-freshness-');
  let calls = 0;
  const demo = intercepting({
    before: async (_request, call) => {
      calls += 1;
      await call.session.resumeFacts('some-other-execution');
      changeFacts(workspace, 1);
      return { kind: 'continue' };
    },
  });
  const { events } = await run([demo], workspace);
  expect(calls).toBe(1);
  expect(failures(events)).toEqual([]);
});

test('a snapshot reader re-runs when another stage appends an event', async () => {
  const workspace = tempDir('migent-freshness-');
  let calls = 0;
  const demo = intercepting({
    before: async (request, call) => {
      calls += 1;
      await call.session.snapshot();
      if (calls === 1) appendEvent(workspace);
      return { kind: 'patch', fields: { prompt: `SNAP${calls} ${String(request.prompt)}` } };
    },
  });
  const { client } = await run([demo], workspace);
  expect(calls).toBe(2);
  expect(client.calls[0]?.prompt).toMatch(/^SNAP2 /);
});

test('a prompt patch that reads nothing is never re-run', async () => {
  const workspace = tempDir('migent-freshness-');
  let calls = 0;
  const demo = intercepting({
    before: async (request) => {
      calls += 1;
      appendEvent(workspace);
      changeFacts(workspace, 2);
      return { kind: 'patch', fields: { prompt: `PLAIN ${String(request.prompt)}` } };
    },
  });
  const { client, events } = await run([demo], workspace);
  expect(calls).toBe(1);
  expect(client.calls[0]?.prompt).toMatch(/^PLAIN /);
  expect(failures(events)).toEqual([]);
});

test('a second change records stale and the value continues unmodified', async () => {
  const workspace = tempDir('migent-freshness-');
  let calls = 0;
  const demo = intercepting({
    before: async (request, call) => {
      calls += 1;
      await call.session.snapshot();
      appendEvent(workspace);
      return { kind: 'patch', fields: { prompt: `NEVER ${String(request.prompt)}` } };
    },
  });
  const { client, events, result } = await run([demo], workspace);
  expect(result.code).toBe(0);
  expect(calls).toBe(2);
  expect(client.calls[0]?.prompt).not.toContain('NEVER');
  expect(failures(events)).toEqual(['stale']);
});

test('one retry covers the before and after passes of a cycle together', async () => {
  const workspace = tempDir('migent-freshness-');
  const calls = { before: 0, after: 0 };
  const demo = intercepting({
    before: async (_request, call) => {
      calls.before += 1;
      await call.session.snapshot();
      if (calls.before === 1) appendEvent(workspace);
      return { kind: 'continue' };
    },
    after: async (_outcome, call) => {
      calls.after += 1;
      await call.session.snapshot();
      appendEvent(workspace);
      return { kind: 'continue' };
    },
  });
  const { events } = await run([demo], workspace);
  expect(calls.before).toBe(2);
  // The cycle's single retry is spent, so the after pass is not run again.
  expect(calls.after).toBe(1);
  expect(failures(events)).toEqual(['stale']);
});

const startedHandler = (workspace: string, state: { calls: number }, always: boolean): PluginHandler =>
  async (_input, call) => {
  state.calls += 1;
  if (state.calls === 1 || always) appendEvent(workspace);
  return [call.artifacts.propose('report.md', `body${state.calls}`)];
};
const handlerPlugin = (handler: PluginHandler): Plugin =>
  plugin((_options, migent) => { migent.events.on('session.started', handler); });
const reportOf = (workspace: string): string =>
  readFileSync(path.join(directoryOf(workspace), 'plugins', 'demo', 'report.md'), 'utf8');

test('a fresh artifact re-runs once when an event is appended after its start', async () => {
  const workspace = tempDir('migent-freshness-');
  const state = { calls: 0 };
  const { events } = await run([handlerPlugin(startedHandler(workspace, state, false))], workspace);
  expect(state.calls).toBe(2);
  expect(reportOf(workspace)).toBe('body2');
  expect(failures(events)).toEqual([]);
});

test('a fresh artifact that is stale twice records stale and writes nothing', async () => {
  const workspace = tempDir('migent-freshness-');
  const state = { calls: 0 };
  const { events } = await run([handlerPlugin(startedHandler(workspace, state, true))], workspace);
  expect(state.calls).toBe(2);
  expect(failures(events)).toEqual(['stale']);
  expect(() => reportOf(workspace)).toThrow();
});

test('session reads after settlement reject without reading', async () => {
  const demo = intercepting({});
  let reads = 0;
  const reading = {
    snapshot: () => { reads += 1; throw new Error('read'); },
    resumeFacts: () => { reads += 1; throw new Error('read'); },
    artifacts: () => { reads += 1; throw new Error('read'); },
    basis: () => null,
  };
  const invocation = new InvocationState();
  const call: PluginCallContext = buildCallContext(
    {
      manifest: { ...demo.manifest, uses: { ...USES, session: ['snapshot', 'resume_facts', 'artifacts'] } },
      options: {}, readCore: () => undefined, reads: reading as never,
    },
    invocation, null,
  );
  invocation.close();
  await expect(call.session.snapshot()).rejects.toBeInstanceOf(PluginContextClosed);
  await expect(call.session.resumeFacts('e1')).rejects.toBeInstanceOf(PluginContextClosed);
  await expect(call.session.artifacts()).rejects.toBeInstanceOf(PluginContextClosed);
  expect(reads).toBe(0);
});

test('an undeclared session read is refused', async () => {
  const demo = intercepting({});
  const manifest = { ...demo.manifest, uses: { ...USES, session: [] } };
  const call = buildCallContext({ manifest, options: {}, readCore: () => undefined }, new InvocationState(), null);
  await expect(call.session.snapshot()).rejects.toThrow(/uses.session/);
  await expect(call.session.artifacts()).rejects.toThrow(/uses.session/);
});

function chainWith(host: { invokeInterceptor: unknown; reportStale: unknown }): HostInterceptorChain {
  const interceptor: PluginInterceptor = { before: async () => ({ kind: 'continue' }) };
  const entry: ConstructorParameters<typeof HostInterceptorChain>[0][number] = {
    plugin: { id: 'demo' } as unknown as ConstructorParameters<typeof HostInterceptorChain>[0][number]['plugin'],
    registrations: [{ target: 'op.x', interceptor }],
  };
  return new HostInterceptorChain([entry], host as never);
}

function operationPass(moves: (run: number) => boolean) {
  let runs = 0;
  let fingerprint = 0;
  const stale: string[] = [];
  const chain = chainWith({
    invokeInterceptor: async () => {
      runs += 1;
      if (moves(runs)) fingerprint += 1;
      return { value: { value: { n: runs }, shortCircuit: false }, invocationId: `i${runs}`, calls: [], notes: [], evidence: [], commit: () => undefined };
    },
    reportStale: (_plugin: unknown, at: { hook: string }) => { stale.push(at.hook); },
  });
  let used = false;
  const result = chain.run({
    phase: 'before', scope: { sessionId: 's', stageId: 'st', role: 'r' }, identity: { executionId: 'e', operationId: 'op.x', attempt: 1 },
    value: { n: 0 }, retry: { take: () => !used && (used = true) }, fingerprint: () => ({ fingerprint }),
    judge: () => ({ kind: 'rejected', reason: 'unused' }),
  });
  return { result, runs: () => runs, stale };
}

test('an operation evidence change gives one re-run, and a second change gives stale with the value unmodified', async () => {
  const once = operationPass((run) => run === 1);
  expect(await once.result).toEqual({ value: { n: 2 }, shortCircuit: false });
  expect(once.runs()).toBe(2);
  expect(once.stale).toEqual([]);

  const twice = operationPass(() => true);
  expect(await twice.result).toEqual({ value: { n: 0 }, shortCircuit: false });
  expect(twice.runs()).toBe(2);
  expect(twice.stale).toEqual(['operation:op.x:before']);
});

test('call.session.resumeFacts matches the session resumeFacts', async () => {
  const workspace = tempDir('migent-freshness-');
  const pairs: { viaCall: unknown; direct: unknown }[] = [];
  const clients = registryOf({ fake: new ScriptedClient([]) });
  const demo = intercepting({
    after: async (_outcome, call) => {
      const viaCall = await call.session.resumeFacts(executionId(workspace));
      const direct = resumeFacts(workspace, { sessionId: '1', executionId: executionId(workspace) }, clients);
      pairs.push({ viaCall, direct: JSON.parse(JSON.stringify(direct)) });
      return { kind: 'continue' };
    },
  });
  await run([demo], workspace);
  expect(pairs.length).toBeGreaterThan(0);
  for (const pair of pairs) expect(pair.viaCall).toEqual(pair.direct);
});

type Recorded = { event: string; data: Record<string, unknown> };
const decisions = (events: Recorded[]): Recorded[] => events.filter((event) => event.event === 'plugin.decision');

test('a retried pass records no applied decision for the discarded run, and a successful retry applies once', async () => {
  const workspace = tempDir('migent-freshness-');
  let calls = 0;
  const demo = intercepting({
    before: async (request, call) => {
      calls += 1;
      await call.session.snapshot();
      if (calls === 1) appendEvent(workspace);
      return { kind: 'patch', fields: { prompt: `P${calls} ${String(request.prompt)}` } };
    },
  });
  const { events } = await run([demo], workspace);
  const [first, second] = decisions(events);
  expect(first?.data.results).toEqual([{ kind: 'patch', status: 'rejected', reason: 'stale' }]);
  expect(second?.data.results).toEqual([{ kind: 'patch', status: 'applied' }]);
  expect(failures(events)).toEqual([]);
});

test('an exhausted retry applies nothing and ties each stale failure to its invocation', async () => {
  const workspace = tempDir('migent-freshness-');
  const demo = intercepting({
    before: async (request, call) => {
      await call.session.snapshot();
      appendEvent(workspace);
      return { kind: 'patch', fields: { prompt: `NEVER ${String(request.prompt)}` } };
    },
  });
  const { events } = await run([demo], workspace);
  const applied = decisions(events).flatMap((event) => event.data.results as { status: string }[])
    .filter((result) => result.status === 'applied');
  expect(applied).toEqual([]);
  const stale = events.find((event) => event.event === 'plugin.failed');
  expect(typeof stale?.data.invocation_id).toBe('string');
  const invoked = events.filter((event) => event.event === 'plugin.hook_invoked').map((event) => event.data.invocation_id);
  expect(invoked).toContain(stale?.data.invocation_id);
});

test('an earlier interceptor whose patch is discarded because a later one is stale applies nothing', async () => {
  const workspace = tempDir('migent-freshness-');
  const early = intercepting({ before: (request) => Promise.resolve({ kind: 'patch', fields: { prompt: `EARLY ${String(request.prompt)}` } }) });
  const base = intercepting({
    before: async (_request, call) => {
      await call.session.snapshot();
      appendEvent(workspace);
      return { kind: 'continue' };
    },
  });
  const late: Plugin = { ...base, manifest: { ...base.manifest, id: 'late' } };
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), `${BASE}plugins:\n  demo:\n    enabled: true\n  late:\n    enabled: true\n`, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'chain.yaml'), ONE, 'utf8');
  const client = new ScriptedClient([DONE, DONE]);
  const runner = new AgentToolRunner(registryOf({ fake: client }), 10);
  runner.pluginRegistry = registryOfPlugins(early, late);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'chain', task: 'go' }, runner);
  const events = readParsedEvents(path.join(workspace, '.migent', 'sessions', result.sessionId, 'events.jsonl'))
    .filter((event) => event.event.startsWith('plugin.'));
  const applied = decisions(events).flatMap((event) => event.data.results as { status: string }[])
    .filter((item) => item.status === 'applied');
  expect(applied).toEqual([]);
  expect(client.calls[0]?.prompt).not.toContain('EARLY');
});

/** Answers prompts that start with `PLUGIN` with `plugin-answer:<tag>`, and everything else as a stage turn. */
class EchoClient extends ScriptedClient {
  constructor() { super([DONE, DONE]); }

  override buildCommand(input: BuildCommandInput): CommandSpec {
    if (!input.prompt.startsWith('PLUGIN')) return super.buildCommand(input);
    const [tag] = input.prompt.slice('PLUGIN '.length).split(/\s/);
    return { argv: [process.execPath, '-e', `process.stdout.write('plugin-answer:${tag}')`] };
  }

  override parseResponse(stdout: string): [string, string | null] {
    if (stdout.startsWith('plugin-answer:')) return [stdout, null];
    return super.parseResponse();
  }
}

const withAgents = (handler: PluginHandler): Plugin => {
  const base = handlerPlugin(handler);
  const artifacts = USES.artifacts.map((claim) => ({ ...claim, fresh: false }));
  return { ...base, manifest: { ...base.manifest, uses: { ...USES, artifacts, agents: true } } };
};

test('a retried handler keeps both attempts agent calls, with distinct files and original contents', async () => {
  const workspace = tempDir('migent-freshness-');
  let attempt = 0;
  const demo = withAgents(async (_input, call) => {
    attempt += 1;
    if (attempt === 1) await call.session.snapshot();
    await call.agents.invoke(`PLUGIN t${attempt}`);
    if (attempt === 1) appendEvent(workspace);
    return [call.artifacts.propose('report.md', `body${attempt}`)];
  });
  const { events, result } = await run([demo], workspace, { agent: true, client: new EchoClient() });
  const [decision] = decisions(events);
  const recorded = decision?.data.agent_calls as { index: number; output_path: string }[];
  expect(recorded.map((item) => item.index)).toEqual([1, 2]);
  expect(new Set(recorded.map((item) => item.output_path)).size).toBe(2);
  const directory = path.join(workspace, '.migent', 'sessions', result.sessionId);
  expect(recorded.map((item) => readFileSync(path.join(directory, item.output_path), 'utf8')))
    .toEqual(['plugin-answer:t1', 'plugin-answer:t2']);
});

test('an exhausted handler keeps every started call in the stale failure', async () => {
  const workspace = tempDir('migent-freshness-');
  let attempt = 0;
  const demo = withAgents(async (_input, call) => {
    attempt += 1;
    await call.session.snapshot();
    await call.agents.invoke(`PLUGIN t${attempt}`);
    appendEvent(workspace);
    return [call.artifacts.propose('report.md', 'x')];
  });
  const { events } = await run([demo], workspace, { agent: true, client: new EchoClient() });
  const failed = events.find((event) => event.event === 'plugin.failed');
  expect(failed?.data.reason).toBe('stale');
  expect((failed?.data.agent_calls as { index: number }[]).map((item) => item.index)).toEqual([1, 2]);
});

test('an invalid result is invalid_intent: no retry, no write, and the retry budget stays for the next handler', async () => {
  const workspace = tempDir('migent-freshness-');
  const state = { invalid: 0, valid: 0 };
  const demo = plugin((_options, migent) => {
    migent.events.on('session.started', async (_input, call) => {
      state.invalid += 1;
      appendEvent(workspace);
      return [call.artifacts.propose('report.md', 'a'), call.artifacts.propose('report.md', 'b')];
    });
    migent.events.on('session.started', async (_input, call) => {
      state.valid += 1;
      if (state.valid === 1) appendEvent(workspace);
      return [call.artifacts.propose('report.md', `ok${state.valid}`)];
    });
  });
  const { events } = await run([demo], workspace);
  expect(state).toEqual({ invalid: 1, valid: 2 });
  expect(failures(events)).toEqual(['invalid_intent']);
  expect(reportOf(workspace)).toBe('ok2');
});

test('an agent-using interceptor that exhausts freshness keeps its calls on the stale failure and in inspection', async () => {
  const workspace = tempDir('migent-freshness-');
  const base = intercepting({
    before: async (request, call) => {
      await call.session.snapshot();
      await call.agents.invoke('PLUGIN q');
      appendEvent(workspace);
      return { kind: 'patch', fields: { prompt: `NEVER ${String(request.prompt)}` } };
    },
  });
  const demo: Plugin = { ...base, manifest: { ...base.manifest, uses: { ...USES, agents: true } } };
  const { events, result } = await run([demo], workspace, { agent: true, client: new EchoClient() });
  const failed = events.find((event) => event.event === 'plugin.failed');
  expect(failed?.data.reason).toBe('stale');
  expect((failed?.data.agent_calls as unknown[]).length).toBe(1);
  const inspection = readPluginsInspection(path.join(workspace, '.migent', 'sessions', result.sessionId));
  const row = inspection?.invocations.find((item) => item.invocation_id === failed?.data.invocation_id);
  expect(row?.status).toBe('failed');
  expect(row?.agent_calls).toBe(1);
});

const withArtifacts = (apiVersion: { major: number; minor: number }, activate: Plugin['activate']): Plugin => {
  const base = plugin(activate);
  return { ...base, manifest: { ...base.manifest, apiVersion, uses: { ...USES, session: ['snapshot', 'artifacts'] } } };
};

test('an artifacts read is evidence at the current basis seq: it re-runs once when another event is appended', async () => {
  const workspace = tempDir('migent-freshness-');
  let calls = 0;
  const demo = withArtifacts({ major: 1, minor: 3 }, (_options, migent) => {
    migent.operations.intercept('agent.turn', {
      before: async (request, call) => {
        calls += 1;
        const read = await call.session.artifacts();
        expect(Object.isFrozen(read)).toBe(true);
        if (calls === 1) appendEvent(workspace);
        return { kind: 'patch', fields: { prompt: `ART${calls} ${String(request.prompt)}` } };
      },
    });
  });
  const { client, result } = await run([demo], workspace);
  expect(result.code).toBe(0);
  expect(calls).toBe(2);
  expect(client.calls[0]?.prompt).toMatch(/^ART2 /);
});

test('an API 1.3 manifest is accepted, and a minor above 3 is not', async () => {
  const { isSupportedPluginApiVersion } = await import('@nodeint/migent-contracts');
  expect(isSupportedPluginApiVersion({ major: 1, minor: 3 })).toBe(true);
  expect(isSupportedPluginApiVersion({ major: 1, minor: 4 })).toBe(false);
});
