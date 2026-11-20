import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ExtensionCatalog, PluginManifest } from '@nodeint/migent-contracts';
import { PluginContextClosed } from '@nodeint/migent-contracts';
import { writeWorkflowFreeze } from '@nodeint/migent-session';
import { parseWorkflowMapping } from '@nodeint/migent-workflow';
import { afterEach, expect, test } from 'vitest';

import { buildActivationContext, buildCallContext, emptyRegistrations } from '../src/plugin-host/context.ts';
import { configSources, coreWithoutExtensions } from '../src/plugin-host/extension-reads.ts';
import { InvocationState } from '../src/plugin-host/invocation.ts';
import { FakeClient, registryOf, tempDir } from './support.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// TypeBox schemas are plain JSON Schema objects.
const text = (key: string): never => {
  const schema: Record<string, unknown> = { type: 'object', properties: { [key]: { type: 'string' } } };
  return schema as never;
};
const catalog = (plugin: string, keys: [string, string, string, string]): ExtensionCatalog[number] => ({
  plugin,
  version: 1,
  fields: {
    workflow: text(keys[0]), stage: text(keys[1]), agent: text(keys[2]), role: text(keys[3]),
  },
});
const CATALOG: ExtensionCatalog = [
  catalog('demo', ['demo_wf', 'demo_st', 'demo_ag', 'demo_ro']),
  catalog('other', ['other_wf', 'other_st', 'other_ag', 'other_ro']),
];

const CONFIG = `agents:
  fake:
    client: { type: fake }
    model: m1
    demo_ag: agent-value
    unowned: kept
roles:
  developer:
    agent: fake
    demo_ro: role-value
`;
const WORKFLOW = {
  schema_version: 8,
  id: 'wf',
  demo_wf: 'workflow-value',
  stages: [{ id: 'one', role: 'developer', depends_on: [], demo_st: 'stage-value' }],
};

/** The session directory is the workspace itself: the freeze file and the live config sit side by side. */
function frozenSession(): { workspace: string; directory: string } {
  const workspace = tempDir('migent-extension-reads-');
  roots.push(workspace);
  mkdirSync(path.join(workspace, '.migent'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG, 'utf8');
  const workflow = parseWorkflowMapping(WORKFLOW, 'wf.yaml', { extensions: CATALOG });
  writeWorkflowFreeze(workspace, {
    workspace, workflow, resolveClient: registryOf({ fake: new FakeClient('fake', 'fake') }), extensions: CATALOG,
  });
  return { workspace, directory: workspace };
}

const OPEN_SCHEMA: Record<string, unknown> = { type: 'object' };
const MANIFEST = (id: string): PluginManifest => ({
  id, version: '1.0.0', apiVersion: { major: 1, minor: 0 }, advisory: false, configSchema: OPEN_SCHEMA as never,
  uses: { operations: [], events: [], session: [], artifacts: [], agents: false, config: [] },
});

type Session = { workspace: string; directory: string };
const sourcesFor = (session: Session, plugin: string) =>
  ({ manifest: MANIFEST(plugin), options: {}, ...configSources(session.workspace, session.directory, plugin) });

function contextFor(session: Session, plugin: string, invocation = new InvocationState()) {
  const sources = sourcesFor(session, plugin);
  return buildCallContext(sources, invocation, null);
}

test('a plugin reads its own frozen keys at all four levels, after the live files change', () => {
  const session = frozenSession();
  writeFileSync(path.join(session.workspace, '.migent', 'config.yaml'), 'agents: {}\n', 'utf8');
  const { extensions } = contextFor(session, 'demo').config;
  expect(extensions.workflow()).toEqual({ demo_wf: 'workflow-value' });
  expect(extensions.stage('one')).toEqual({ demo_st: 'stage-value' });
  expect(extensions.agent('one')).toEqual({ demo_ag: 'agent-value' });
  expect(extensions.role('developer')).toEqual({ demo_ro: 'role-value' });
  expect(Object.isFrozen(extensions.stage('one'))).toBe(true);
});

test('another plugin reads null for keys it does not own', () => {
  const { extensions } = contextFor(frozenSession(), 'other').config;
  expect([extensions.workflow(), extensions.stage('one'), extensions.agent('one'), extensions.role('developer')])
    .toEqual([null, null, null, null]);
  expect(extensions.stage('missing')).toBeNull();
});

test('a read after the invocation settles throws PluginContextClosed', () => {
  const invocation = new InvocationState();
  const { extensions } = contextFor(frozenSession(), 'demo', invocation).config;
  invocation.close();
  expect(() => extensions.workflow()).toThrow(PluginContextClosed);
  expect(() => extensions.role('developer')).toThrow(PluginContextClosed);
});

test('the activation context reads extensions too', () => {
  const session = frozenSession();
  const { context } = buildActivationContext(sourcesFor(session, 'demo'), new InvocationState(), emptyRegistrations());
  expect(context.config.extensions.workflow()).toEqual({ demo_wf: 'workflow-value' });
});

test('config.core agents and roles drop owned keys and keep every other field', () => {
  const agents = { fake: { client: 'c', demo_ag: 1, unowned: 'kept' } };
  const roles = { developer: { agent: { model: 'm', demo_ag: 2, unowned: 'kept' }, demo_ro: 3, other: 'kept' }, plain: 'x' };
  expect(coreWithoutExtensions('agents', agents, CATALOG)).toEqual({ fake: { client: 'c', unowned: 'kept' } });
  expect(coreWithoutExtensions('roles', roles, CATALOG))
    .toEqual({ developer: { agent: { model: 'm', unowned: 'kept' }, other: 'kept' }, plain: 'x' });
  expect(coreWithoutExtensions('agents', agents, [])).toEqual(agents);
  expect(coreWithoutExtensions('roles', roles, [])).toEqual(roles);
  expect(coreWithoutExtensions('other', agents, CATALOG)).toBe(agents);
});
