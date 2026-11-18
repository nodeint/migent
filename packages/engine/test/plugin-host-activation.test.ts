import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type {
  Plugin, PluginActivationContext, PluginEventProposal, PluginHandler, PluginRegistry, PluginUses, TSchema,
} from '@nodeint/migent-contracts';
import { PluginContextClosed } from '@nodeint/migent-contracts';
import { raiseCancellation, resetCancellation } from '@nodeint/migent-kernel';
import { readParsedEvents } from '@nodeint/migent-session';
import { expect, test } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { buildCallContext } from '../src/plugin-host/context.ts';
import { InvocationState } from '../src/plugin-host/invocation.ts';
import { registryOf, ScriptedClient, tempDir } from './support.ts';

const schema = { type: 'object' } as unknown as TSchema;
const DONE = 'status: complete\n\ndone';
const CHAIN = 'schema_version: 2\nid: chain\nstages:\n  - id: a\n    role: developer\n  - id: b\n    role: developer\n    depends_on: [a]\n';
const BASE = 'agents:\n  fake:\n    client: { type: fake }\n    model: m1\nroles:\n  developer:\n    agent: fake\n';

const USES: PluginUses = {
  operations: [{ target: 'agent.turn', phases: ['before'] }],
  events: ['session.started', 'execution.finished'],
  session: [],
  artifacts: [{ name: 'report.md', mode: 'replace', media_type: 'text/markdown' }],
  agents: false,
  config: [],
};

const plugin = (
  id: string,
  activate: Plugin['activate'],
  uses: Partial<PluginUses> = {},
  extra: Partial<Plugin['manifest']> = {},
): Plugin => ({
  manifest: { id, version: '1.0.0', apiVersion: { major: 1, minor: 0 }, advisory: false, configSchema: schema, uses: { ...USES, ...uses }, ...extra },
  activate,
});
const onStarted = (handler: PluginHandler) => (_options: unknown, migent: PluginActivationContext): void => {
  migent.events.on('session.started', handler);
};
const registryOfPlugins = (...plugins: Plugin[]): PluginRegistry => ({
  ids: () => plugins.map((entry) => entry.manifest.id),
  get: (id) => plugins.find((entry) => entry.manifest.id === id),
});

function workspaceWith(plugins: string): string {
  const workspace = tempDir('migent-plugin-activation-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), BASE + plugins, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'chain.yaml'), CHAIN, 'utf8');
  return workspace;
}
const entry = (id: string, body = ''): string => `plugins:\n  ${id}:\n    enabled: true\n${body}`;

async function run(plugins: Plugin[], config: string) {
  const workspace = workspaceWith(config);
  const client = new ScriptedClient([DONE, DONE]);
  const runner = new AgentToolRunner(registryOf({ fake: client }), 10);
  runner.pluginRegistry = registryOfPlugins(...plugins);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'chain', task: 'go' }, runner);
  const events = readParsedEvents(path.join(workspace, '.migent', 'sessions', result.sessionId, 'events.jsonl'));
  return { workspace, result, events, client, directory: path.join(workspace, '.migent', 'sessions', result.sessionId) };
}
const pluginEvents = (events: { event: string }[]) => events.filter((event) => event.event.startsWith('plugin.'));

test('activate runs once per host scope, before the first trigger', async () => {
  let activations = 0;
  const demo = plugin('demo', (_options, migent) => {
    activations += 1;
    migent.events.on('execution.finished', () => Promise.resolve([]));
  });
  const { events } = await run([demo], entry('demo'));
  expect(activations).toBe(1);
  expect(pluginEvents(events).map((event) => event.event)).toEqual([
    'plugin.hook_invoked', 'plugin.decision', 'plugin.hook_invoked', 'plugin.decision',
  ]);
});

test('an undeclared event, target, or phase fails activation, even when the plugin swallows the error', async () => {
  const swallowing = (register: (migent: PluginActivationContext) => void) => plugin('demo', (_options, migent) => {
    try { register(migent); } catch { /* the host still knows */ }
  });
  const cases: [string, Plugin][] = [
    ['event', swallowing((migent) => { migent.events.on('session.stopped', () => Promise.resolve([])); })],
    ['target', swallowing((migent) => { migent.operations.intercept('reply.gate', { before: () => Promise.resolve({ kind: 'continue' }) }); })],
    ['phase', swallowing((migent) => { migent.operations.intercept('agent.turn', { after: () => Promise.resolve({ kind: 'continue' }) }); })],
  ];
  for (const [label, demo] of cases) {
    const { events } = await run([demo], entry('demo'));
    const failed = pluginEvents(events);
    expect(failed.map((event) => event.event), label).toEqual(['plugin.failed']);
    expect(failed[0]?.data, label).toMatchObject({ hook: 'activate', reason: 'error', plugin: 'demo' });
  }
});

test('registration after the activation deadline throws PluginContextClosed and earlier registrations are discarded', async () => {
  const seen: unknown[] = [];
  let fired = 0;
  const demo = plugin('demo', async (_options, migent) => {
    migent.events.on('session.started', () => { fired += 1; return Promise.resolve([]); });
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      migent.events.on('execution.finished', () => Promise.resolve([]));
    } catch (error) {
      seen.push(error);
    }
  });
  const { events } = await run([demo], entry('demo', '    timeout_sec: 0.05\n'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(pluginEvents(events).map((event) => event.event)).toEqual(['plugin.failed']);
  expect(pluginEvents(events)[0]?.data).toMatchObject({ hook: 'activate', reason: 'timeout' });
  expect(fired).toBe(0);
  expect(seen[0]).toBeInstanceOf(PluginContextClosed);
});

test('activation cancellation records plugin.failed with hook activate', async () => {
  const demo = plugin('demo', () => {
    setTimeout(() => { try { raiseCancellation(2); } catch { /* the flag stays set */ } }, 10);
    return new Promise<never>(() => {});
  });
  try {
    const { events } = await run([demo], entry('demo'));
    const failed = pluginEvents(events).filter((event) => event.event === 'plugin.failed');
    expect(failed[0]?.data).toMatchObject({ hook: 'activate', reason: 'cancelled' });
  } finally {
    resetCancellation();
  }
});

test('log and agents.invoke after settlement are rejected: nothing is recorded and no provider starts', async () => {
  let late: (() => Promise<unknown>) | null = null;
  const demo = plugin('demo', onStarted((_input, call) => {
    call.log.info('during');
    late = async () => {
      call.log.warn('after');
      return await call.agents.invoke('PLUGIN late').catch((error: unknown) => error);
    };
    return Promise.resolve([]);
  }), { agents: true });
  const { events, client, directory } = await run([demo], entry('demo', '    agent: fake\n'));
  const decision = events.find((event) => event.event === 'plugin.decision');
  expect(decision?.data.notes).toEqual([{ level: 'info', text: 'during' }]);
  const providerCalls = client.calls.length;
  const outcome = await (late as unknown as () => Promise<unknown>)();
  expect(outcome).toBeInstanceOf(PluginContextClosed);
  expect(client.calls.length).toBe(providerCalls);
  const reread = readParsedEvents(path.join(directory, 'events.jsonl'));
  expect(JSON.stringify(reread.filter((event) => event.event.startsWith('plugin.')))).not.toContain('after');
  expect(reread.filter((event) => event.event === 'plugin.decision')[0]?.data.notes).toEqual([{ level: 'info', text: 'during' }]);
});

test('two overlapping invocation contexts keep their own notes, lifetime and proposals', async () => {
  const demo = plugin('demo', () => {});
  const sources = { manifest: demo.manifest, options: {}, readCore: () => undefined };
  const first = new InvocationState();
  const second = new InvocationState();
  const firstContext = buildCallContext(sources, first, null);
  const secondContext = buildCallContext(sources, second, null);
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let bothOpen = false;
  const run1 = (async () => {
    firstContext.log.info('first');
    await barrier;
    return firstContext.artifacts.propose('report.md', 'first');
  })();
  const run2 = (async () => {
    secondContext.log.info('second');
    bothOpen = first.open && second.open;
    release();
    return secondContext.artifacts.propose('report.md', 'second');
  })();
  const [proposal1, proposal2] = await Promise.all([run1, run2]);
  expect(bothOpen).toBe(true);
  expect(proposal1).toMatchObject({ content: 'first' });
  expect(proposal2).toMatchObject({ content: 'second' });
  expect(first.notes).toEqual([{ level: 'info', text: 'first' }]);
  expect(second.notes).toEqual([{ level: 'info', text: 'second' }]);
  first.close();
  expect(second.open).toBe(true);
  firstContext.log.warn('late');
  secondContext.log.warn('still open');
  expect(first.notes).toHaveLength(1);
  expect(second.notes).toEqual([{ level: 'info', text: 'second' }, { level: 'warn', text: 'still open' }]);
  await expect(firstContext.agents.invoke('x')).rejects.toThrow();
});

test('successful activation records its notes on one decision, even with no handlers', async () => {
  const demo = plugin('demo', (_options, migent) => { migent.log.info('hello'); migent.log.warn('careful'); });
  const { events } = await run([demo], entry('demo'));
  const records = pluginEvents(events);
  expect(records.map((event) => event.event)).toEqual(['plugin.decision']);
  expect(records[0]?.data).toMatchObject({
    plugin: 'demo', proposed: [], results: [],
    notes: [{ level: 'info', text: 'hello' }, { level: 'warn', text: 'careful' }],
  });
});

test('activation notes stay on the activation and do not reach later invocations', async () => {
  const demo = plugin('demo', (_options, migent) => {
    migent.log.info('activation');
    migent.events.on('session.started', (_input, call) => { call.log.info('handler'); return Promise.resolve([]); });
  });
  const { events } = await run([demo], entry('demo'));
  const decisions = events.filter((event) => event.event === 'plugin.decision');
  expect(decisions.map((event) => event.data.notes)).toEqual([
    [{ level: 'info', text: 'activation' }], [{ level: 'info', text: 'handler' }],
  ]);
  expect(decisions[0]?.data.invocation_id).not.toBe(decisions[1]?.data.invocation_id);
});

test('failed activation keeps its own notes and they do not leak to later invocations', async () => {
  const demo = plugin('demo', (_options, migent) => {
    migent.log.info('before failure');
    throw new Error('boom');
  });
  const { events } = await run([demo], entry('demo'));
  const records = pluginEvents(events);
  expect(records.map((event) => event.event)).toEqual(['plugin.failed']);
  expect(records[0]?.data).toMatchObject({ hook: 'activate', notes: [{ level: 'info', text: 'before failure' }] });
});

test('a second artifact proposal is invalid_intent and nothing is written', async () => {
  const two: PluginEventProposal[] = [
    { kind: 'artifact', name: 'report.md', content: 'a' },
    { kind: 'artifact', name: 'report.md', content: 'b' },
  ];
  const demo = plugin('demo', onStarted(() => Promise.resolve(two)));
  const { events, directory } = await run([demo], entry('demo'));
  expect(pluginEvents(events).map((event) => event.event)).toEqual(['plugin.hook_invoked', 'plugin.failed']);
  expect(pluginEvents(events)[1]?.data).toMatchObject({ reason: 'invalid_intent' });
  expect(() => readFileSync(path.join(directory, 'plugins', 'demo', 'report.md'), 'utf8')).toThrow();
});

test('an artifact the manifest does not claim is invalid_intent', async () => {
  const demo = plugin('demo', onStarted(() => Promise.resolve([{ kind: 'artifact', name: 'other.md', content: 'x' }])));
  const { events } = await run([demo], entry('demo'));
  expect(pluginEvents(events)[1]?.data).toMatchObject({ reason: 'invalid_intent' });
});

test('artifacts.propose refuses an undeclared claim', async () => {
  let thrown: unknown = null;
  const demo = plugin('demo', onStarted((_input, call) => {
    try { call.artifacts.propose('nope.md', 'x'); } catch (error) { thrown = error; }
    return Promise.resolve([]);
  }));
  await run([demo], entry('demo'));
  expect(String(thrown)).toContain('did not declare artifact "nope.md"');
});

test('config.core reads only declared keys', async () => {
  const seen: unknown[] = [];
  const demo = plugin('demo', onStarted((_input, call) => {
    seen.push(call.config.core('agents'));
    try { call.config.core('roles'); } catch (error) { seen.push(String(error)); }
    return Promise.resolve([]);
  }), { config: ['agents'] });
  await run([demo], entry('demo'));
  expect(seen[0]).toMatchObject({ fake: { model: 'm1' } });
  expect(seen[1]).toContain('did not declare core config key "roles"');
});
