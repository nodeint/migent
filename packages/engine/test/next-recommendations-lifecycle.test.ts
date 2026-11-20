import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createPluginRegistry } from '@nodeint/migent-plugins';
import { createWorkflowSession } from '@nodeint/migent-session';
import { afterEach, expect, test } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { pluginFreezeInput } from '../src/plugin-host/freeze.ts';
import { FakeClient, registryOf, ScriptedClient, tempDir } from './support.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const pluginRegistry = createPluginRegistry();
const clients = registryOf({ fake: new FakeClient('fake', 'fake') });

const config = (disabled: boolean) =>
  `agents:\n  fake:\n    client: { type: fake }\n    model: m1\nroles:\n  developer:\n    agent: fake\n${disabled ? 'plugins:\n  next:\n    enabled: false\n' : ''}`;
const DOWNSTREAM = 'downstream:\n  - workflow: implement\n    task: Build it\n  - workflow: ship\n    task: Release it\n';
const STAGES = 'stages:\n  - id: one\n    role: developer\n    ask: human\n';
const WITH = `schema_version: 8\nid: wf\n${DOWNSTREAM}${STAGES}`;
const WITHOUT = `schema_version: 8\nid: wf\n${STAGES}`;
const TWO_STAGES = 'stages:\n  - id: one\n    role: developer\n  - id: two\n    role: developer\n    depends_on: [one]\n    ask: human\n';
const TARGET = 'schema_version: 8\nid: implement\nstages:\n  - id: a\n    role: developer\n';
const SHIP = 'schema_version: 8\nid: ship\nstages:\n  - id: a\n    role: developer\n';

const QUESTION = 'status: question\n\n' + JSON.stringify({ schema_version: 1, questions: [{
  id: '1', question: 'Scope?', context: 'Needed.', selection: 'single',
  options: [{ id: 'A', label: 'Small' }, { id: 'B', label: 'Large' }],
}] });
const reply = (extra: Record<string, unknown> | null) =>
  `status: complete\n\ndone\n<<FILE>>${JSON.stringify({ schema_version: 1, status: 'complete', ...extra })}`;
const pick = (workflow: string | null, reason: string) => ({ next: { workflow, reason } });

interface Session { workspace: string; sessionId: string; directory: string }

function start(workflow: string, disabled = false): Session {
  const workspace = tempDir('migent-next-lifecycle-');
  roots.push(workspace);
  const workflows = path.join(workspace, '.migent', 'workflows');
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), config(disabled), 'utf8');
  writeFileSync(path.join(workflows, 'wf.yaml'), workflow, 'utf8');
  writeFileSync(path.join(workflows, 'implement.yaml'), TARGET, 'utf8');
  writeFileSync(path.join(workflows, 'ship.yaml'), SHIP, 'utf8');
  const sessionId = createWorkflowSession(workspace, 'wf', {
    task: 'task', resolveClient: clients, plugins: pluginFreezeInput(pluginRegistry, clients),
  });
  return { workspace, sessionId, directory: path.join(workspace, '.migent', 'sessions', sessionId) };
}

function runnerOf(provider: ScriptedClient, protocol?: number): AgentToolRunner {
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  runner.pluginRegistry = pluginRegistry;
  if (protocol !== undefined) runner.newConversationProtocol = protocol;
  return runner;
}

const run = (session: Session, provider: ScriptedClient, extra: Record<string, unknown> = {}, protocol?: number) =>
  executeNamedWorkflow(
    session.workspace, { workflowId: 'wf', sessionId: session.sessionId, ...extra }, runnerOf(provider, protocol),
  );

function artifact(session: Session): { schema_version: number; recommendations: Record<string, unknown>[] } | null {
  const file = path.join(session.directory, 'plugins', 'next', 'recommendations.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as never : null;
}

function executions(session: Session): Record<string, any>[] {
  const directory = path.join(session.directory, 'executions');
  return readdirSync(directory).sort().map((name) => JSON.parse(
    readFileSync(path.join(directory, name, 'execution.json'), 'utf8'),
  ) as Record<string, any>);
}

test('a missing payload gets an invalid_extension correction, then an abstention completes and is recorded', async () => {
  const session = start(WITH);
  const provider = new ScriptedClient([reply(null), reply(pick(null, 'nothing fits'))]);
  const result = await run(session, provider);
  expect(result.code).toBe(0);
  expect(provider.calls).toHaveLength(2);
  const [record] = executions(session);
  expect(record?.corrections.handoff).toMatchObject({ error_kind: 'invalid_extension' });
  expect(record?.response_extensions).toEqual({ next: { workflow: null, reason: 'nothing fits' } });
  expect(artifact(session)).toEqual({
    schema_version: 1,
    recommendations: [{ stage_id: 'one', execution_id: '0001-one--attempt-01', workflow: null, reason: 'nothing fits' }],
  });
});

test('the stage prompt lists the downstream ids and tasks and states that null abstains', async () => {
  const session = start(WITH);
  const provider = new ScriptedClient([reply(pick('implement', 'ready'))]);
  await run(session, provider);
  const prompt = provider.calls[0]?.prompt ?? '';
  expect(prompt).toContain('- `implement`: Build it');
  expect(prompt).toContain('- `ship`: Release it');
  expect(prompt).toContain('`null` to abstain');
});

test('a workflow id outside downstream is stored unchanged and flagged with a warning', async () => {
  const session = start(WITH);
  await run(session, new ScriptedClient([reply(pick('elsewhere', 'odd'))]));
  expect(executions(session)[0]?.response_extensions).toEqual({ next: { workflow: 'elsewhere', reason: 'odd' } });
  expect(artifact(session)?.recommendations[0]).toMatchObject({
    workflow: 'elsewhere', warning: 'elsewhere is not in downstream',
  });
});

test('a resume keeps the frozen instructions and an already stored payload byte for byte', async () => {
  const session = start(`schema_version: 8\nid: wf\n${DOWNSTREAM}${TWO_STAGES}`);
  const provider = new ScriptedClient([reply(pick('ship', '  padded  reason ')), QUESTION, reply(pick('implement', 'later'))]);
  expect((await run(session, provider)).code).toBe(9);
  const storedFile = path.join(session.directory, 'executions', '0001-one--attempt-01', 'execution.json');
  const frozenFile = path.join(session.directory, 'workflow.frozen.yaml');
  const [storedBefore, frozenBefore] = [readFileSync(storedFile, 'utf8'), readFileSync(frozenFile, 'utf8')];
  expect(artifact(session)?.recommendations).toEqual([
    { stage_id: 'one', execution_id: '0001-one--attempt-01', workflow: 'ship', reason: '  padded  reason ' },
  ]);
  writeFileSync(path.join(session.workspace, '.migent', 'workflows', 'wf.yaml'), `schema_version: 8\nid: wf\n${TWO_STAGES}`, 'utf8');
  expect((await run(session, provider, { reply: 'Small' })).code).toBe(0);
  expect(provider.calls[2]?.prompt).toContain('the required `next` key when complete');
  expect(readFileSync(storedFile, 'utf8')).toBe(storedBefore);
  expect(readFileSync(frozenFile, 'utf8')).toBe(frozenBefore);
  expect(artifact(session)?.recommendations).toEqual([
    { stage_id: 'one', execution_id: '0001-one--attempt-01', workflow: 'ship', reason: '  padded  reason ' },
    { stage_id: 'two', execution_id: '0003-two--attempt-02', workflow: 'implement', reason: 'later' },
  ]);
});

test('a populated artifact becomes an empty list when every stage latest completion has no payload', async () => {
  const session = start(`schema_version: 8
id: wf
${DOWNSTREAM}${TWO_STAGES}`);
  const provider = new ScriptedClient([reply(pick('ship', 'ready')), QUESTION, reply(null)]);
  expect((await run(session, provider)).code).toBe(9);
  expect(artifact(session)?.recommendations.map((entry) => entry.stage_id)).toEqual(['one']);
  const executionsDirectory = path.join(session.directory, 'executions');
  const rewrite = (id: string, change: (record: Record<string, unknown>) => void) => {
    const file = path.join(executionsDirectory, id, 'execution.json');
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    change(record);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}
`, 'utf8');
  };
  // Historical fixture: a later completed run of stage one that predates the extension keeps no payload, and
  // the paused stage two conversation was started on protocol 3. The older payload row stays on disk.
  cpSync(path.join(executionsDirectory, '0001-one--attempt-01'), path.join(executionsDirectory, '0003-one--attempt-02'), { recursive: true });
  rewrite('0003-one--attempt-02', (record) => {
    record.execution_id = '0003-one--attempt-02';
    record.execution_order = 3;
    record.stage_attempt = 2;
    delete record.response_extensions;
  });
  rewrite('0002-two--attempt-01', (record) => { record.response_protocol = 3; });
  expect(executions(session)[0]?.response_extensions).toEqual({ next: { workflow: 'ship', reason: 'ready' } });
  expect((await run(session, provider, { reply: 'Small' })).code).toBe(0);
  expect(artifact(session)).toEqual({ schema_version: 1, recommendations: [] });
  expect(executions(session)[0]?.response_extensions).toEqual({ next: { workflow: 'ship', reason: 'ready' } });
});

test('with the plugin disabled at creation the prompt has no recommendation request and no file appears', async () => {
  const session = start(WITH, true);
  const provider = new ScriptedClient([reply(null)]);
  expect((await run(session, provider)).code).toBe(0);
  expect(provider.calls[0]?.prompt).not.toContain('Response extensions');
  expect(artifact(session)).toBeNull();
});

test('a workflow without downstream is unchanged and gets no file', async () => {
  const session = start(WITHOUT);
  const provider = new ScriptedClient([reply(null)]);
  expect((await run(session, provider)).code).toBe(0);
  expect(provider.calls[0]?.prompt).not.toContain('Response extensions');
  expect(artifact(session)).toBeNull();
});

test('a conversation on protocol 3 is not asked and gets no file', async () => {
  const session = start(WITH);
  const provider = new ScriptedClient([reply(null)]);
  expect((await run(session, provider, {}, 3)).code).toBe(0);
  expect(provider.calls[0]?.prompt).not.toContain('Response extensions');
  expect(artifact(session)).toBeNull();
});

test('a refresh that removes downstream empties the list at the next execution.finished', async () => {
  const session = start(`schema_version: 8\nid: wf\n${DOWNSTREAM}${TWO_STAGES}`);
  const provider = new ScriptedClient([reply(pick('ship', 'ready')), QUESTION, reply(null)]);
  expect((await run(session, provider)).code).toBe(9);
  expect(artifact(session)?.recommendations).toHaveLength(1);
  writeFileSync(path.join(session.workspace, '.migent', 'workflows', 'wf.yaml'), `schema_version: 8\nid: wf\n${TWO_STAGES}`, 'utf8');
  expect((await run(session, provider, { reply: 'Small', refreshWorkflow: true })).code).toBe(0);
  expect(artifact(session)).toEqual({ schema_version: 1, recommendations: [] });
});
