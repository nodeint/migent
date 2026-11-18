import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Plugin, PluginRegistry, TSchema } from '@nodeint/migent-contracts';
import { ConfigurationError } from '@nodeint/migent-kernel';
import { createPreparedSession, SessionStore } from '@nodeint/migent-session';
import { afterEach, expect, test } from 'vitest';

import { type ExecuteRequest, HeldSession, openExecuteSession } from '../src/execute-session.ts';
import { FakeClient, registryOf, tempDir } from './support.ts';

const roots: string[] = [];
const helds: HeldSession[] = [];
afterEach(() => {
  for (const held of helds.splice(0)) held.lock?.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const clients = registryOf({ fake: new FakeClient('fake', 'fake') });
const schema = { type: 'object' } as unknown as TSchema;
const plugin = (id: string, extra: Partial<Plugin['manifest']> = {}): Plugin => ({
  manifest: {
    id, version: '1.0.0', apiVersion: { major: 1, minor: 0 }, advisory: false, configSchema: schema,
    uses: { operations: [], events: [], session: [], artifacts: [], agents: false, config: [] }, ...extra,
  },
  activate: () => undefined,
});
const registryOfPlugins = (...plugins: Plugin[]): PluginRegistry => ({
  ids: () => plugins.map((entry) => entry.manifest.id),
  get: (id) => plugins.find((entry) => entry.manifest.id === id),
});

const BASE = 'agents:\n  fake:\n    client: { type: fake }\n    model: m1\nroles:\n  developer:\n    agent: fake\n';
const WORKFLOW = 'schema_version: 7\nid: wf\nstages:\n  - id: one\n    role: developer\n';
const DEMO = 'plugins:\n  demo:\n    enabled: true\n  note:\n    enabled: true\n';

function workspaceWith(config: string): string {
  const workspace = tempDir('migent-plugin-open-');
  roots.push(workspace);
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), BASE + config, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), WORKFLOW, 'utf8');
  return workspace;
}

async function open(workspace: string, request: ExecuteRequest, pluginRegistry: PluginRegistry) {
  const held = new HeldSession();
  helds.push(held);
  const store = new SessionStore(workspace);
  return openExecuteSession(workspace, request, { held, registry: clients, store, pluginRegistry });
}

const eventsOf = (workspace: string, sessionId: string, name: string): { freeze_hash: string; plugins: unknown[] }[] =>
  readFileSync(path.join(workspace, '.migent', 'sessions', sessionId, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; data: never })
    .filter((entry) => entry.event === name)
    .map((entry) => entry.data);

const freezeFile = (workspace: string, id: string): string =>
  path.join(workspace, '.migent', 'sessions', id, 'workflow.frozen.yaml');

const registry = registryOfPlugins(plugin('demo'), plugin('note', { advisory: true }));

test('a created session returns its selection: frozen non-advisory and live advisory', async () => {
  const workspace = workspaceWith(DEMO);
  const opened = await open(workspace, { workflowId: 'wf', task: 'task' }, registry);
  if (opened.kind !== 'ready') throw new Error('expected ready');
  expect(opened.plugins.selected.map((entry) => [entry.id, entry.source])).toEqual([
    ['demo', 'frozen'],
    ['note', 'live'],
  ]);
  const [event] = eventsOf(workspace, opened.sessionId, 'plugins.frozen');
  expect(event?.freeze_hash).toBe(
    (await import('node:crypto')).createHash('sha256').update(readFileSync(freezeFile(workspace, opened.sessionId))).digest('hex'),
  );
});

test('a created session without a plugins key selects nothing and records no event', async () => {
  const workspace = workspaceWith('');
  const opened = await open(workspace, { workflowId: 'wf', task: 'task' }, registry);
  if (opened.kind !== 'ready') throw new Error('expected ready');
  expect(opened.plugins.selected).toEqual([]);
  expect(eventsOf(workspace, opened.sessionId, 'plugins.frozen')).toEqual([]);
});

test('an invalid enabled entry fails creation with a configuration error and leaves no session freeze', async () => {
  const workspace = workspaceWith('plugins:\n  ghost:\n    enabled: true\n');
  await expect(open(workspace, { workflowId: 'wf', task: 'task' }, registry)).rejects.toBeInstanceOf(ConfigurationError);
  await expect(open(workspace, { workflowId: 'wf', task: 'task' }, registry)).rejects.toMatchObject({ code: 'plugin-unregistered' });
  const sessions = path.join(workspace, '.migent', 'sessions');
  expect(() => readFileSync(path.join(sessions, '1', 'workflow.frozen.yaml'))).toThrow();
});

test.each([
  ['a scalar entry', 'plugins:\n  demo: 5\n'],
  ['a null entry', 'plugins:\n  demo:\n'],
])('%s fails creation', async (_name, config) => {
  const workspace = workspaceWith(config);
  await expect(open(workspace, { workflowId: 'wf', task: 'task' }, registry)).rejects.toBeInstanceOf(ConfigurationError);
});

test('a prepared session records plugins.frozen when it is activated, with a matching hash', async () => {
  const workspace = workspaceWith(DEMO);
  const sessionId = createPreparedSession(workspace, { title: 'prepared', workflowId: 'wf' });
  writeFileSync(path.join(workspace, '.migent', 'sessions', sessionId, 'task.md'), 'Do it.\n', 'utf8');
  const opened = await open(workspace, { sessionId, startPrepared: true }, registry);
  if (opened.kind !== 'ready') throw new Error('expected ready');
  expect(opened.plugins.selected.map((entry) => entry.id)).toEqual(['demo', 'note']);
  const hash = (await import('node:crypto')).createHash('sha256').update(readFileSync(freezeFile(workspace, sessionId))).digest('hex');
  expect(eventsOf(workspace, sessionId, 'plugins.frozen')[0]?.freeze_hash).toBe(hash);
  const events = eventsOf(workspace, sessionId, 'plugins.frozen');
  expect(events).toHaveLength(1);
});

test('an invalid entry stops a prepared activation before any freeze file is written', async () => {
  const workspace = workspaceWith('plugins:\n  ghost:\n    enabled: true\n');
  const sessionId = createPreparedSession(workspace, { title: 'prepared', workflowId: 'wf' });
  writeFileSync(path.join(workspace, '.migent', 'sessions', sessionId, 'task.md'), 'Do it.\n', 'utf8');
  const start = open(workspace, { sessionId, startPrepared: true }, registry);
  await expect(start).rejects.toBeInstanceOf(ConfigurationError);
  expect(() => readFileSync(freezeFile(workspace, sessionId))).toThrow();
  expect(eventsOf(workspace, sessionId, 'plugins.frozen')).toEqual([]);
});

test('a refresh records a new plugins.frozen event matching the new freeze', async () => {
  const workspace = workspaceWith(DEMO);
  const created = await open(workspace, { workflowId: 'wf', task: 'task' }, registry);
  if (created.kind !== 'ready') throw new Error('expected ready');
  helds[0]?.lock?.release();
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), `${WORKFLOW}  - id: two\n    role: developer\n    depends_on: [one]\n`, 'utf8');
  const refreshed = await open(workspace, { sessionId: created.sessionId, refreshWorkflow: true }, registry);
  if (refreshed.kind !== 'ready') throw new Error('expected ready');
  const events = eventsOf(workspace, created.sessionId, 'plugins.frozen');
  expect(events).toHaveLength(2);
  const hash = (await import('node:crypto')).createHash('sha256').update(readFileSync(freezeFile(workspace, created.sessionId))).digest('hex');
  expect(events[1]?.freeze_hash).toBe(hash);
});

test('a refresh with an invalid entry fails and keeps the existing freeze', async () => {
  const workspace = workspaceWith(DEMO);
  const created = await open(workspace, { workflowId: 'wf', task: 'task' }, registry);
  if (created.kind !== 'ready') throw new Error('expected ready');
  helds[0]?.lock?.release();
  const before = readFileSync(freezeFile(workspace, created.sessionId), 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), `${BASE}plugins:\n  ghost:\n    enabled: true\n`, 'utf8');
  await expect(
    open(workspace, { sessionId: created.sessionId, refreshWorkflow: true }, registry),
  ).rejects.toBeInstanceOf(ConfigurationError);
  expect(readFileSync(freezeFile(workspace, created.sessionId), 'utf8')).toBe(before);
  expect(eventsOf(workspace, created.sessionId, 'plugins.frozen')).toHaveLength(1);
});

test('resume stops before dispatch for a changed version, a removed plugin and a missing event', async () => {
  const workspace = workspaceWith(DEMO);
  const created = await open(workspace, { workflowId: 'wf', task: 'task' }, registry);
  if (created.kind !== 'ready') throw new Error('expected ready');
  helds[0]?.lock?.release();
  const upgraded = registryOfPlugins(plugin('demo', { version: '2.0.0' }), plugin('note', { advisory: true }));
  await expect(open(workspace, { sessionId: created.sessionId }, upgraded)).rejects.toMatchObject({ code: 'plugin-version-changed' });
  helds[1]?.lock?.release();
  const removed = registryOfPlugins(plugin('note', { advisory: true }));
  await expect(open(workspace, { sessionId: created.sessionId }, removed)).rejects.toBeInstanceOf(ConfigurationError);
  helds[2]?.lock?.release();
  const eventsFile = path.join(workspace, '.migent', 'sessions', created.sessionId, 'events.jsonl');
  const kept = readFileSync(eventsFile, 'utf8').split('\n').filter((line) => !line.includes('"plugins.frozen"')).join('\n');
  writeFileSync(eventsFile, kept, 'utf8');
  await expect(open(workspace, { sessionId: created.sessionId }, registry)).rejects.toBeInstanceOf(ConfigurationError);
});

test('a frozen session keeps its plugin config and target after live edits', async () => {
  const workspace = workspaceWith('plugins:\n  demo:\n    enabled: true\n    level: 1\n');
  const created = await open(workspace, { workflowId: 'wf', task: 'task' }, registry);
  if (created.kind !== 'ready') throw new Error('expected ready');
  helds[0]?.lock?.release();
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), `${BASE}plugins:\n  demo:\n    enabled: true\n    level: 9\n`, 'utf8');
  const resumed = await open(workspace, { sessionId: created.sessionId }, registry);
  if (resumed.kind !== 'ready') throw new Error('expected ready');
  expect(resumed.plugins.selected[0]?.config).toMatchObject({ level: 1 });
});

test('a live advisory edit is picked up on resume', async () => {
  const workspace = workspaceWith('plugins:\n  note:\n    enabled: true\n    mode: a\n');
  const created = await open(workspace, { workflowId: 'wf', task: 'task' }, registry);
  if (created.kind !== 'ready') throw new Error('expected ready');
  helds[0]?.lock?.release();
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), `${BASE}plugins:\n  note:\n    enabled: true\n    mode: b\n`, 'utf8');
  const resumed = await open(workspace, { sessionId: created.sessionId }, registry);
  if (resumed.kind !== 'ready') throw new Error('expected ready');
  expect(resumed.plugins.selected[0]?.config).toMatchObject({ mode: 'b' });
});

test('an advisory entry that becomes invalid is unavailable, and a removed advisory plugin too', async () => {
  const workspace = workspaceWith('plugins:\n  note:\n    enabled: true\n');
  const created = await open(workspace, { workflowId: 'wf', task: 'task' }, registry);
  if (created.kind !== 'ready') throw new Error('expected ready');
  helds[0]?.lock?.release();
  const resumed = await open(workspace, { sessionId: created.sessionId }, registryOfPlugins(plugin('demo')));
  if (resumed.kind !== 'ready') throw new Error('expected ready');
  expect(resumed.plugins.selected).toEqual([]);
  expect(resumed.plugins.unavailable.map((entry) => entry.id)).toEqual(['note']);
});

test('a local enabled:false override disables a plugin at the freeze', async () => {
  const workspace = workspaceWith(DEMO);
  writeFileSync(path.join(workspace, '.migent', 'config.local.yaml'), 'plugins:\n  demo:\n    enabled: false\n', 'utf8');
  const opened = await open(workspace, { workflowId: 'wf', task: 'task' }, registry);
  if (opened.kind !== 'ready') throw new Error('expected ready');
  expect(opened.plugins.selected.map((entry) => entry.id)).toEqual(['note']);
  const [event] = eventsOf(workspace, opened.sessionId, 'plugins.frozen');
  expect(event?.plugins).toContainEqual(expect.objectContaining({ id: 'demo', enabled: false }));
});

test('an entry added after the freeze is reported and not selected', async () => {
  const workspace = workspaceWith('plugins:\n  demo:\n    enabled: true\n');
  const created = await open(workspace, { workflowId: 'wf', task: 'task' }, registry);
  if (created.kind !== 'ready') throw new Error('expected ready');
  helds[0]?.lock?.release();
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), `${BASE}plugins:\n  demo:\n    enabled: true\n  later:\n    enabled: true\n`, 'utf8');
  const resumed = await open(workspace, { sessionId: created.sessionId }, registryOfPlugins(plugin('demo'), plugin('later')));
  if (resumed.kind !== 'ready') throw new Error('expected ready');
  expect(resumed.plugins.selected.map((entry) => entry.id)).toEqual(['demo']);
  expect(resumed.plugins.addedAfterFreeze).toContain('later');
});

test('a frozen session without plugins resumes while the live config is malformed', async () => {
  const workspace = workspaceWith('');
  const created = await open(workspace, { workflowId: 'wf', task: 'task' }, registry);
  if (created.kind !== 'ready') throw new Error('expected ready');
  helds[0]?.lock?.release();
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), 'agents: [broken yaml', 'utf8');
  const resumed = await open(workspace, { sessionId: created.sessionId }, registry);
  expect(resumed.kind).toBe('ready');
});

const AGENTIC = plugin('agentic', { uses: { operations: [], events: [], session: [], artifacts: [], agents: true, config: [] } });

test('a frozen session keeps the pinned agent target after the live agent changes', async () => {
  const workspace = workspaceWith('plugins:\n  agentic:\n    agent: fake\n');
  const reg = registryOfPlugins(AGENTIC);
  const created = await open(workspace, { workflowId: 'wf', task: 'task' }, reg);
  if (created.kind !== 'ready') throw new Error('expected ready');
  expect(created.plugins.selected[0]?.target).toMatchObject({ client: 'fake', model: 'm1' });
  helds[0]?.lock?.release();
  const live = BASE.replace('model: m1', 'model: m9');
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), `${live}plugins:\n  agentic:\n    agent: fake\n`, 'utf8');
  const resumed = await open(workspace, { sessionId: created.sessionId }, reg);
  if (resumed.kind !== 'ready') throw new Error('expected ready');
  expect(resumed.plugins.selected[0]?.target).toMatchObject({ client: 'fake', model: 'm1' });
  const [event] = eventsOf(workspace, created.sessionId, 'plugins.frozen');
  expect(event?.plugins[0]).toMatchObject({ id: 'agentic', target: { model: 'm1' } });
});

test.each([
  ['a scalar', 'plugins:\n  note: 5\n'],
  ['a null', 'plugins:\n  note:\n'],
  ['an invalid shared field', 'plugins:\n  note:\n    on_error: nope\n'],
])('an advisory entry that becomes %s after the freeze is unavailable and not selected', async (_name, edited) => {
  const workspace = workspaceWith('plugins:\n  note:\n    enabled: true\n');
  const created = await open(workspace, { workflowId: 'wf', task: 'task' }, registry);
  if (created.kind !== 'ready') throw new Error('expected ready');
  helds[0]?.lock?.release();
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), BASE + edited, 'utf8');
  const resumed = await open(workspace, { sessionId: created.sessionId }, registry);
  if (resumed.kind !== 'ready') throw new Error('expected ready');
  expect(resumed.plugins.selected).toEqual([]);
  expect(resumed.plugins.unavailable.map((entry) => entry.id)).toEqual(['note']);
});

const SECTIONS = [
  ['an empty section', 'plugins: {}\n', []],
  ['a disabled entry', 'plugins:\n  demo:\n    enabled: false\n', [{ id: 'demo', enabled: false }]],
] as const;

test.each(SECTIONS)('%s freezes at activation with matching event and file state', async (_name, section, entries) => {
  const workspace = workspaceWith(section);
  const sessionId = createPreparedSession(workspace, { title: 'prepared', workflowId: 'wf' });
  writeFileSync(path.join(workspace, '.migent', 'sessions', sessionId, 'task.md'), 'Do it.\n', 'utf8');
  const started = await open(workspace, { sessionId, startPrepared: true }, registry);
  if (started.kind !== 'ready') throw new Error('expected ready');
  expect(started.plugins.selected).toEqual([]);
  const [event] = eventsOf(workspace, sessionId, 'plugins.frozen');
  expect(event?.plugins).toEqual(entries.map((entry) => expect.objectContaining(entry)));
  const hash = (await import('node:crypto')).createHash('sha256').update(readFileSync(freezeFile(workspace, sessionId))).digest('hex');
  expect(event?.freeze_hash).toBe(hash);
});

test.each(SECTIONS)('%s freezes at refresh with matching event and file state', async (_name, section, entries) => {
  const workspace = workspaceWith(DEMO);
  const created = await open(workspace, { workflowId: 'wf', task: 'task' }, registry);
  if (created.kind !== 'ready') throw new Error('expected ready');
  helds[0]?.lock?.release();
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), BASE + section, 'utf8');
  const refreshed = await open(workspace, { sessionId: created.sessionId, refreshWorkflow: true }, registry);
  if (refreshed.kind !== 'ready') throw new Error('expected ready');
  expect(refreshed.plugins.selected).toEqual([]);
  const events = eventsOf(workspace, created.sessionId, 'plugins.frozen');
  expect(events).toHaveLength(2);
  expect(events[1]?.plugins).toEqual(entries.map((entry) => expect.objectContaining(entry)));
  const hash = (await import('node:crypto')).createHash('sha256').update(readFileSync(freezeFile(workspace, created.sessionId))).digest('hex');
  expect(events[1]?.freeze_hash).toBe(hash);
});

test('a plugin disabled at the freeze is not version-checked when it is later removed or upgraded', async () => {
  const workspace = workspaceWith('plugins:\n  demo:\n    enabled: false\n');
  const created = await open(workspace, { workflowId: 'wf', task: 'task' }, registry);
  if (created.kind !== 'ready') throw new Error('expected ready');
  helds[0]?.lock?.release();
  const upgraded = registryOfPlugins(plugin('demo', { version: '3.0.0' }));
  expect((await open(workspace, { sessionId: created.sessionId }, upgraded)).kind).toBe('ready');
  helds[1]?.lock?.release();
  expect((await open(workspace, { sessionId: created.sessionId }, registryOfPlugins())).kind).toBe('ready');
});

test('an unregistered id added after the freeze is reported and never selected', async () => {
  const workspace = workspaceWith('plugins:\n  demo:\n    enabled: true\n');
  const created = await open(workspace, { workflowId: 'wf', task: 'task' }, registry);
  if (created.kind !== 'ready') throw new Error('expected ready');
  helds[0]?.lock?.release();
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), `${BASE}plugins:\n  demo:\n    enabled: true\n  ghost:\n    enabled: true\n`, 'utf8');
  const resumed = await open(workspace, { sessionId: created.sessionId }, registry);
  if (resumed.kind !== 'ready') throw new Error('expected ready');
  expect(resumed.plugins.selected.map((entry) => entry.id)).toEqual(['demo']);
  expect(resumed.plugins.addedAfterFreeze).toContain('ghost');
});

test('a missing plugins.frozen event stops the resume with the refresh hint', async () => {
  const workspace = workspaceWith(DEMO);
  const created = await open(workspace, { workflowId: 'wf', task: 'task' }, registry);
  if (created.kind !== 'ready') throw new Error('expected ready');
  helds[0]?.lock?.release();
  const eventsFile = path.join(workspace, '.migent', 'sessions', created.sessionId, 'events.jsonl');
  const kept = readFileSync(eventsFile, 'utf8').split('\n').filter((line) => !line.includes('"plugins.frozen"')).join('\n');
  writeFileSync(eventsFile, kept, 'utf8');
  await expect(open(workspace, { sessionId: created.sessionId }, registry)).rejects.toThrow(/--refresh-workflow/);
});
