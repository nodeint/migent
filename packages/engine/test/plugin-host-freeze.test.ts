import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Plugin, PluginRegistry, TSchema } from '@nodeint/migent-contracts';
import { createWorkflowSession, readWorkflowFreeze } from '@nodeint/migent-session';
import { afterEach, expect, test } from 'vitest';

import { pluginFreezeInput } from '../src/plugin-host/freeze.ts';
import { selectPlugins } from '../src/plugin-host/selection.ts';
import { FakeClient, registryOf, tempDir } from './support.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const clients = registryOf({ fake: new FakeClient('fake', 'fake') });
const schema = { type: 'object' } as unknown as TSchema;
const plugin = (id: string, extra: Partial<Plugin['manifest']> = {}): Plugin => ({
  manifest: { id, version: '1.0.0', advisory: false, hooks: [], capabilities: [], configSchema: schema, ...extra },
  handlers: {},
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
  const registry = registryOfPlugins(plugin('agentic', { capabilities: ['invokeAgent'] }));
  const { directory } = setup('plugins:\n  agentic:\n    enabled: true\n    agent: fake\n', registry);
  const [entry] = frozenEvents(directory)[0]?.plugins ?? [];
  expect(entry?.target).toMatchObject({ client: 'fake', model: 'm1' });
});
