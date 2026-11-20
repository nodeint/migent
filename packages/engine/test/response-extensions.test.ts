import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type {
  ExtensionCatalog, Plugin, PluginRegistry, PluginResponseContract, TObject, TSchema,
} from '@nodeint/migent-contracts';
import { createWorkflowSession } from '@nodeint/migent-session';
import { afterEach, expect, test } from 'vitest';

import { AgentToolRunner } from '../src/index.ts';
import { pluginFreezeInput } from '../src/plugin-host/freeze.ts';
import { FakeClient, holdSessionLock, registryOf, ScriptedClient, tempDir } from './support.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const clients = registryOf({ fake: new FakeClient('fake', 'fake') });
const payload = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
const catalog = (schema: object = payload): ExtensionCatalog => [{
  plugin: 'judge', version: 1,
  fields: { response: { type: 'object', properties: { judge: schema }, required: [] } as unknown as TObject },
}];
const judge = (responseContract: () => PluginResponseContract | null): Plugin => ({
  manifest: {
    id: 'judge', version: '1.0.0', apiVersion: { major: 1, minor: 2 }, advisory: false,
    configSchema: { type: 'object' } as unknown as TSchema,
    uses: { operations: [], events: [], session: [], artifacts: [], agents: false, config: [] },
    extensions: catalog()[0],
  },
  responseContract,
  activate: () => undefined,
});
const registryOfPlugins = (...plugins: Plugin[]): PluginRegistry => ({
  ids: () => plugins.map((entry) => entry.manifest.id),
  get: (id) => plugins.find((entry) => entry.manifest.id === id),
});

const CONFIG = 'agents:\n  fake:\n    client: { type: fake }\n    model: m1\nroles:\n  developer:\n    agent: fake\nplugins:\n  judge: {}\n';
const PASS = JSON.stringify(`"${process.execPath}" -e "process.exit(0)"`);
const WORKFLOW = `schema_version: 8
id: wf
stages:
  - id: one
    role: developer
    verify:
      - ${PASS}
`;
const REQUIRED = () => ({ required: true, instructions: 'Give a verdict.' });

function setup(
  contract: () => PluginResponseContract | null = REQUIRED,
): { workspace: string; sessionId: string } {
  const workspace = tempDir('migent-response-extensions-');
  roots.push(workspace);
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), WORKFLOW, 'utf8');
  const sessionId = createWorkflowSession(workspace, 'wf', {
    task: 'task', resolveClient: clients, plugins: pluginFreezeInput(registryOfPlugins(judge(contract)), clients),
    extensions: catalog(),
  });
  return { workspace, sessionId };
}

const reply = (extra: Record<string, unknown> | null) =>
  `status: complete\n\ndone\n<<FILE>>${JSON.stringify({ schema_version: 1, status: 'complete', ...extra })}`;

async function run(session: { workspace: string; sessionId: string }, provider: ScriptedClient, protocol?: number) {
  holdSessionLock(session.workspace, session.sessionId);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  if (protocol !== undefined) runner.newConversationProtocol = protocol;
  const result = await runner.run({
    client: 'fake', model: 'm1', prompt: 'go', workspace: session.workspace, sessionId: session.sessionId, stageId: 'one',
  });
  const directory = path.join(session.workspace, '.migent', 'sessions', session.sessionId, 'executions');
  const [name] = readdirSync(directory);
  const record = JSON.parse(readFileSync(path.join(directory, name, 'execution.json'), 'utf8')) as Record<string, any>;
  return { result, record };
}

test('a valid payload is stored beside the outcome, which and the events never carry it', async () => {
  const session = setup();
  const provider = new ScriptedClient([reply({ judge: { verdict: 'ship' } })]);
  const { record } = await run(session, provider);
  expect(provider.calls[0]?.prompt).toContain('## Response extensions');
  expect(provider.calls[0]?.prompt).toContain('- `judge` (required): Give a verdict.');
  expect(record.response_extensions).toEqual({ judge: { verdict: 'ship' } });
  expect(record.outcome).toEqual({ status: 'complete' });
  const events = readFileSync(path.join(session.workspace, '.migent', 'sessions', session.sessionId, 'events.jsonl'), 'utf8');
  expect(events).not.toContain('ship');
});

test('a missing required payload gets one correction with the full contract, then succeeds', async () => {
  const session = setup();
  const provider = new ScriptedClient([reply(null), reply({ judge: { verdict: 'ok' } })]);
  const { record } = await run(session, provider);
  expect(provider.calls).toHaveLength(2);
  expect(provider.calls[1]?.prompt).toContain('judge is required: Give a verdict.');
  expect(provider.calls[1]?.prompt).toContain('## Response extensions');
  expect(record.corrections.handoff).toMatchObject({ error_kind: 'invalid_extension' });
  expect(record.response_extensions).toEqual({ judge: { verdict: 'ok' } });
});

test('two invalid handoffs end with handoff_file_invalid and store no payload', async () => {
  const session = setup();
  const provider = new ScriptedClient([reply({ judge: { verdict: 1 } }), reply({ judge: {} })]);
  const { result, record } = await run(session, provider);
  expect(result.failure_reason).toBe('handoff_file_invalid');
  expect(record.response_extensions).toBeUndefined();
});

test('a stage with no active extension keeps today’s contract and rejects the key', async () => {
  const session = setup(() => null);
  const provider = new ScriptedClient([reply({ judge: { verdict: 'a' } }), reply(null)]);
  const { record } = await run(session, provider);
  expect(provider.calls[0]?.prompt).not.toContain('Response extensions');
  expect(record.corrections.handoff).toMatchObject({ error_kind: 'invalid_schema' });
  expect(record.response_extensions).toBeUndefined();
});

test('a protocol 3 conversation gets no section and rejects the extension key', async () => {
  const session = setup();
  const provider = new ScriptedClient([reply({ judge: { verdict: 'a' } }), reply(null)]);
  const { record } = await run(session, provider, 3);
  expect(provider.calls[0]?.prompt).not.toContain('Response extensions');
  expect(record.response_protocol).toBe(3);
  expect(record.corrections.handoff).toMatchObject({ error_kind: 'invalid_schema' });
});

test('the payload survives a passing verify run', async () => {
  const session = setup();
  const provider = new ScriptedClient([reply({ judge: { verdict: 'ship' } })]);
  const { record } = await run(session, provider);
  expect(record.verify).toBeDefined();
  expect(record.status).toBe('completed');
  expect(record.response_extensions).toEqual({ judge: { verdict: 'ship' } });
});
