import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Plugin, PluginHandler, PluginHook, PluginRegistry, PluginUses, TSchema } from '@nodeint/migent-contracts';
import { StageOutcome } from '@nodeint/migent-kernel';
import { createWorkflowSession, readParsedEvents, readPluginsInspection, sessionEventLog, SessionLock, SessionStore } from '@nodeint/migent-session';
import { afterEach, expect, test, vi } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow, withPluginScope } from '../src/index.ts';
import { registryOf, ScriptedClient, tempDir } from './support.ts';

const schema = { type: 'object' } as unknown as TSchema;
const DONE = 'status: complete\n\ndone';
const ONE = 'schema_version: 2\nid: chain\nstages:\n  - id: a\n    role: developer\n';
const BASE = 'agents:\n  fake:\n    client: { type: fake }\n    model: m1\nroles:\n  developer:\n    agent: fake\n';
const NO_USES: PluginUses = { operations: [], events: [], session: [], artifacts: [], agents: false, config: [] };

const plugin = (
  handlers: Partial<Record<PluginHook, PluginHandler>>,
  mode: 'create_only' | 'replace' = 'create_only',
): Plugin => ({
  manifest: {
    id: 'demo', version: '1.0.0', apiVersion: { major: 1, minor: 0 }, advisory: false, configSchema: schema,
    uses: {
      ...NO_USES,
      events: Object.keys(handlers) as PluginHook[],
      artifacts: [{ name: 'report.md', mode, media_type: 'text/markdown' }],
    },
  },
  activate: (_options, migent) => {
    for (const [hook, handler] of Object.entries(handlers)) migent.events.on(hook as PluginHook, handler);
  },
});
const registryOfPlugins = (...plugins: Plugin[]): PluginRegistry => ({
  ids: () => plugins.map((entry) => entry.manifest.id),
  get: (id) => plugins.find((entry) => entry.manifest.id === id),
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = tempDir('migent-plugin-artifacts-');
  roots.push(root);
  mkdirSync(path.join(root, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(root, '.migent', 'config.yaml'), `${BASE}plugins:\n  demo:\n    enabled: true\n`, 'utf8');
  writeFileSync(path.join(root, '.migent', 'workflows', 'chain.yaml'), ONE, 'utf8');
  return root;
}
const directoryOf = (root: string, id: string): string => path.join(root, '.migent', 'sessions', id);
const eventsOf = (root: string, id: string) => readParsedEvents(path.join(directoryOf(root, id), 'events.jsonl'));
const artifactOf = (root: string, id: string): string => path.join(directoryOf(root, id), 'plugins', 'demo', 'report.md');
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const propose = (content: string): PluginHandler => () => Promise.resolve([{ kind: 'artifact', name: 'report.md', content }]);

async function run(plugins: Plugin[], root = workspace(), sessionId = '') {
  const runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient([DONE, DONE]) }), 10);
  runner.pluginRegistry = registryOfPlugins(...plugins);
  const result = await executeNamedWorkflow(
    root, { workflowId: 'chain', ...(sessionId === '' ? { task: 'go' } : { sessionId }) }, runner,
  );
  return { root, result };
}

test('create_only on an existing file is rejected as exists and writes nothing', async () => {
  let call = 0;
  const handler: PluginHandler = () => Promise.resolve([{ kind: 'artifact', name: 'report.md', content: ['one', 'two'][call++] ?? '' }]);
  const { root, result } = await run([plugin({ 'session.started': handler, 'session.stopped': handler })]);
  const id = result.sessionId;
  expect(readFileSync(artifactOf(root, id), 'utf8')).toBe('one');
  const decisions = eventsOf(root, id).filter((event) => event.event === 'plugin.decision');
  expect(decisions).toHaveLength(2);
  expect(decisions[0]?.data.results).toMatchObject([{ status: 'applied' }]);
  expect(decisions[1]?.data.results).toMatchObject([{ kind: 'artifact', status: 'rejected', reason: 'exists' }]);
});

test('a write error records plugin.failed and leaves the target unchanged', async () => {
  const root = workspace();
  const blocker: PluginHandler = (input) => {
    mkdirSync(path.join(directoryOf(root, input.session.id), 'plugins', 'demo', 'report.md'), { recursive: true });
    return Promise.resolve([{ kind: 'artifact', name: 'report.md', content: 'x' }]);
  };
  const { result } = await run([plugin({ 'session.started': blocker }, 'replace')], root);
  const failed = eventsOf(root, result.sessionId).filter((event) => event.event === 'plugin.failed');
  expect(failed).toHaveLength(1);
  expect(failed[0]?.data.reason).toBe('error');
  expect(statSync(artifactOf(root, result.sessionId)).isDirectory()).toBe(true);
  expect(eventsOf(root, result.sessionId).some((event) => event.event === 'plugin.decision')).toBe(false);
});

test('a record failure after the write propagates, and session show lists the file as no_decision', async () => {
  const root = workspace();
  let armed = true;
  const original = sessionEventLog.record.bind(sessionEventLog);
  const spy = vi.spyOn(sessionEventLog, 'record');
  spy.mockImplementation((directory, event) => {
    if (armed && event.event === 'plugin.decision') {
      armed = false;
      throw new Error('log down');
    }
    original(directory, event);
  });
  try {
    const { result } = await run([plugin({ 'session.started': propose('body') })], root);
    expect(result.code).toBe(2);
    expect(armed).toBe(false);
    const id = readdirSync(path.join(root, '.migent', 'sessions')).find((name) => /^\d+$/.test(name)) ?? '';
    expect(readFileSync(artifactOf(root, id), 'utf8')).toBe('body');
    const inspection = readPluginsInspection(directoryOf(root, id));
    expect(inspection?.unrecorded).toEqual([{ path: 'plugins/demo/report.md', reason: 'no_decision' }]);
  } finally {
    spy.mockRestore();
  }
});

test('a replacement whose record fails is content_mismatch with both hashes', async () => {
  const root = workspace();
  const contents = ['good', 'newer'];
  let call = 0;
  const handler: PluginHandler = () => Promise.resolve([{ kind: 'artifact', name: 'report.md', content: contents[call++] ?? '' }]);
  const original = sessionEventLog.record.bind(sessionEventLog);
  let decisions = 0;
  vi.spyOn(sessionEventLog, 'record').mockImplementation((directory, event) => {
    if (event.event === 'plugin.decision' && ++decisions === 2) throw new Error('log down');
    original(directory, event);
  });
  const { result } = await run([plugin({ 'session.started': handler, 'session.stopped': handler }, 'replace')], root);
  const id = result.sessionId;
  expect(result.code).toBe(2);
  expect(readFileSync(artifactOf(root, id), 'utf8')).toBe('newer');
  expect(readPluginsInspection(directoryOf(root, id))?.unrecorded).toEqual([
    { path: 'plugins/demo/report.md', reason: 'content_mismatch', recorded_sha256: sha('good'), actual_sha256: sha('newer') },
  ]);
});

test('a file that matches its latest applied record is not reported', async () => {
  const root = workspace();
  const { result } = await run([plugin({ 'session.started': propose('good') }, 'replace')], root);
  expect(readPluginsInspection(directoryOf(root, result.sessionId))?.unrecorded).toEqual([]);
});

test('plugins/<id>/calls/ is excluded from the audit', async () => {
  const root = workspace();
  const { result } = await run([plugin({ 'session.started': propose('good') }, 'replace')], root);
  const id = result.sessionId;
  mkdirSync(path.join(directoryOf(root, id), 'plugins', 'demo', 'calls'), { recursive: true });
  writeFileSync(path.join(directoryOf(root, id), 'plugins', 'demo', 'calls', 'x-1.txt'), 'raw', 'utf8');
  expect(readPluginsInspection(directoryOf(root, id))?.unrecorded).toEqual([]);
});

test('a session.completed handler runs on automatic completion', async () => {
  const seen: string[] = [];
  const handler: PluginHandler = (input) => {
    seen.push(input.hook);
    return Promise.resolve([]);
  };
  const { result } = await run([plugin({ 'session.completed': handler })]);
  expect(result.code).toBe(0);
  expect(seen).toEqual(['session.completed']);
});

const TWO = 'schema_version: 2\nid: chain\nstages:\n  - id: a\n    role: developer\n  - id: b\n    role: developer\n    depends_on: [a]\n';

/** A session that ran its first stage only, so manual completion applies. */
function stoppedSession(): { root: string; id: string; directory: string } {
  const root = workspace();
  writeFileSync(path.join(root, '.migent', 'workflows', 'chain.yaml'), TWO, 'utf8');
  writeFileSync(path.join(root, '.migent', 'config.yaml'), BASE, 'utf8');
  const id = createWorkflowSession(root, 'chain', { task: 'go' });
  const directory = directoryOf(root, id);
  const store = new SessionStore(root);
  const lock = SessionLock.acquire(directory);
  try {
    const [record, , context] = store.loadOrCreate({
      client: 'fake', model: 'm1', options: {}, workspace: root, sessionId: id, stageId: 'a',
      stageAttempt: null, executionOrder: null, prompt: 'a',
    });
    store.saveExecution(context, record, { status: 'running' });
    store.saveExecution(context, record, { status: 'completed', outcome: new StageOutcome('complete') });
  } finally {
    lock.release();
  }
  return { root, id, directory };
}

function completionServices(handler: PluginHandler) {
  const completing = plugin({ 'session.completed': handler }, 'replace');
  return {
    selection: {
      selected: [{ id: 'demo', version: '1.0.0', manifest: completing.manifest, source: 'frozen' as const, config: {}, target: null }],
      unavailable: [],
    },
    plugins: registryOfPlugins(completing),
    clients: null,
  };
}

test('a lock-held manual completion runs session.completed handlers and settles them before the lock is released', async () => {
  const { root, id, directory } = stoppedSession();
  const seen: string[] = [];
  const handler: PluginHandler = async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    seen.push(input.hook);
    return [{ kind: 'artifact', name: 'report.md', content: 'done' }];
  };
  const lock = SessionLock.acquire(directory);
  try {
    const completed = await withPluginScope(
      { workspace: root, sessionId: id },
      completionServices(handler),
      () => Promise.resolve(new SessionStore(root).completeManuallyHeld(id)),
    );
    expect(completed.alreadyCompleted).toBe(false);
    expect(seen).toEqual(['session.completed']);
    expect(readFileSync(artifactOf(root, id), 'utf8')).toBe('done');
    expect(JSON.parse(readFileSync(path.join(directory, 'status.json'), 'utf8')).status).toBe('completed');
    expect(eventsOf(root, id).filter((event) => event.event === 'plugin.decision')).toHaveLength(1);
  } finally {
    lock.release();
  }
});

test('completeManuallyHeld refuses an existing session whose lock this process does not hold', () => {
  const { root, id } = stoppedSession();
  expect(() => new SessionStore(root).completeManuallyHeld(id)).toThrow('not locked by this process');
});

test('losing the lock before the artifact is applied writes nothing and fails the scope', async () => {
  const { root, id, directory } = stoppedSession();
  const handler: PluginHandler = () => {
    const file = path.join(directory, 'session.lock');
    const info = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...info, nonce: 'stolen' }), 'utf8');
    return Promise.resolve([{ kind: 'artifact', name: 'report.md', content: 'late' }]);
  };
  const lock = SessionLock.acquire(directory);
  try {
    await expect(withPluginScope(
      { workspace: root, sessionId: id },
      completionServices(handler),
      () => Promise.resolve(new SessionStore(root).completeManuallyHeld(id)),
    )).rejects.toThrow();
    expect(() => statSync(artifactOf(root, id))).toThrow();
    expect(eventsOf(root, id).some((event) => event.event === 'plugin.decision')).toBe(false);
  } finally {
    lock.release();
  }
});

test('a record failure after the write reaches the caller of withPluginScope without an explicit drain', async () => {
  const { root, id, directory } = stoppedSession();
  const original = sessionEventLog.record.bind(sessionEventLog);
  vi.spyOn(sessionEventLog, 'record').mockImplementation((dir, event) => {
    if (event.event === 'plugin.decision') throw new Error('log down');
    original(dir, event);
  });
  const lock = SessionLock.acquire(directory);
  try {
    await expect(withPluginScope(
      { workspace: root, sessionId: id },
      completionServices(propose('body')),
      () => Promise.resolve(new SessionStore(root).completeManuallyHeld(id)),
    )).rejects.toThrow('log down');
    expect(readFileSync(artifactOf(root, id), 'utf8')).toBe('body');
    expect(readPluginsInspection(directory)?.unrecorded).toEqual([{ path: 'plugins/demo/report.md', reason: 'no_decision' }]);
  } finally {
    lock.release();
  }
});
