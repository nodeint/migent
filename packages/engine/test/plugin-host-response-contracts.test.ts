import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type {
  ExtensionCatalog, Plugin, PluginRegistry, PluginResponseContract, PluginResponseContractInput, TObject, TSchema,
} from '@nodeint/migent-contracts';
import { createWorkflowSession, loadFrozenWorkflow, readWorkflowFreeze, writeWorkflowFreeze } from '@nodeint/migent-session';
import { afterEach, describe, expect, test } from 'vitest';

import { pluginFreezeInput } from '../src/plugin-host/freeze.ts';
import { selectPlugins } from '../src/plugin-host/selection.ts';
import { FakeClient, registryOf, tempDir } from './support.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const clients = registryOf({ fake: new FakeClient('fake', 'fake') });
const payload = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
// TypeBox schemas are plain JSON Schema objects.
const responseField = { type: 'object', properties: { judge: payload }, required: [] } as unknown as TObject;
const catalog = (version = 1): ExtensionCatalog => [{ plugin: 'judge', version, fields: { response: responseField } }];

type Contract = (input: PluginResponseContractInput) => PluginResponseContract | null;
const judge = (responseContract: Contract, entries = catalog()): Plugin => ({
  manifest: {
    id: 'judge', version: '1.0.0', apiVersion: { major: 1, minor: 2 }, advisory: false,
    configSchema: { type: 'object' } as unknown as TSchema,
    uses: { operations: [], events: [], session: [], artifacts: [], agents: false, config: [] },
    extensions: entries[0],
  },
  responseContract,
  activate: () => undefined,
});
const registryOfPlugins = (...plugins: Plugin[]): PluginRegistry => ({
  ids: () => plugins.map((entry) => entry.manifest.id),
  get: (id) => plugins.find((entry) => entry.manifest.id === id),
});

const BASE = 'agents:\n  fake:\n    client: { type: fake }\n    model: m1\nroles:\n  developer:\n    agent: fake\n';
const WORKFLOW = 'schema_version: 8\nid: wf\nstages:\n  - id: one\n    role: developer\n  - id: two\n    role: developer\n    depends_on: [one]\n';

function setup(plugin: Plugin, pluginsYaml = 'plugins:\n  judge:\n    depth: 2\n'): { workspace: string; directory: string } {
  const workspace = tempDir('migent-response-contracts-');
  roots.push(workspace);
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), BASE + pluginsYaml, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), WORKFLOW, 'utf8');
  const sessionId = createWorkflowSession(workspace, 'wf', {
    task: 'task',
    resolveClient: clients,
    plugins: pluginFreezeInput(registryOfPlugins(plugin), clients),
    extensions: catalog(),
  });
  return { workspace, directory: path.join(workspace, '.migent', 'sessions', sessionId) };
}

const askStrict: Contract = (input) => (input.stage.id === 'two' ? { required: true, instructions: 'Give a verdict.' } : null);

describe('freezing response contracts through the host', () => {
  test('an active stage is frozen with its schema, and null leaves a stage out', () => {
    const { directory } = setup(judge(askStrict));
    const freeze = readWorkflowFreeze(directory);
    expect(freeze?.responseContracts).toEqual({ two: { judge: { required: true, instructions: 'Give a verdict.', schema: payload } } });
    expect(freeze?.extensions.records.judge.keys.response).toEqual(['judge']);
  });

  test('the plugin sees detached core data and its own options, with no plugin keys', () => {
    const seen: PluginResponseContractInput[] = [];
    setup(judge((input) => { seen.push(input); return null; }));
    const two = seen.find((input) => input.stage.id === 'two');
    expect(seen).toHaveLength(2);
    expect(two?.options).toEqual({ depth: 2 });
    expect(two?.extensions).toEqual({ stage: {}, workflow: {} });
    expect(two?.stage).toMatchObject({ id: 'two', role: 'developer' });
    expect(two?.workflow).toMatchObject({ id: 'wf' });
    expect(two?.workflow).not.toHaveProperty('stages');
    expect(Object.isFrozen(two?.options)).toBe(true);
  });

  test('a disabled plugin is not evaluated', () => {
    let calls = 0;
    const { directory } = setup(judge(() => { calls += 1; return null; }), 'plugins:\n  judge:\n    enabled: false\n');
    expect(calls).toBe(0);
    expect(readWorkflowFreeze(directory)?.responseContracts).toEqual({});
  });

  test.each([
    ['a throw', () => { throw new Error('boom'); }, /threw: boom/],
    ['a blank instruction', () => ({ required: true, instructions: '  ' }), /instructions/],
    ['a non-boolean required', () => JSON.parse('{"required":"yes","instructions":"x"}'), /required/],
  ] as const)('%s stops creation with plugin-response-contract-invalid', (_name, contract, message) => {
    expect(() => setup(judge(contract as Contract))).toThrow(expect.objectContaining({
      code: 'plugin-response-contract-invalid',
      path: ['plugins', 'judge', 'stages', 'one'],
      message: expect.stringMatching(message),
    }));
  });
});

describe('rewriting the freeze, as a workflow refresh does', () => {
  test('a changed plugin result is re-evaluated and persisted, and a null result removes the contract', () => {
    const session = setup(judge(askStrict));
    const rewrite = (contract: Contract): unknown => {
      const workflow = loadFrozenWorkflow(session.directory);
      if (workflow === null) throw new Error('no frozen workflow');
      return writeWorkflowFreeze(session.directory, {
        workspace: session.workspace,
        workflow,
        resolveClient: clients,
        plugins: pluginFreezeInput(registryOfPlugins(judge(contract)), clients),
        extensions: catalog(),
      });
    };
    rewrite((input) => ({ required: false, instructions: `Look at ${input.stage.id}.` }));
    expect(readWorkflowFreeze(session.directory)?.responseContracts).toEqual({
      one: { judge: { required: false, instructions: 'Look at one.', schema: payload } },
      two: { judge: { required: false, instructions: 'Look at two.', schema: payload } },
    });
    rewrite(() => null);
    expect(readWorkflowFreeze(session.directory)?.responseContracts).toEqual({});
  });
});

describe('resume gate for a response-only owner', () => {
  const select = (
    session: { workspace: string; directory: string },
    registry: PluginRegistry,
    extensions: ExtensionCatalog,
  ): unknown =>
    selectPlugins(session.workspace, session.directory, { registry, clients, extensions });

  test('an unregistered owner is extension-unregistered', () => {
    const session = setup(judge(askStrict));
    expect(() => select(session, registryOfPlugins(), catalog())).toThrow(expect.objectContaining({ code: 'extension-unregistered' }));
  });

  test('a changed extension version is extension-version-changed', () => {
    const session = setup(judge(askStrict));
    expect(() => select(session, registryOfPlugins(judge(askStrict, catalog(2))), catalog(2))).toThrow(
      expect.objectContaining({ code: 'extension-version-changed' }),
    );
  });

  test('a live enabled: false does not drop the frozen contract', () => {
    const session = setup(judge(askStrict));
    writeFileSync(path.join(session.workspace, '.migent', 'config.yaml'), `${BASE}plugins:\n  judge:\n    enabled: false\n`, 'utf8');
    expect(readWorkflowFreeze(session.directory)?.responseContracts.two.judge.required).toBe(true);
    expect(select(session, registryOfPlugins(judge(askStrict)), catalog())).toMatchObject({ selected: [{ id: 'judge', source: 'frozen' }] });
  });
});
