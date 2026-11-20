import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ExtensionCatalog, Plugin, PluginHandler, PluginRegistry, TSchema } from '@nodeint/migent-contracts';
import { StageOutcome } from '@nodeint/migent-kernel';
import { createWorkflowSession, readParsedEvents, readPluginsInspection, SessionLock, SessionStore } from '@nodeint/migent-session';
import { afterEach, describe, expect, test } from 'vitest';

import { completeSessionManually, withPluginScope } from '../src/index.ts';
import { pluginFreezeInput } from '../src/plugin-host/freeze.ts';
import { selectPlugins, withLivePlugins } from '../src/plugin-host/selection.ts';
import { FakeClient, registryOf, tempDir } from './support.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const clients = registryOf({ fake: new FakeClient('fake', 'fake') });
// TypeBox schemas are plain JSON Schema objects.
const looseSchema = { type: 'object' } as unknown as TSchema;
const strictSchema = { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'] } as unknown as TSchema;

const roleFields: Record<string, unknown> = { type: 'object', properties: { demo_role: { type: 'string' } }, required: [] };
const extension = (version: number): ExtensionCatalog => [{ plugin: 'demo', version, fields: { role: roleFields as never } }];

const plugin = (version: string, extras: Partial<Plugin['manifest']> = {}): Plugin => ({
  manifest: {
    id: 'demo', version, apiVersion: { major: 1, minor: 0 }, advisory: false, configSchema: looseSchema,
    uses: { operations: [], events: [], session: [], artifacts: [], agents: false, config: [] }, ...extras,
  },
  activate: () => undefined,
});
const registryWith = (...plugins: Plugin[]): PluginRegistry => ({
  ids: () => plugins.map((entry) => entry.manifest.id),
  get: (id) => plugins.find((entry) => entry.manifest.id === id),
});

const base = (withKey: boolean): string =>
  `agents:\n  fake:\n    client: { type: fake }\n    model: m1\nroles:\n  developer:\n    agent: fake\n${withKey ? '    demo_role: careful\n' : ''}`;
const WORKFLOW = [
  'schema_version: 8', 'id: wf', 'stages:', '  - id: one', '    role: developer',
  '  - id: two', '    role: developer', '    depends_on: [one]', '',
].join('\n');

interface Frozen {
  readonly catalog: ExtensionCatalog;
  readonly registry: PluginRegistry;
  readonly withKey?: boolean;
}

function setup(pluginsYaml: string, frozen: Frozen): { workspace: string; directory: string; sessionId: string } {
  const workspace = tempDir('migent-resume-gate-ext-');
  roots.push(workspace);
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), base(frozen.withKey ?? true) + pluginsYaml, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), WORKFLOW, 'utf8');
  const sessionId = createWorkflowSession(workspace, 'wf', {
    task: 'task',
    resolveClient: clients,
    plugins: pluginFreezeInput(frozen.registry, clients),
    extensions: frozen.catalog,
  });
  return { workspace, directory: path.join(workspace, '.migent', 'sessions', sessionId), sessionId };
}

const ENABLED = 'plugins:\n  demo:\n    enabled: true\n    mode: fast\n';
const DISABLED = 'plugins:\n  demo:\n    enabled: false\n';

const select = (
  session: { workspace: string; directory: string },
  registry: PluginRegistry,
  extensions: ExtensionCatalog,
): unknown => selectPlugins(session.workspace, session.directory, { registry, clients, extensions });

describe('resume gate step 1: extension owners', () => {
  const owners: [string, string, Partial<Plugin['manifest']>][] = [
    ['enabled', ENABLED, {}],
    ['disabled', DISABLED, {}],
    ['advisory', ENABLED, { advisory: true }],
  ];

  test.each(owners)('%s owner: an unregistered owner is extension-unregistered', (_name, yaml, extras) => {
    const session = setup(yaml, { catalog: extension(1), registry: registryWith(plugin('1.0.0', extras)) });
    expect(() => select(session, registryWith(), extension(1))).toThrow(
      expect.objectContaining({ code: 'extension-unregistered', message: expect.stringMatching(new RegExp(`demo.*${session.sessionId}`, 's')) }),
    );
  });

  test.each(owners)('%s owner: a changed extension version is extension-version-changed', (_name, yaml, extras) => {
    const session = setup(yaml, { catalog: extension(1), registry: registryWith(plugin('1.0.0', extras)) });
    expect(() => select(session, registryWith(plugin('1.0.0', extras)), extension(2))).toThrow(
      expect.objectContaining({ code: 'extension-version-changed', message: expect.stringMatching(/1.*2/s) }),
    );
  });

  test('inspection of the same session never runs the gate', () => {
    const { workspace, directory } = setup(ENABLED, { catalog: extension(1), registry: registryWith(plugin('1.0.0')) });
    const inspection = readPluginsInspection(directory);
    expect(inspection?.active.map((row) => [row.id, row.version])).toEqual([['demo', '1.0.0']]);
    const live = withLivePlugins(inspection, { workspace, sessionDirectory: directory, registry: registryWith() });
    expect(live?.live_unavailable).toBeNull();
    expect(live?.active.map((row) => [row.id, row.version])).toEqual([['demo', '1.0.0']]);
  });

  test('an owner with no frozen keys is not gated by step 1', () => {
    const session = setup(DISABLED, { catalog: extension(1), registry: registryWith(plugin('1.0.0')), withKey: false });
    const selection = selectPlugins(session.workspace, session.directory, {
      registry: registryWith(), clients, extensions: extension(1),
    });
    expect(selection.selected).toEqual([]);
  });
});

describe('resume gate step 2: the relaxed semver rule (AC7a)', () => {
  test('a changed semver with the same extension version and a valid entry runs at the new version', () => {
    const session = setup(ENABLED, { catalog: extension(1), registry: registryWith(plugin('1.0.0')) });
    const selection = selectPlugins(session.workspace, session.directory, {
      registry: registryWith(plugin('2.0.0')), clients, extensions: extension(1),
    });
    expect(selection.selected.map((entry) => [entry.id, entry.version, entry.source])).toEqual([['demo', '2.0.0', 'frozen']]);
  });

  test('a frozen entry the new configSchema rejects is plugin-version-changed and names the field', () => {
    const session = setup('plugins:\n  demo:\n    enabled: true\n', { catalog: extension(1), registry: registryWith(plugin('1.0.0')) });
    expect(() => select(session, registryWith(plugin('2.0.0', { configSchema: strictSchema })), extension(1))).toThrow(
      expect.objectContaining({ code: 'plugin-version-changed', message: expect.stringMatching(/mode/) }),
    );
  });

  test('a plugin without a catalog entry keeps the exact-semver rule', () => {
    const session = setup(ENABLED, { catalog: [], registry: registryWith(plugin('1.0.0')), withKey: false });
    expect(() => select(session, registryWith(plugin('2.0.0')), [])).toThrow(expect.objectContaining({ code: 'plugin-version-changed' }));
  });

  test('a catalog entry added after the freeze, with no record, keeps the exact-semver rule', () => {
    const session = setup(ENABLED, { catalog: [], registry: registryWith(plugin('1.0.0')), withKey: false });
    expect(() => select(session, registryWith(plugin('2.0.0')), extension(1))).toThrow(
      expect.objectContaining({ code: 'plugin-version-changed' }),
    );
  });

  test('a record with no keys and a different extension version is extension-version-changed', () => {
    const session = setup(ENABLED, { catalog: extension(1), registry: registryWith(plugin('1.0.0')), withKey: false });
    expect(() => select(session, registryWith(plugin('2.0.0')), extension(2))).toThrow(
      expect.objectContaining({ code: 'extension-version-changed' }),
    );
  });

  test('plugin-unregistered is unchanged for an enabled plugin that owns no keys', () => {
    const session = setup(ENABLED, { catalog: [], registry: registryWith(plugin('1.0.0')), withKey: false });
    expect(() => select(session, registryWith(), [])).toThrow(expect.objectContaining({ code: 'plugin-unregistered' }));
  });
});

describe('extension compatibility is independent of semver (review R1)', () => {
  test('an owner of no keys at unchanged semver is refused when the extension version changed', () => {
    const session = setup(ENABLED, { catalog: extension(1), registry: registryWith(plugin('1.0.0')), withKey: false });
    expect(() => select(session, registryWith(plugin('1.0.0')), extension(2))).toThrow(
      expect.objectContaining({ code: 'extension-version-changed' }),
    );
  });

  test('a frozen entry the manifest rejects is refused at unchanged semver', () => {
    const session = setup('plugins:\n  demo:\n    enabled: true\n', { catalog: extension(1), registry: registryWith(plugin('1.0.0')) });
    expect(() => select(session, registryWith(plugin('1.0.0', { configSchema: strictSchema })), extension(1))).toThrow(
      expect.objectContaining({ code: 'plugin-version-changed', message: expect.stringMatching(/mode/) }),
    );
  });
});

/** Runs the first stage so the session is stopped and manual completion applies. */
function stop(session: { workspace: string; directory: string; sessionId: string }): void {
  const store = new SessionStore(session.workspace);
  const lock = SessionLock.acquire(session.directory);
  try {
    const [record, , context] = store.loadOrCreate({
      client: 'fake', model: 'm1', options: {}, workspace: session.workspace, sessionId: session.sessionId, stageId: 'one',
      stageAttempt: null, executionOrder: null, prompt: 'one',
    });
    store.saveExecution(context, record, { status: 'running' });
    store.saveExecution(context, record, { status: 'completed', outcome: new StageOutcome('complete') });
  } finally {
    lock.release();
  }
}

const completionPlugin = (seen: string[], version = '1.0.0'): Plugin => {
  const handler: PluginHandler = (input) => {
    seen.push(input.hook);
    return Promise.resolve([]);
  };
  const base = plugin(version);
  return {
    manifest: { ...base.manifest, uses: { ...base.manifest.uses, events: ['session.completed'] } },
    activate: (_options, migent) => {
      migent.events.on('session.completed', handler);
    },
  };
};

const eventsOf = (directory: string) => readParsedEvents(path.join(directory, 'events.jsonl'));

describe('events record the version that ran', () => {
  test('after a compatible semver upgrade the hook event has the new version and plugins.frozen keeps the old one', async () => {
    const session = setup(ENABLED, { catalog: extension(1), registry: registryWith(plugin('1.0.0')) });
    stop(session);
    const seen: string[] = [];
    const upgraded = registryWith(completionPlugin(seen, '2.0.0'));
    const selection = selectPlugins(session.workspace, session.directory, {
      registry: upgraded, clients, extensions: extension(1),
    });
    const lock = SessionLock.acquire(session.directory);
    try {
      await withPluginScope(
        { workspace: session.workspace, sessionId: session.sessionId },
        { selection, plugins: upgraded, clients },
        () => Promise.resolve(new SessionStore(session.workspace).completeManuallyHeld(session.sessionId)),
      );
    } finally {
      lock.release();
    }
    expect(seen).toEqual(['session.completed']);
    const events = eventsOf(session.directory);
    expect(events.filter((event) => event.event === 'plugin.hook_invoked').map((event) => event.data.version)).toEqual(['2.0.0']);
    expect(events.find((event) => event.event === 'plugins.frozen')?.data.plugins).toMatchObject([{ id: 'demo', version: '1.0.0' }]);
  });
});

describe('manual completion never runs the extension gate (review R2)', () => {
  test('completion hooks still run when only the extension gate would refuse', async () => {
    const session = setup(ENABLED, { catalog: extension(1), registry: registryWith(plugin('1.0.0')) });
    stop(session);
    const seen: string[] = [];
    const registry = registryWith(completionPlugin(seen));
    // The production catalog is empty, so a resume would refuse: the freeze owns keys at extension version 1.
    expect(() => selectPlugins(session.workspace, session.directory, { registry, clients })).toThrow(
      expect.objectContaining({ code: 'extension-version-changed' }),
    );
    const services = { pluginRegistry: registry, clients };
    const outcome = await completeSessionManually(session.workspace, session.sessionId, services);
    expect(outcome.pluginWarning).toBeNull();
    expect(seen).toEqual(['session.completed']);
  });
});
