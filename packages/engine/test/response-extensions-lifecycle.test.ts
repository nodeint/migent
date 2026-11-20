import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  type ExtensionCatalog, type Plugin, type PluginRegistry, type PluginResponseContract, type TObject,
  type TSchema,
} from '@nodeint/migent-contracts';
import { createWorkflowSession } from '@nodeint/migent-session';
import { afterEach, expect, test } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { pluginFreezeInput } from '../src/plugin-host/freeze.ts';
import { FakeClient, registryOf, ScriptedClient, tempDir } from './support.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const VERDICT = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
const STRICT = {
  type: 'object', properties: { verdict: { type: 'string' }, note: { type: 'string' } }, required: ['verdict', 'note'],
};
const responseField = (schema: object): TObject =>
  ({ type: 'object', properties: { judge: schema }, required: [] }) as unknown as TObject;

/** The live catalog entry and plugin result; a test edits them to model a same-version change after the freeze. */
const live: { contract: PluginResponseContract | null } = { contract: null };
const entry: ExtensionCatalog[number] = { plugin: 'judge', version: 1, fields: { response: responseField(VERDICT) } };
const setSchema = (schema: object): void => {
  (entry.fields as Record<string, TObject>).response = responseField(schema);
};
const REQUIRED: PluginResponseContract = { required: true, instructions: 'Give a verdict.' };

const plugin: Plugin = {
  manifest: {
    id: 'judge', version: '1.0.0', apiVersion: { major: 1, minor: 2 }, advisory: false,
    configSchema: { type: 'object' } as unknown as TSchema,
    uses: { operations: [], events: [], session: [], artifacts: [], agents: false, config: [] },
    extensions: entry,
  },
  responseContract: () => live.contract,
  activate: () => undefined,
};
const pluginRegistry: PluginRegistry = {
  ids: () => ['judge'],
  get: (id) => (id === 'judge' ? plugin : undefined),
};

afterEach(() => {
  live.contract = null;
  setSchema(VERDICT);
});

const clients = registryOf({ fake: new FakeClient('fake', 'fake') });
const CONFIG = 'agents:\n  fake:\n    client: { type: fake }\n    model: m1\nroles:\n  developer:\n    agent: fake\nplugins:\n  judge: {}\n';
const ASKING = 'schema_version: 8\nid: wf\nstages:\n  - id: one\n    role: developer\n    ask: human\n';
const ROUTED = `id: wf
stages:
  - id: one
    role: developer
  - id: two
    role: developer
    depends_on: [one]
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: one
`;

const QUESTION = 'status: question\n\n' + JSON.stringify({ schema_version: 1, questions: [{
  id: '1', question: 'Scope?', context: 'Needed.', selection: 'single',
  options: [{ id: 'A', label: 'Small' }, { id: 'B', label: 'Large' }],
}] });
const reply = (extra: Record<string, unknown> | null) =>
  `status: complete\n\ndone\n<<FILE>>${JSON.stringify({ schema_version: 1, status: 'complete', ...extra })}`;

function start(workflow: string, contract: PluginResponseContract | null): { workspace: string; sessionId: string } {
  live.contract = contract;
  const workspace = tempDir('migent-extension-lifecycle-');
  roots.push(workspace);
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), workflow, 'utf8');
  const sessionId = createWorkflowSession(workspace, 'wf', {
    task: 'task', resolveClient: clients, plugins: pluginFreezeInput(pluginRegistry, clients), extensions: [entry],
  });
  return { workspace, sessionId };
}

function runnerOf(provider: ScriptedClient, protocol?: number): AgentToolRunner {
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  runner.pluginRegistry = pluginRegistry;
  if (protocol !== undefined) runner.newConversationProtocol = protocol;
  return runner;
}

function lastExecution(session: { workspace: string; sessionId: string }): Record<string, any> {
  const directory = path.join(session.workspace, '.migent', 'sessions', session.sessionId, 'executions');
  const name = readdirSync(directory).sort().at(-1) ?? '';
  return JSON.parse(readFileSync(path.join(directory, name, 'execution.json'), 'utf8')) as Record<string, any>;
}

/** Asks the first question under the freeze, then answers it after `change`, so the second run continues it. */
async function continued(
  protocol: number | undefined,
  options: { contract: PluginResponseContract | null; change: () => void; refresh: boolean; replies: string[] },
) {
  const session = start(ASKING, options.contract);
  const provider = new ScriptedClient([QUESTION, ...options.replies]);
  const first = await executeNamedWorkflow(
    session.workspace, { workflowId: 'wf', sessionId: session.sessionId, extensions: [entry] }, runnerOf(provider, protocol),
  );
  expect(first.code).toBe(9);
  options.change();
  const result = await executeNamedWorkflow(
    session.workspace,
    { sessionId: session.sessionId, reply: 'Small', extensions: [entry], ...(options.refresh ? { refreshWorkflow: true } : {}) },
    runnerOf(provider),
  );
  return { session, provider, result, record: lastExecution(session) };
}

const REMINDER = 'and the required `judge` key when complete';

test('a resume without refresh keeps the frozen schema and instructions after a same-version live edit', async () => {
  const { provider, record } = await continued(undefined, {
    contract: { required: true, instructions: 'Frozen instructions.' }, refresh: false,
    change: () => {
      live.contract = { required: true, instructions: 'LIVE instructions.' };
      setSchema(STRICT);
    },
    replies: [reply(null), reply({ judge: { verdict: 'ok' } })],
  });
  expect(provider.calls[1]?.prompt).toContain(REMINDER);
  expect(provider.calls[2]?.prompt).toContain('judge is required: Frozen instructions.');
  expect(provider.calls[2]?.prompt).toContain('"required":["verdict"]');
  expect(provider.calls[2]?.prompt).not.toContain('LIVE instructions.');
  expect(record.corrections.handoff).toMatchObject({ error_kind: 'invalid_extension' });
  expect(record.response_extensions).toEqual({ judge: { verdict: 'ok' } });
});

test('a refresh that adds a required key, omitted at first, gets the reminder, one correction and then succeeds', async () => {
  const { provider, record } = await continued(undefined, {
    contract: null, refresh: true, change: () => { live.contract = REQUIRED; },
    replies: [reply(null), reply({ judge: { verdict: 'ok' } })],
  });
  expect(provider.calls[1]?.prompt).toContain(REMINDER);
  expect(provider.calls[2]?.prompt).toContain('## Response extensions');
  expect(provider.calls[2]?.prompt).toContain('- `judge` (required): Give a verdict.');
  expect(provider.calls[2]?.prompt).toContain('judge is required: Give a verdict.');
  expect(provider.calls[2]?.prompt).toContain('"required":["verdict"]');
  expect(record.corrections.handoff).toMatchObject({ error_kind: 'invalid_extension' });
  expect(record.response_extensions).toEqual({ judge: { verdict: 'ok' } });
});

test('a refresh that changes the schema brings the new schema into the correction and the check', async () => {
  const { provider, record } = await continued(undefined, {
    contract: REQUIRED, refresh: true, change: () => { setSchema(STRICT); },
    replies: [reply({ judge: { verdict: 'ok' } }), reply({ judge: { verdict: 'ok', note: 'n' } })],
  });
  expect(provider.calls[2]?.prompt).toContain('"required":["verdict","note"]');
  expect(provider.calls[2]?.prompt).toContain('must have required properties note');
  expect(record.response_extensions).toEqual({ judge: { verdict: 'ok', note: 'n' } });
});

test('a refresh that removes the extension drops the reminder key and rejects the key as invalid_schema', async () => {
  const { provider, record } = await continued(undefined, {
    contract: REQUIRED, refresh: true, change: () => { live.contract = null; },
    replies: [reply({ judge: { verdict: 'a' } }), reply(null)],
  });
  expect(provider.calls[1]?.prompt).not.toContain(REMINDER);
  expect(provider.calls[2]?.prompt).not.toContain('Response extensions');
  expect(record.corrections.handoff).toMatchObject({ error_kind: 'invalid_schema' });
  expect(record.response_extensions).toBeUndefined();
});

test('a refreshed contract that stays unmet ends with handoff_file_invalid and stores no payload', async () => {
  const { provider, result, record } = await continued(undefined, {
    contract: null, refresh: true, change: () => { live.contract = REQUIRED; },
    replies: [reply(null), reply({ judge: {} })],
  });
  expect(provider.calls).toHaveLength(3);
  expect(provider.calls[2]?.prompt).toContain('judge is required: Give a verdict.');
  expect(record.failure_reason).toBe('handoff_file_invalid');
  expect(result.code).not.toBe(0);
  expect(record.response_extensions).toBeUndefined();
});

test('a protocol 3 conversation keeps its stamp and rejects the key after a refresh adds an extension', async () => {
  const { provider, record } = await continued(3, {
    contract: null, refresh: true, change: () => { live.contract = REQUIRED; },
    replies: [reply({ judge: { verdict: 'a' } }), reply(null)],
  });
  expect(record.response_protocol).toBe(3);
  expect(provider.calls[1]?.prompt).not.toContain(REMINDER);
  expect(provider.calls[2]?.prompt).not.toContain('Response extensions');
  expect(record.corrections.handoff).toMatchObject({ error_kind: 'invalid_schema' });
  expect(record.response_extensions).toBeUndefined();
});

test('the scheduler routes on the decision while every stage stores its payload', async () => {
  const session = start(ROUTED, REQUIRED);
  const withDecision = (decision: string, verdict: string) =>
    `status: complete\ndecision: ${decision}\n\ndone\n<<FILE>>${JSON.stringify({
      schema_version: 1, status: 'complete', decision, judge: { verdict },
    })}`;
  const provider = new ScriptedClient([
    reply({ judge: { verdict: 'one-a' } }), withDecision('revise', 'two-a'),
    reply({ judge: { verdict: 'one-b' } }), withDecision('approved', 'two-b'),
  ]);
  const result = await executeNamedWorkflow(
    session.workspace, { workflowId: 'wf', sessionId: session.sessionId, extensions: [entry] }, runnerOf(provider),
  );
  expect(result.code).toBe(0);
  expect(result.latestDecision).toBe('approved');
  expect(provider.calls).toHaveLength(4);
  const directory = path.join(session.workspace, '.migent', 'sessions', session.sessionId);
  const stored = readdirSync(path.join(directory, 'executions')).sort().map((name) => (JSON.parse(
    readFileSync(path.join(directory, 'executions', name, 'execution.json'), 'utf8'),
  ) as Record<string, any>).response_extensions?.judge?.verdict);
  expect(stored).toEqual(['one-a', 'two-a', 'one-b', 'two-b']);
  for (const name of ['status.json', 'events.jsonl']) {
    expect(readFileSync(path.join(directory, name), 'utf8')).not.toContain('two-b');
  }
});
