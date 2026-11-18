import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Plugin, PluginRegistry, TSchema } from '@nodeint/migent-contracts';
import { createWorkflowSession, readWorkflowFreeze } from '@nodeint/migent-session';
import { afterEach, expect, test } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { pluginFreezeInput } from '../src/plugin-host/freeze.ts';
import { selectPlugins, withLivePlugins } from '../src/plugin-host/selection.ts';
import { FakeClient, registryOf, ScriptedClient, tempDir } from './support.ts';

const roots: string[] = [];
afterEach(() => {
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

function setup(pluginsYaml: string, registry: PluginRegistry): { workspace: string; directory: string } {
  const workspace = tempDir('migent-plugin-host-');
  roots.push(workspace);
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), BASE + pluginsYaml, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), WORKFLOW, 'utf8');
  const sessionId = createWorkflowSession(workspace, 'wf', {
    task: 'task',
    resolveClient: clients,
    plugins: pluginFreezeInput(registry, clients),
  });
  return { workspace, directory: path.join(workspace, '.migent', 'sessions', sessionId) };
}

const frozenEvents = (directory: string): { freeze_hash: string; plugins: Record<string, unknown>[] }[] =>
  readFileSync(path.join(directory, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; data: never })
    .filter((entry) => entry.event === 'plugins.frozen')
    .map((entry) => entry.data);

test('an empty plugins section freezes and selects nothing', () => {
  const registry = registryOfPlugins();
  const { workspace, directory } = setup('plugins: {}\n', registry);
  expect(frozenEvents(directory)).toHaveLength(1);
  expect(frozenEvents(directory)[0]?.plugins).toEqual([]);
  expect(selectPlugins(workspace, directory, { registry, clients }).selected).toEqual([]);
});

test('no plugins key records no plugins.frozen event', () => {
  const { workspace, directory } = setup('', registryOfPlugins());
  expect(frozenEvents(directory)).toEqual([]);
  expect(selectPlugins(workspace, directory, { registry: registryOfPlugins(), clients }).selected).toEqual([]);
});

test('an enabled plugin is frozen, recorded with its version, and selected', () => {
  const registry = registryOfPlugins(plugin('demo'));
  const { workspace, directory } = setup('plugins:\n  demo:\n    enabled: true\n', registry);
  const [event] = frozenEvents(directory);
  expect(event?.plugins).toEqual([{ id: 'demo', enabled: true, advisory: false, version: '1.0.0', target: null }]);
  expect(readWorkflowFreeze(directory)?.config.plugins?.kind).toBe('per_entry');
  const selection = selectPlugins(workspace, directory, { registry, clients });
  expect(selection.selected.map((entry) => [entry.id, entry.source])).toEqual([['demo', 'frozen']]);
});

test('an invalid or unregistered enabled entry fails the freeze and leaves no freeze file', () => {
  expect(() => setup('plugins:\n  ghost:\n    enabled: true\n', registryOfPlugins())).toThrow(/ghost/);
});

test('a disabled unregistered entry is frozen but not version-checked', () => {
  const registry = registryOfPlugins();
  const { workspace, directory } = setup('plugins:\n  ghost:\n    enabled: false\n', registry);
  expect(frozenEvents(directory)[0]?.plugins).toEqual([
    { id: 'ghost', enabled: false, advisory: false, version: null, target: null },
  ]);
  expect(selectPlugins(workspace, directory, { registry, clients }).selected).toEqual([]);
});

test('a changed plugin version stops the resume with the plugin id', () => {
  const { workspace, directory } = setup('plugins:\n  demo:\n    enabled: true\n', registryOfPlugins(plugin('demo')));
  const upgraded = registryOfPlugins(plugin('demo', { version: '2.0.0' }));
  expect(() => selectPlugins(workspace, directory, { registry: upgraded, clients })).toThrow(/demo.*version/s);
});

test('a missing plugin stops the resume', () => {
  const { workspace, directory } = setup('plugins:\n  demo:\n    enabled: true\n', registryOfPlugins(plugin('demo')));
  expect(() => selectPlugins(workspace, directory, { registry: registryOfPlugins(), clients })).toThrow(/demo/);
});

test('a freeze edited after recording is rejected with the refresh hint', () => {
  const registry = registryOfPlugins(plugin('demo'));
  const { workspace, directory } = setup('plugins:\n  demo:\n    enabled: true\n', registry);
  const file = path.join(directory, 'workflow.frozen.yaml');
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n# edited\n`, 'utf8');
  expect(() => selectPlugins(workspace, directory, { registry, clients })).toThrow(/--refresh-workflow/);
});

test('an advisory entry stays live and a live edit after freeze is picked up', () => {
  const registry = registryOfPlugins(plugin('note', { advisory: true }));
  const { workspace, directory } = setup('plugins:\n  note:\n    enabled: true\n', registry);
  expect(frozenEvents(directory)[0]?.plugins).toEqual([
    { id: 'note', enabled: true, advisory: true, version: '1.0.0', target: null },
  ]);
  const selection = selectPlugins(workspace, directory, { registry, clients });
  expect(selection.selected.map((entry) => [entry.id, entry.source])).toEqual([['note', 'live']]);
});

test('an entry added after the freeze is reported and not run when non-advisory', () => {
  const registry = registryOfPlugins(plugin('demo'), plugin('later'));
  const { workspace, directory } = setup('plugins:\n  demo:\n    enabled: true\n', registry);
  writeFileSync(
    path.join(workspace, '.migent', 'config.yaml'),
    `${BASE}plugins:\n  demo:\n    enabled: true\n  later:\n    enabled: true\n`,
    'utf8',
  );
  const selection = selectPlugins(workspace, directory, { registry, clients });
  expect(selection.selected.map((entry) => entry.id)).toEqual(['demo']);
  expect(selection.addedAfterFreeze).toContain('later');
});

test('an invokeAgent plugin pins its agent target in plugins.frozen', () => {
  const registry = registryOfPlugins(plugin('agentic', { uses: { operations: [], events: [], session: [], artifacts: [], agents: true, config: [] } }));
  const { directory } = setup('plugins:\n  agentic:\n    enabled: true\n    agent: fake\n', registry);
  const [entry] = frozenEvents(directory)[0]?.plugins ?? [];
  expect(entry?.target).toMatchObject({ client: 'fake', model: 'm1' });
});

const defaultPlugin = (id: string): Plugin => plugin(id, { defaultEnabled: true });
const chain = (workspace: string, directory: string, registry: PluginRegistry): string[] =>
  selectPlugins(workspace, directory, { registry, clients }).selected.map((entry) => `${entry.id}:${entry.source}`);
const frozenIds = (directory: string): unknown[] => frozenEvents(directory).at(-1)?.plugins.map((row) => row.id) ?? [];

test('selection and plugins.frozen keep configuration order, not id order', () => {
  const registry = registryOfPlugins(plugin('alpha'), plugin('beta'), plugin('gamma'));
  const { workspace, directory } = setup('plugins:\n  gamma: {}\n  alpha: {}\n  beta: {}\n', registry);
  expect(frozenIds(directory)).toEqual(['gamma', 'alpha', 'beta']);
  expect(chain(workspace, directory, registry)).toEqual(['gamma:frozen', 'alpha:frozen', 'beta:frozen']);
});

test('a default plugin is frozen with no plugins key, first, with empty options and its version', () => {
  const registry = registryOfPlugins(defaultPlugin('core'));
  const { workspace, directory } = setup('', registry);
  expect(frozenEvents(directory)[0]?.plugins).toEqual([
    { id: 'core', enabled: true, advisory: false, version: '1.0.0', target: null },
  ]);
  expect(chain(workspace, directory, registry)).toEqual(['core:frozen']);
});

test('enabled: false turns a default plugin off', () => {
  const registry = registryOfPlugins(defaultPlugin('core'));
  const { workspace, directory } = setup('plugins:\n  core:\n    enabled: false\n', registry);
  expect(chain(workspace, directory, registry)).toEqual([]);
});

test('unlisted defaults run first in registry order; a listed default keeps its position', () => {
  const registry = registryOfPlugins(defaultPlugin('d1'), defaultPlugin('d2'), plugin('user'));
  const unlisted = setup('plugins:\n  user: {}\n', registry);
  expect(chain(unlisted.workspace, unlisted.directory, registry)).toEqual(['d1:frozen', 'd2:frozen', 'user:frozen']);
  const listed = setup('plugins:\n  user: {}\n  d1: {}\n', registry);
  expect(chain(listed.workspace, listed.directory, registry)).toEqual(['d2:frozen', 'user:frozen', 'd1:frozen']);
});

test('an old freeze runs an unrecorded default implicitly first; a new freeze pins it', () => {
  const before = registryOfPlugins(plugin('user'));
  const { workspace, directory } = setup('plugins:\n  user: {}\n', before);
  const after = registryOfPlugins(defaultPlugin('core'), plugin('user'));
  expect(chain(workspace, directory, after)).toEqual(['core:implicit', 'user:frozen']);
  const inspected = withLivePlugins(
    { active: [], invocations: [], added_after_freeze: null, live_unavailable: null, holds: [], freeze_mismatch: null },
    { workspace, sessionDirectory: directory, registry: after },
  );
  expect(inspected.active.map((row) => [row.id, row.source])).toEqual([['core', 'implicit']]);
  const refreshed = setup('plugins:\n  user: {}\n', after);
  expect(chain(refreshed.workspace, refreshed.directory, after)).toEqual(['core:frozen', 'user:frozen']);
});

test('a default plugin that changes version stops the resume', () => {
  const { workspace, directory } = setup('', registryOfPlugins(defaultPlugin('core')));
  const upgraded = registryOfPlugins(plugin('core', { defaultEnabled: true, version: '2.0.0' }));
  expect(() => selectPlugins(workspace, directory, { registry: upgraded, clients })).toThrow(/core.*version/s);
});

test('an advisory entry keeps its declared place in the chain, in selection and inspection', () => {
  const registry = registryOfPlugins(plugin('adv', { advisory: true }), plugin('normal'));
  const { workspace, directory } = setup('plugins:\n  adv: {}\n  normal: {}\n', registry);
  expect(chain(workspace, directory, registry)).toEqual(['adv:live', 'normal:frozen']);
  const inspected = withLivePlugins(
    { ...EMPTY, active: [{ id: 'adv', version: '1.0.0', enabled: true, advisory: true }, { id: 'normal', version: '1.0.0', enabled: true, advisory: false }] },
    { workspace, sessionDirectory: directory, registry },
  );
  expect(inspected?.active.map((row) => row.id)).toEqual(['adv', 'normal']);
});

test('an unlisted advisory default runs live, and enabled: false or an explicit entry still applies', () => {
  const registry = registryOfPlugins(plugin('adv', { advisory: true, defaultEnabled: true }));
  const unlisted = setup('', registry);
  expect(chain(unlisted.workspace, unlisted.directory, registry)).toEqual(['adv:live']);
  const old = setup('', registryOfPlugins());
  expect(chain(old.workspace, old.directory, registry)).toEqual(['adv:implicit']);
  const off = setup('', registry);
  writeFileSync(path.join(off.workspace, '.migent', 'config.yaml'), `${BASE}plugins:\n  adv:\n    enabled: false\n`, 'utf8');
  expect(chain(off.workspace, off.directory, registry)).toEqual([]);
  const listed = setup('plugins:\n  adv: {}\n', registry);
  expect(chain(listed.workspace, listed.directory, registry)).toEqual(['adv:live']);
  writeFileSync(path.join(listed.workspace, '.migent', 'config.yaml'), BASE, 'utf8');
  expect(chain(listed.workspace, listed.directory, registry)).toEqual(['adv:live']);
});

const EMPTY = {
  active: [], invocations: [], added_after_freeze: null, live_unavailable: null, holds: [], freeze_mismatch: null,
};

test('a session with no plugin data shows an implicit default, and none without defaults', () => {
  const old = setup('', registryOfPlugins());
  const withDefault = registryOfPlugins(defaultPlugin('core'));
  const context = { workspace: old.workspace, sessionDirectory: old.directory };
  expect(withLivePlugins(null, { ...context, registry: withDefault })?.active)
    .toEqual([{ id: 'core', version: '1.0.0', enabled: true, advisory: false, source: 'implicit' }]);
  expect(withLivePlugins(null, { ...context, registry: registryOfPlugins() })).toBeNull();
});

test('--refresh-workflow on a continued old session pins the default; a later version change rejects the resume', async () => {
  const old = setup('plugins:\n  user: {}\n', registryOfPlugins(plugin('user')));
  const after = registryOfPlugins(defaultPlugin('core'), plugin('user'));
  expect(chain(old.workspace, old.directory, after)).toEqual(['core:implicit', 'user:frozen']);
  const runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient(['status: complete\n\ndone']) }), 10);
  runner.pluginRegistry = after;
  const sessionId = path.basename(old.directory);
  const resumed = await executeNamedWorkflow(old.workspace, { sessionId, workflowId: 'wf', refreshWorkflow: true }, runner);
  expect(resumed.code).toBe(0);
  expect(frozenIds(old.directory)).toEqual(['core', 'user']);
  expect(chain(old.workspace, old.directory, after)).toEqual(['core:frozen', 'user:frozen']);
  const upgraded = registryOfPlugins(plugin('core', { defaultEnabled: true, version: '2.0.0' }), plugin('user'));
  expect(() => selectPlugins(old.workspace, old.directory, { registry: upgraded, clients })).toThrow(/core.*version/s);
});
