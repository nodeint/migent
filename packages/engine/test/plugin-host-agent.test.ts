import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Plugin, PluginHandler, PluginHook, PluginRegistry, TSchema } from '@nodeint/migent-contracts';
import type { BuildCommandInput, CommandSpec } from '@nodeint/migent-kernel';
import { raiseCancellation, resetCancellation } from '@nodeint/migent-kernel';
import { readParsedEvents, SessionLock, subscribeSessionEvents } from '@nodeint/migent-session';
import { expect, test } from 'vitest';

import { bindTarget } from '../src/agent-invocation.ts';
import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { AgentCaller } from '../src/plugin-host/agent-call.ts';
import { PluginHost } from '../src/plugin-host/dispatch.ts';
import { FakeClient, registryOf, ScriptedClient, tempDir } from './support.ts';

const schema = { type: 'object' } as unknown as TSchema;
const DONE = 'status: complete\n\ndone';
const CHAIN = 'schema_version: 2\nid: chain\nstages:\n  - id: a\n    role: developer\n  - id: b\n    role: developer\n    depends_on: [a]\n';
const BASE = 'agents:\n  fake:\n    client: { type: fake }\n    model: m1\n  other:\n    client: { type: fake }\n    model: m2\nroles:\n  developer:\n    agent: fake\n';

const llm = (id: string, handlers: Partial<Record<PluginHook, PluginHandler>>, extra: Partial<Plugin['manifest']> = {}): Plugin => ({
  manifest: {
    id, version: '1.0.0', advisory: false, hooks: Object.keys(handlers) as PluginHook[], capabilities: ['invokeAgent'], configSchema: schema, ...extra,
  },
  handlers,
});
const registryOfPlugins = (...plugins: Plugin[]): PluginRegistry => ({
  ids: () => plugins.map((entry) => entry.manifest.id),
  get: (id) => plugins.find((entry) => entry.manifest.id === id),
});

function workspaceWith(plugins: string): string {
  const workspace = tempDir('migent-plugin-agent-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), BASE + plugins, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'chain.yaml'), CHAIN, 'utf8');
  return workspace;
}
const entry = (body = '', agent = 'fake'): string => `plugins:\n  demo:\n    enabled: true\n    agent: ${agent}\n${body}`;
const directoryOf = (workspace: string, id: string): string => path.join(workspace, '.migent', 'sessions', id);
const eventsOf = (workspace: string, id: string) => readParsedEvents(path.join(directoryOf(workspace, id), 'events.jsonl'));
const statusOf = (workspace: string, id: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(directoryOf(workspace, id), 'status.json'), 'utf8')) as Record<string, unknown>;

/** Serves prompts that start with `plugin:` by hanging, and everything else as a normal stage turn. */
class HangingClient extends ScriptedClient {
  public readonly pids: string[] = [];
  constructor(private readonly pidFile: string, private readonly mode: 'hang' | 'fail' | 'ok' | 'echo' | 'throw') {
    super([DONE, DONE]);
  }

  override buildCommand(input: BuildCommandInput): CommandSpec {
    if (!input.prompt.startsWith('PLUGIN')) return super.buildCommand(input);
    this.calls.push({
      model: input.model, workspace: input.workspace, prompt: input.prompt, agentId: input.agentId,
      newAgentId: input.newAgentId, promptFile: input.promptFile, options: { ...input.options },
    });
    if (this.mode === 'hang') {
      const code = `require('fs').writeFileSync(${JSON.stringify(this.pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
      return { argv: [process.execPath, '-e', code] };
    }
    if (this.mode === 'throw') throw new Error('provider build failed');
    if (this.mode === 'echo') {
      const [tag] = input.prompt.slice('PLUGIN '.length).split(/\s/);
      return { argv: [process.execPath, '-e', `process.stdout.write('plugin-answer:${tag}')`] };
    }
    if (this.mode === 'fail') return { argv: [process.execPath, '-e', "process.stdout.write('plugin-answer'); process.exit(3)"] };
    return { argv: [process.execPath, '-e', "process.stdout.write(JSON.stringify({ text: 'plugin-answer', sessionId: 'x', call: 0 }))"] };
  }

  override parseResponse(stdout: string): [string, string | null] {
    // Concurrent stage turns make `calls.at(-1)` unreliable, so the payload itself marks a plugin turn.
    if (stdout.includes('plugin-answer')) return [stdout.startsWith('plugin-answer:') ? stdout : 'plugin-answer', null];
    return super.parseResponse();
  }
}

const workspaceRef = { path: '' };

async function run(plugin: Plugin, config: string, client: FakeClient, existing?: string) {
  const workspace = existing ?? workspaceWith(config);
  const runner = new AgentToolRunner(registryOf({ fake: client }), 10);
  runner.pluginRegistry = registryOfPlugins(plugin);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'chain', task: 'go' }, runner);
  return { workspace, result, runner };
}

/** Hash of every file under each execution directory. */
function executionFiles(workspace: string, id: string): Record<string, string> {
  const root = path.join(directoryOf(workspace, id), 'executions');
  const out: Record<string, string> = {};
  const walk = (directory: string, base: string): void => {
    for (const name of readdirSync(directory)) {
      const full = path.join(directory, name);
      if (statSync(full).isDirectory()) walk(full, `${base}${name}/`);
      else out[`${base}${name}`] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  if (existsSync(root)) walk(root, '');
  return out;
}

const filesUnder = (workspace: string, id: string, prefix: string): Record<string, string> =>
  Object.fromEntries(Object.entries(executionFiles(workspace, id)).filter(([name]) => name.startsWith(prefix)));

/** At the moment `plugin.failed` is committed: is the provider stopped, and is the session lock still held? */
interface FailedCommitWatch { stopped: boolean[]; locked: boolean[]; off: () => void }
function watchFailedCommit(workspace: string, pidFile: string): FailedCommitWatch {
  const seen = { stopped: [] as boolean[], locked: [] as boolean[] };
  const off = subscribeSessionEvents((id, record) => {
    if (record.event !== 'plugin.failed') return;
    seen.stopped.push(!alive(Number(readFileSync(pidFile, 'utf8'))));
    seen.locked.push(existsSync(path.join(directoryOf(workspace, id), 'session.lock')));
  });
  return { ...seen, off };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a call runs one turn through the runtime: agent_calls, stored raw output, and only { text, error } returned', async () => {
  const client = new HangingClient('', 'ok');
  let seen: unknown;
  const demo = llm('demo', {
    'session.started': async (_input, caps) => {
      seen = await caps.invokeAgent?.('PLUGIN hello');
      return [];
    },
  });
  const { workspace, result } = await run(demo, entry('    description: Be brief\n    responsibilities: [check]\n'), client);
  expect(result.code).toBe(0);
  expect(seen).toEqual({ text: 'plugin-answer', error: null });
  const call = client.calls.find((item) => item.prompt.startsWith('PLUGIN'));
  expect(call).toMatchObject({ model: 'm1', agentId: null });
  expect(call?.prompt).toContain('Description: Be brief');
  expect(call?.prompt).toContain('- check');
  const decision = eventsOf(workspace, result.sessionId).find((event) => event.event === 'plugin.decision');
  const calls = decision?.data.agent_calls as { output_path: string }[];
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ index: 1, client: 'fake', model: 'm1', outcome: 'succeeded', exit_code: 0 });
  expect(readFileSync(path.join(directoryOf(workspace, result.sessionId), calls[0]?.output_path ?? ''), 'utf8')).toContain('plugin-answer');
  expect(calls[0]?.output_path).toMatch(/^plugins\/demo\/calls\/.+-1\.txt$/);
}, 30_000);

test('a denying policy gives a denied outcome and starts no provider', async () => {
  const client = new FakeClient();
  const dir = tempDir('migent-agent-deny-');
  const caller = new AgentCaller({
    workspace: dir, sessionId: 's', sessionDirectory: dir, pluginId: 'demo', invocationId: 'inv', stageId: '',
    bind: () => bindTarget({ client: 'fake', model: 'm', options: {} }, registryOf({ fake: client })),
    deadlineAt: Date.now() + 10_000, signal: new AbortController().signal,
    policy: { evaluate: () => ({ kind: 'deny', reason: 'no' }) },
  });
  expect(await caller.invokeAgent('hi')).toEqual({ text: null, error: 'no' });
  expect(client.calls).toHaveLength(0);
  expect(caller.calls).toMatchObject([{ outcome: 'denied', output_path: null }]);
});

test('invokeAgent is offered only when declared and the config has an agent', async () => {
  const client = new HangingClient('', 'ok');
  const offered: Record<string, boolean> = {};
  const probe: PluginHandler = (_input, caps) => {
    offered.invoke = caps.invokeAgent !== undefined;
    return Promise.resolve([]);
  };
  await run(llm('demo', { 'session.started': probe }, { capabilities: [] }), entry(), client);
  expect(offered.invoke).toBe(false);
  await run(llm('demo', { 'session.started': probe }), entry(), client);
  expect(offered.invoke).toBe(true);
});

test('a frozen target survives a live agents edit', async () => {
  const client = new HangingClient('', 'ok');
  const workspace = workspaceWith(entry('', 'fake'));
  const runner = new AgentToolRunner(registryOf({ fake: client }), 10);
  const demo = llm('demo', {
    'execution.finished': async (_input, caps) => {
      await caps.invokeAgent?.('PLUGIN again');
      return [];
    },
  });
  runner.pluginRegistry = registryOfPlugins(demo);
  const first = await executeNamedWorkflow(workspace, { workflowId: 'chain', task: 'go', maxDispatches: 1 }, runner);
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), BASE.replace('model: m1', 'model: changed') + entry(), 'utf8');
  await executeNamedWorkflow(workspace, { workflowId: 'chain', sessionId: first.sessionId }, runner);
  const models = client.calls.filter((item) => item.prompt.startsWith('PLUGIN')).map((item) => item.model);
  expect(models).toEqual(['m1', 'm1']);
}, 30_000);

test('an advisory plugin resolves the live target at the call; failure is unavailable', async () => {
  const client = new HangingClient('', 'ok');
  const demo = llm('demo', {
    'session.started': async (_input, caps) => {
      await caps.invokeAgent?.('PLUGIN x');
      return [];
    },
  }, { advisory: true });
  const { workspace, result } = await run(demo, entry(), client);
  expect(client.calls.find((item) => item.prompt.startsWith('PLUGIN'))?.model).toBe('m1');
  expect(eventsOf(workspace, result.sessionId).some((event) => event.event === 'plugin.decision')).toBe(true);

  const broken = new HangingClient('', 'ok');
  const bad = llm('demo', {
    'session.started': async (_input, caps) => {
      await caps.invokeAgent?.('PLUGIN x');
      return [];
    },
    'execution.finished': () => Promise.resolve([]),
  }, { advisory: true });
  const workspace2 = workspaceWith(entry());
  const runner = new AgentToolRunner(registryOf({ fake: broken }), 10);
  runner.pluginRegistry = registryOfPlugins(bad);
  const created = await executeNamedWorkflow(workspace2, { workflowId: 'chain', task: 'go', maxDispatches: 1 }, runner);
  writeFileSync(path.join(workspace2, '.migent', 'config.yaml'), BASE + entry('', 'missing'), 'utf8');
  await executeNamedWorkflow(workspace2, { workflowId: 'chain', sessionId: created.sessionId }, runner);
  expect(eventsOf(workspace2, created.sessionId).filter((event) => event.event === 'plugin.failed').some((event) => event.data.reason === 'unavailable')).toBe(true);
}, 30_000);

test('a timeout stops the provider before plugin.failed, and a later call starts no process', async () => {
  const pidFile = path.join(tempDir('migent-agent-pid-'), 'pid');
  const client = new HangingClient(pidFile, 'hang');
  let late: unknown;
  let finished: () => void = () => undefined;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  const demo = llm('demo', {
    'session.started': async (_input, caps) => {
      const first = caps.invokeAgent?.('PLUGIN hang');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        late = await caps.invokeAgent?.('PLUGIN late');
        await first;
      } finally {
        finished();
      }
      return [];
    },
  });
  const workspace = workspaceWith(entry('    timeout_sec: 1\n'));
  const watch = watchFailedCommit(workspace, pidFile);
  const { result } = await run(demo, '', client, workspace);
  watch.off();
  expect(watch.stopped).toEqual([true]);
  expect(watch.locked).toEqual([true]);
  const failed = eventsOf(workspace, result.sessionId).find((event) => event.event === 'plugin.failed');
  expect(failed?.data).toMatchObject({ reason: 'timeout', hook: 'session.started' });
  expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
  expect(client.calls.filter((item) => item.prompt.startsWith('PLUGIN'))).toHaveLength(1);
  await done;
  expect(late).toMatchObject({ text: null, error: expect.stringContaining('not started') });
}, 30_000);

test('cancellation during a provider call stops the process and records cancelled', async () => {
  const pidFile = path.join(tempDir('migent-agent-cancel-'), 'pid');
  const client = new HangingClient(pidFile, 'hang');
  const demo = llm('demo', {
    'session.started': async (_input, caps) => {
      await caps.invokeAgent?.('PLUGIN hang');
      return [];
    },
  });
  const timer = setInterval(() => {
    if (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') return;
    clearInterval(timer);
    try {
      raiseCancellation(2);
    } catch {
      // The flag stays set.
    }
  }, 30);
  const workspace = workspaceWith(entry());
  const watch = watchFailedCommit(workspace, pidFile);
  const { result } = await run(demo, '', client, workspace);
  watch.off();
  clearInterval(timer);
  resetCancellation();
  expect(watch.stopped).toEqual([true]);
  expect(watch.locked).toEqual([true]);
  const names = eventsOf(workspace, result.sessionId).map((event) => event.event);
  const failed = eventsOf(workspace, result.sessionId).find((event) => event.event === 'plugin.failed');
  expect(failed?.data.reason).toBe('cancelled');
  expect(names.indexOf('plugin.failed')).toBeGreaterThan(names.indexOf('plugin.hook_invoked'));
  expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
  expect(existsSync(path.join(directoryOf(workspace, result.sessionId), 'session.lock'))).toBe(false);
}, 30_000);

test.each([
  ['ignore', 0, undefined],
  ['stop', 1, 'blocked'],
  ['fail', 1, 'active'],
] as const)('a failing provider call under %s gives the failure matrix result', async (policy, code, status) => {
  const client = new HangingClient('', 'fail');
  client.captureUsage = () => ({ total: 7 });
  const before: { prefix: string; files: Record<string, string> }[] = [];
  const demo = llm('demo', {
    'execution.finished': async (input, caps) => {
      // Only the first invocation fails the call; later ones (under ignore) are not compared.
      if (before.length > 0) return [];
      const prefix = `${input.execution?.id ?? ''}/`;
      before.push({ prefix, files: filesUnder(workspaceRef.path, input.session.id, prefix) });
      const answer = await caps.invokeAgent?.('PLUGIN fail');
      if (typeof answer?.error === 'string') throw new Error(answer.error);
      return [];
    },
  });
  const workspace = workspaceWith(entry(`    on_error: ${policy}\n`));
  workspaceRef.path = workspace;
  const { result } = await run(demo, '', client, workspace);
  const id = result.sessionId;
  const failed = eventsOf(workspace, id).find((event) => event.event === 'plugin.failed');
  expect(failed?.data).toMatchObject({ on_error: policy, reason: 'error' });
  expect(failed?.data.agent_calls).toMatchObject([
    { outcome: 'failed', exit_code: 3, client: 'fake', model: 'm1', classification: 'provider', usage: { total: 7 } },
  ]);
  expect(before).toHaveLength(1);
  expect(filesUnder(workspace, id, before[0]?.prefix ?? '')).toEqual(before[0]?.files);
  if (policy === 'ignore') expect(statusOf(workspace, id)).not.toHaveProperty('plugin_holds');
  else expect(statusOf(workspace, id).status).toBe(status);
  expect(result.code).toBe(code);
  expect(readdirSync(path.join(directoryOf(workspace, id), 'plugins', 'demo', 'calls')).length).toBeGreaterThan(0);
}, 30_000);

test('overlapping calls get distinct indexes, files and responses', async () => {
  const client = new HangingClient('', 'echo');
  const demo = llm('demo', {
    'session.started': async (_input, caps) => {
      await Promise.all([caps.invokeAgent?.('PLUGIN a'), caps.invokeAgent?.('PLUGIN b')]);
      return [];
    },
  });
  const { workspace, result } = await run(demo, entry(), client);
  const decision = eventsOf(workspace, result.sessionId).find((event) => event.event === 'plugin.decision');
  const calls = decision?.data.agent_calls as { index: number; output_path: string }[];
  expect(calls.map((call) => call.index)).toEqual([1, 2]);
  expect(new Set(calls.map((call) => call.output_path)).size).toBe(2);
  const stored = calls.map((call) => readFileSync(path.join(directoryOf(workspace, result.sessionId), call.output_path), 'utf8'));
  expect(stored.sort()).toEqual(['plugin-answer:a', 'plugin-answer:b']);
}, 30_000);

test('a handler that returns with a call still running stays under the deadline and the failure policy', async () => {
  const pidFile = path.join(tempDir('migent-agent-orphan-'), 'pid');
  const client = new HangingClient(pidFile, 'hang');
  const demo = llm('demo', {
    'session.started': (_input, caps) => {
      void caps.invokeAgent?.('PLUGIN hang');
      return Promise.resolve([]);
    },
  });
  const { workspace, result } = await run(demo, entry('    timeout_sec: 1\n'), client);
  const failed = eventsOf(workspace, result.sessionId).find((event) => event.event === 'plugin.failed');
  expect(failed?.data).toMatchObject({ reason: 'timeout' });
  expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
}, 30_000);

test('a handler that throws with a call still running stops the provider', async () => {
  const pidFile = path.join(tempDir('migent-agent-throw-'), 'pid');
  const client = new HangingClient(pidFile, 'hang');
  const demo = llm('demo', {
    'session.started': async (_input, caps) => {
      void caps.invokeAgent?.('PLUGIN hang');
      await new Promise((resolve) => setTimeout(resolve, 500));
      throw new Error('boom');
    },
  });
  const { workspace, result } = await run(demo, entry(), client);
  const failed = eventsOf(workspace, result.sessionId).find((event) => event.event === 'plugin.failed');
  expect(failed?.data).toMatchObject({ reason: 'error' });
  expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
}, 30_000);

test('an advisory plugin records the live client and model of each call', async () => {
  const client = new HangingClient('', 'ok');
  const workspace = workspaceWith(entry());
  const runner = new AgentToolRunner(registryOf({ fake: client }), 10);
  const demo = llm('demo', {
    'execution.finished': async (_input, caps) => {
      await caps.invokeAgent?.('PLUGIN again');
      return [];
    },
  }, { advisory: true });
  runner.pluginRegistry = registryOfPlugins(demo);
  const first = await executeNamedWorkflow(workspace, { workflowId: 'chain', task: 'go', maxDispatches: 1 }, runner);
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), BASE.replace('model: m1', 'model: changed') + entry(), 'utf8');
  await executeNamedWorkflow(workspace, { workflowId: 'chain', sessionId: first.sessionId }, runner);
  const models = eventsOf(workspace, first.sessionId)
    .filter((event) => event.event === 'plugin.decision')
    .flatMap((event) => (event.data.agent_calls as { model: string; client: string }[]).map((call) => `${call.client}:${call.model}`));
  expect(models[0]).toBe('fake:m1');
  expect(models.at(-1)).toBe('fake:changed');
}, 30_000);

test('no capability is offered when the host plugin config has no agent', async () => {
  // Config validation requires `agent` for a declaring plugin, so the host boundary is driven directly.
  const client = new HangingClient('', 'ok');
  const workspace = workspaceWith('');
  const runner = new AgentToolRunner(registryOf({ fake: client }), 10);
  const created = await executeNamedWorkflow(workspace, { workflowId: 'chain', task: 'go' }, runner);
  let offered: boolean | null = null;
  const demo = llm('demo', {
    'session.started': (_input, caps) => {
      offered = caps.invokeAgent !== undefined;
      return Promise.resolve([]);
    },
  });
  const selection = {
    selected: [{ id: 'demo', version: '1.0.0', manifest: demo.manifest, source: 'frozen' as const, config: { enabled: true }, target: { client: 'fake', model: 'm1', options: {} } }],
    unavailable: [], addedAfterFreeze: [],
  };
  const services = { plugins: registryOfPlugins(demo), clients: registryOf({ fake: client }) };
  const session = { workspace, sessionId: created.sessionId };
  const host = new PluginHost(session, selection, services);
  const lock = SessionLock.acquire(directoryOf(workspace, created.sessionId));
  host.start();
  host.fireSessionStarted();
  await host.close();
  expect(offered).toBe(false);
  // The same host with an agent in the config does offer it.
  const withAgent = { ...selection, selected: [{ ...selection.selected[0], config: { enabled: true, agent: 'fake' } }] };
  const second = new PluginHost(session, withAgent, services);
  second.start();
  second.fireSessionStarted();
  await second.close();
  lock.release();
  expect(offered).toBe(true);
}, 30_000);

test('a handler that returns with a call pending, then cancellation, settles as cancelled and stops the provider', async () => {
  const pidFile = path.join(tempDir('migent-agent-pending-cancel-'), 'pid');
  const client = new HangingClient(pidFile, 'hang');
  const demo = llm('demo', {
    'session.started': (_input, caps) => {
      void caps.invokeAgent?.('PLUGIN hang');
      return Promise.resolve([]);
    },
  });
  const timer = setInterval(() => {
    if (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') return;
    clearInterval(timer);
    try {
      raiseCancellation(2);
    } catch {
      // The flag stays set.
    }
  }, 30);
  const workspace = workspaceWith(entry());
  const watch = watchFailedCommit(workspace, pidFile);
  const { result } = await run(demo, '', client, workspace);
  watch.off();
  clearInterval(timer);
  resetCancellation();
  const failed = eventsOf(workspace, result.sessionId).find((event) => event.event === 'plugin.failed');
  expect(failed?.data.reason).toBe('cancelled');
  expect(watch.stopped).toEqual([true]);
  expect(watch.locked).toEqual([true]);
}, 30_000);

test('a call that fails at runtime after the handler returned fails the invocation', async () => {
  const client = new HangingClient('', 'throw');
  const demo = llm('demo', {
    'session.started': async (_input, caps) => {
      void caps.invokeAgent?.('PLUGIN boom');
      await new Promise((resolve) => setTimeout(resolve, 100));
      return [];
    },
  });
  const { workspace, result } = await run(demo, entry(), client);
  const failed = eventsOf(workspace, result.sessionId).find((event) => event.event === 'plugin.failed');
  expect(failed?.data).toMatchObject({ reason: 'error', error: expect.stringContaining('provider build failed') });
}, 30_000);

test('an advisory plugin follows a live model edit between two calls of one invocation', async () => {
  const client = new HangingClient('', 'ok');
  const workspace = workspaceWith(entry());
  const demo = llm('demo', {
    'session.started': async (_input, caps) => {
      await caps.invokeAgent?.('PLUGIN one');
      writeFileSync(path.join(workspace, '.migent', 'config.yaml'), BASE.replace('model: m1', 'model: changed') + entry(), 'utf8');
      await caps.invokeAgent?.('PLUGIN two');
      return [];
    },
  }, { advisory: true });
  await run(demo, '', client, workspace);
  const models = client.calls.filter((item) => item.prompt.startsWith('PLUGIN')).map((item) => item.model);
  expect(models).toEqual(['m1', 'changed']);
}, 30_000);

test('an advisory plugin whose agent is invalidated between two calls fails as unavailable', async () => {
  const client = new HangingClient('', 'ok');
  const workspace = workspaceWith(entry());
  const demo = llm('demo', {
    'session.started': async (_input, caps) => {
      await caps.invokeAgent?.('PLUGIN one');
      writeFileSync(path.join(workspace, '.migent', 'config.yaml'), BASE.replace('client: { type: fake }\n    model: m1', 'client: { type: nope }\n    model: m1') + entry(), 'utf8');
      await caps.invokeAgent?.('PLUGIN two');
      return [];
    },
  }, { advisory: true });
  const { result } = await run(demo, '', client, workspace);
  const failed = eventsOf(workspace, result.sessionId).find((event) => event.event === 'plugin.failed');
  expect(failed?.data).toMatchObject({ reason: 'unavailable' });
  expect(client.calls.filter((item) => item.prompt.startsWith('PLUGIN'))).toHaveLength(1);
}, 30_000);

test('an advisory target invalidated before an unawaited call fails the invocation as unavailable', async () => {
  const client = new HangingClient('', 'ok');
  const workspace = workspaceWith(entry());
  const demo = llm('demo', {
    'session.started': async (_input, caps) => {
      writeFileSync(
        path.join(workspace, '.migent', 'config.yaml'),
        BASE.replace('client: { type: fake }\n    model: m1', 'client: { type: nope }\n    model: m1') + entry(),
        'utf8',
      );
      void caps.invokeAgent?.('PLUGIN never-awaited');
      await new Promise((resolve) => setTimeout(resolve, 100));
      return [{ kind: 'output', name: 'report.md', content: 'applied', media_type: 'text/markdown' }] as never;
    },
  }, { advisory: true });
  const { result } = await run(demo, '', client, workspace);
  const events = eventsOf(workspace, result.sessionId);
  const failed = events.find((event) => event.event === 'plugin.failed');
  expect(failed?.data).toMatchObject({ reason: 'unavailable', hook: 'session.started' });
  expect(events.some((event) => event.event === 'plugin.decision')).toBe(false);
  expect(existsSync(path.join(directoryOf(workspace, result.sessionId), 'plugins', 'demo', 'report.md'))).toBe(false);
  expect(client.calls.filter((item) => item.prompt.startsWith('PLUGIN'))).toHaveLength(0);
}, 30_000);
