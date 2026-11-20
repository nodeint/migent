import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type {
  ExtensionCatalog, Plugin, PluginHookInput, PluginRegistry, PluginSessionSnapshot, TObject, TSchema,
} from '@nodeint/migent-contracts';
import { afterEach, expect, test } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { registryOf, ScriptedClient, tempDir } from './support.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PAYLOAD = { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] };
const fieldOf = (id: string): TObject =>
  ({ type: 'object', properties: { [id]: PAYLOAD }, required: [] }) as unknown as TObject;

interface Seen { input: PluginHookInput; snapshot: PluginSessionSnapshot }
const seen: Record<string, Seen[]> = {};

function pluginOf(id: string, withContract: boolean): { plugin: Plugin; entry: ExtensionCatalog[number] } {
  const entry: ExtensionCatalog[number] = { plugin: id, version: 1, fields: { response: fieldOf(id) } };
  const plugin: Plugin = {
    manifest: {
      id, version: '1.0.0', apiVersion: { major: 1, minor: 2 }, advisory: false,
      configSchema: { type: 'object' } as unknown as TSchema,
      uses: { operations: [], events: ['execution.finished'], session: ['snapshot'], artifacts: [], agents: false, config: [] },
      extensions: entry,
    },
    responseContract: () => (withContract ? { required: false, instructions: `Note for ${id}.` } : null),
    activate: (_options, migent) => {
      migent.events.on('execution.finished', async (input, call) => {
        (seen[id] ??= []).push({ input, snapshot: await call.session.snapshot() });
        return [];
      });
    },
  };
  return { plugin, entry };
}

const CONFIG = 'agents:\n  fake:\n    client: { type: fake }\n    model: m1\nroles:\n  developer:\n    agent: fake\nplugins:\n  alpha: {}\n  beta: {}\n';
const WORKFLOW = 'schema_version: 2\nid: wf\nstages:\n  - id: one\n    role: developer\n';
const reply = (extra: Record<string, unknown>) =>
  `status: complete\n\ndone\n<<FILE>>${JSON.stringify({ schema_version: 1, status: 'complete', ...extra })}`;

async function runWith(betaContract: boolean, payload: Record<string, unknown>) {
  for (const key of Object.keys(seen)) delete seen[key];
  const alpha = pluginOf('alpha', true);
  const beta = pluginOf('beta', betaContract);
  const plugins = [alpha.plugin, beta.plugin];
  const registry: PluginRegistry = {
    ids: () => plugins.map((item) => item.manifest.id),
    get: (id) => plugins.find((item) => item.manifest.id === id),
  };
  const workspace = tempDir('migent-response-reads-');
  roots.push(workspace);
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), WORKFLOW, 'utf8');
  const extensions = [alpha.entry, beta.entry];
  const runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient([reply(payload)]) }), 10);
  runner.pluginRegistry = registry;
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', task: 'task', extensions }, runner);
  expect(result.code).toBe(0);
}

test('each plugin reads only its own payload in the hook input and in snapshot rows', async () => {
  await runWith(true, { alpha: { note: 'a' }, beta: { note: 'b' } });
  const [alpha] = seen.alpha ?? [];
  const [beta] = seen.beta ?? [];
  expect(alpha?.input.execution?.response_extension).toEqual({ note: 'a' });
  expect(beta?.input.execution?.response_extension).toEqual({ note: 'b' });
  expect(alpha?.snapshot.executions.map((row) => row.responseExtension)).toEqual([{ note: 'a' }]);
  expect(beta?.snapshot.executions.map((row) => row.responseExtension)).toEqual([{ note: 'b' }]);
  for (const view of [alpha, beta]) {
    expect(view?.snapshot.executions.map((row) => 'responseExtensions' in row)).toEqual([false]);
    expect(JSON.stringify(view?.snapshot.executions)).not.toContain(view === alpha ? '"b"' : '"a"');
  }
});

test('a plugin without a payload gets null and no snapshot field', async () => {
  await runWith(false, { alpha: { note: 'a' } });
  const [beta] = seen.beta ?? [];
  expect(beta?.input.execution?.response_extension).toBeNull();
  expect(beta?.snapshot.executions.map((row) => 'responseExtension' in row)).toEqual([false]);
  expect(beta?.snapshot.executions.map((row) => 'responseExtensions' in row)).toEqual([false]);
});
