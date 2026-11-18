import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Plugin, PluginInterceptor, PluginRegistry, PluginUses, TSchema } from '@nodeint/migent-contracts';
import { raiseCancellation, resetCancellation } from '@nodeint/migent-kernel';
import { readParsedEvents } from '@nodeint/migent-session';
import { expect, test } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { registryOf, ScriptedClient, tempDir } from './support.ts';

const schema = { type: 'object' } as unknown as TSchema;
const DONE = 'status: complete\n\ndone';
const BASE = 'agents:\n  fake:\n    client: { type: fake }\n    model: m1\nroles:\n  developer:\n    agent: fake\n';
const ONE = 'schema_version: 2\nid: chain\nstages:\n  - id: a\n    role: developer\n';
const FAN = 'schema_version: 2\nid: chain\nconcurrency: 2\nstages:\n  - id: a\n    role: developer\n  - id: b\n    role: developer\n';
const USES: PluginUses = {
  operations: [{ target: 'agent.turn', phases: ['before', 'after'] }],
  events: [], session: [], artifacts: [], agents: false, config: [],
};

const plugin = (id: string, interceptor: PluginInterceptor): Plugin => ({
  manifest: {
    id, version: '1.0.0', apiVersion: { major: 1, minor: 0 }, advisory: false, configSchema: schema, uses: USES,
  },
  activate: (_options, migent) => { migent.operations.intercept('agent.turn', interceptor); },
});
const registryOfPlugins = (...plugins: Plugin[]): PluginRegistry => ({
  ids: () => plugins.map((entry) => entry.manifest.id),
  get: (id) => plugins.find((entry) => entry.manifest.id === id),
});

async function run(
  plugins: Plugin[],
  config: string,
  workflow = ONE,
  responses = [DONE, DONE],
  workspace = tempDir('migent-plugin-intercept-'),
) {
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), BASE + config, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'chain.yaml'), workflow, 'utf8');
  const client = new ScriptedClient(responses);
  const runner = new AgentToolRunner(registryOf({ fake: client }), 10);
  runner.pluginRegistry = registryOfPlugins(...plugins);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'chain', task: 'go' }, runner);
  const events = readParsedEvents(path.join(workspace, '.migent', 'sessions', result.sessionId, 'events.jsonl'));
  const promptOf = (index: number): string | undefined =>
    client.calls[index]?.prompt.replaceAll(workspace, '<workspace>');
  return { client, promptOf, result, workspace, events: events.filter((event) => event.event.startsWith('plugin.')) };
}

const entries = (...ids: string[]): string =>
  `plugins:\n${ids.map((id) => `  ${id}:\n    enabled: true\n`).join('')}`;

test('a before patch on agent.turn.prompt reaches the provider and is recorded as applied', async () => {
  const demo = plugin('demo', { before: async (request) => ({ kind: 'patch', fields: { prompt: `PATCHED ${String(request.prompt)}` } }) });
  const { client, result, events } = await run([demo], entries('demo'));
  expect(result.code).toBe(0);
  expect(client.calls[0]?.prompt).toMatch(/^PATCHED /);
  expect(events.map((event) => event.event)).toEqual(['plugin.hook_invoked', 'plugin.decision']);
  expect(events[0]?.data.hook).toBe('operation:agent.turn:before');
  expect(events[1]?.data.results).toMatchObject([{ kind: 'patch', status: 'applied' }]);
});

test('a patch of an undeclared field is rejected and the prompt is unchanged', async () => {
  const baseline = await run([], '');
  const demo = plugin('demo', { before: async () => ({ kind: 'patch', fields: { turn: 9 } }) });
  const { promptOf, result, events } = await run([demo], entries('demo'));
  expect(result.code).toBe(0);
  expect(promptOf(0)).toBe(baseline.promptOf(0));
  expect(events.map((event) => event.event)).toEqual(['plugin.hook_invoked', 'plugin.decision', 'plugin.failed']);
  expect(events[1]?.data.results).toMatchObject([{ status: 'rejected' }]);
  expect(events[2]?.data).toMatchObject({ reason: 'invalid_intent', hook: 'operation:agent.turn:before' });
});

test('interceptors run in configuration order and the second sees the first patch', async () => {
  const first = plugin('first', { before: async (request) => ({ kind: 'patch', fields: { prompt: `${String(request.prompt)}|1` } }) });
  const second = plugin('second', { before: async (request) => ({ kind: 'patch', fields: { prompt: `${String(request.prompt)}|2` } }) });
  const { client } = await run([first, second], entries('second', 'first'));
  expect(client.calls[0]?.prompt.endsWith('|2|1')).toBe(true);
});

test('a throwing interceptor with on_error stop holds the session and the provider still ran unmodified', async () => {
  const baseline = await run([], '');
  const demo = plugin('demo', { before: async () => { throw new Error('boom'); } });
  const { promptOf, result, events } = await run([demo], 'plugins:\n  demo:\n    enabled: true\n    on_error: stop\n');
  expect(promptOf(0)).toBe(baseline.promptOf(0));
  expect(events.at(-1)?.data).toMatchObject({ reason: 'error', on_error: 'stop' });
  expect(result.stopReason).toBe('plugin_hold');
});

test('a timed-out interceptor discards a late patch', async () => {
  const baseline = await run([], '');
  const demo = plugin('demo', {
    before: () => new Promise((resolve) => {
      setTimeout(() => resolve({ kind: 'patch', fields: { prompt: 'LATE' } }), 400);
    }),
  });
  const { promptOf, events } = await run([demo], 'plugins:\n  demo:\n    enabled: true\n    timeout_sec: 0.05\n');
  expect(promptOf(0)).toBe(baseline.promptOf(0));
  expect(events.at(-1)?.data).toMatchObject({ reason: 'timeout' });
});

test('concurrent stages get independent chains and notes', async () => {
  const demo = plugin('demo', {
    before: async (request, call) => {
      call.log.info(`saw ${String(request.prompt).length}`);
      return { kind: 'patch', fields: { prompt: `P ${String(request.prompt)}` } };
    },
  });
  const { client, events } = await run([demo], entries('demo'), FAN);
  expect(client.calls).toHaveLength(2);
  expect(client.calls.every((call) => call.prompt.startsWith('P '))).toBe(true);
  const decisions = events.filter((event) => event.event === 'plugin.decision');
  expect(decisions).toHaveLength(2);
  expect(new Set(decisions.map((event) => event.data.invocation_id)).size).toBe(2);
  expect(decisions.every((event) => (event.data.notes as unknown[]).length === 1)).toBe(true);
});

test('an after patch on an undeclared output field is rejected', async () => {
  const demo = plugin('demo', { after: async () => ({ kind: 'patch', fields: { responseText: 'x' } }) });
  const { result, events } = await run([demo], entries('demo'));
  expect(result.code).toBe(0);
  expect(events.at(-1)?.data).toMatchObject({ reason: 'invalid_intent', hook: 'operation:agent.turn:after' });
});

const reasons = (events: { event: string; data: Record<string, unknown> }[]): unknown[] =>
  events.filter((event) => event.event === 'plugin.failed').map((event) => event.data.reason);
const lockOf = (workspace: string): string => {
  const root = path.join(workspace, '.migent', 'sessions');
  return path.join(root, readdirSync(root)[0] ?? '', 'session.lock');
};

test.each(['before', 'after'] as const)('a throwing %s interceptor is discarded, the handler result stands', async (phase) => {
  const baseline = await run([], '');
  const demo = plugin('demo', { [phase]: async () => { throw new Error('boom'); } });
  const { promptOf, result, events } = await run([demo], entries('demo'));
  expect(result.code).toBe(0);
  expect(promptOf(0)).toBe(baseline.promptOf(0));
  expect(reasons(events)).toEqual(['error']);
  expect(events.some((event) => event.event === 'plugin.decision')).toBe(false);
});

/** Every file under the session directory with its content, so later mutation of durable state shows. */
function snapshotOf(workspace: string, sessionId: string): Record<string, string> {
  const root = path.join(workspace, '.migent', 'sessions', sessionId);
  const out: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name !== 'session.lock') out[path.relative(root, full)] = readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}

test.each(['before', 'after'] as const)('a timed-out %s interceptor is discarded and a late result never lands', async (phase) => {
  let release: (value: unknown) => void = () => {};
  const late = new Promise((resolve) => { release = resolve; });
  const demo = plugin('demo', { [phase]: () => late as never });
  const baseline = await run([], '');
  const { promptOf, result, events, workspace } = await run(
    [demo], 'plugins:\n  demo:\n    enabled: true\n    timeout_sec: 0.05\n',
  );
  const {sessionId} = result;
  const before = snapshotOf(workspace, sessionId);
  // A proposal that would be applied if it were processed.
  release(phase === 'before' ? { kind: 'patch', fields: { prompt: 'LATE' } } : { kind: 'continue' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(result.code).toBe(0);
  expect(promptOf(0)).toBe(baseline.promptOf(0));
  expect(reasons(events)).toEqual(['timeout']);
  expect(events.some((event) => event.event === 'plugin.decision')).toBe(false);
  expect(snapshotOf(workspace, sessionId)).toEqual(before);
  const reread = readParsedEvents(path.join(workspace, '.migent', 'sessions', sessionId, 'events.jsonl'))
    .filter((event) => event.event.startsWith('plugin.'));
  expect(reread.map((event) => event.event)).toEqual(['plugin.hook_invoked', 'plugin.failed']);
});

test.each(['before', 'after'] as const)('a cancelled %s interceptor is discarded', async (phase) => {
  const demo = plugin('demo', {
    [phase]: () => new Promise<never>(() => {
      setTimeout(() => { try { raiseCancellation(2); } catch { /* flag stays */ } }, 10);
    }),
  });
  try {
    const { events } = await run([demo], entries('demo'));
    expect(reasons(events)).toContain('cancelled');
    expect(events.some((event) => event.event === 'plugin.decision')).toBe(false);
  } finally {
    resetCancellation();
  }
});

test.each(['before', 'after'] as const)('%s interceptor failures leave the persisted turn identical to a plugin-free run', async (phase) => {
  const baseline = await run([], '');
  const demo = plugin('demo', { [phase]: async () => { throw new Error('boom'); } });
  const failing = await run([demo], entries('demo'));
  const turnFiles = (workspace: string, sessionId: string): Record<string, string> =>
    Object.fromEntries(Object.entries(snapshotOf(workspace, sessionId)).filter(
      ([name]) => name.includes('turn') || name.endsWith('response.md'),
    ).map(([name, text]) => [name, text.replaceAll(workspace, '<workspace>')]));
  const expected = turnFiles(baseline.workspace, baseline.result.sessionId);
  expect(Object.keys(expected).length).toBeGreaterThan(0);
  expect(turnFiles(failing.workspace, failing.result.sessionId)).toEqual(expected);
});

test('an after patch is rejected, and the handler output and prompt are unchanged and durable', async () => {
  const baseline = await run([], '');
  const demo = plugin('demo', { after: async () => ({ kind: 'patch', fields: { responseText: 'x' } }) });
  const { result, events, promptOf } = await run([demo], entries('demo'));
  expect(result.code).toBe(baseline.result.code);
  expect(result.status).toBe(baseline.result.status);
  expect(promptOf(0)).toBe(baseline.promptOf(0));
  expect(reasons(events)).toEqual(['invalid_intent']);
});

test('losing the session lock before a proposal is applied ends the run without the patch', async () => {
  const workspace = tempDir('migent-plugin-intercept-');
  const demo = plugin('demo', {
    before: async (request) => {
      const file = lockOf(workspace);
      const info = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      writeFileSync(file, JSON.stringify({ ...info, nonce: 'stolen' }), 'utf8');
      return { kind: 'patch', fields: { prompt: `LOST ${String(request.prompt)}` } };
    },
  });
  const { client, result, events } = await run([demo], entries('demo'), ONE, [DONE, DONE], workspace);
  expect(result.code).toBe(2);
  expect(client.calls).toHaveLength(0);
  expect(events.map((event) => event.event)).toEqual(['plugin.hook_invoked']);
});
