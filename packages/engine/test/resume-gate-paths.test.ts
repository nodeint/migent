import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createWorkflowSession, SessionStore } from '@nodeint/migent-session';
import { afterEach, expect, test } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { registryOf, ScriptedClient, tempDir as makeTempDir } from './support.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const root = makeTempDir(prefix);
  roots.push(root);
  return root;
}

const CONFIG = `\
agents:
  fake:
    client:
      type: fake
    model: m1
roles:
  developer:
    agent: fake
resume_policies:
  fake:
    match: { client: fake }
    cache_ttl: 1s
    on_expired: ask
`;

const ROUTE_BACK = `\
id: wf
stages:
  - id: implement
    role: developer
  - id: review
    role: developer
    depends_on: [implement]
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: implement
`;

const VERIFY = `\
id: wf
stages:
  - id: implement
    role: developer
    produces:
      artifact: notes.md
    max_verify: 1
    verify:
      - "echo bad && exit 1"
completion:
  stage: implement
`;

function setup(workflow: string): { workspace: string; sessionId: string } {
  const workspace = tempDir('migent-gate-paths-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), workflow, 'utf8');
  return { workspace, sessionId: createWorkflowSession(workspace, 'wf', { task: 'task' }) };
}

/** Moves every execution's end time past the 1s TTL. */
function ageAll(workspace: string, sessionId: string): void {
  const store = new SessionStore(workspace);
  for (const row of store.executionSnapshots(sessionId)) {
    const file = path.join(workspace, '.migent', 'sessions', sessionId, 'executions', row.executionId, 'execution.json');
    const metadata = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...metadata, completed_at: '2026-01-01T00:00:00.000+00:00' }));
  }
}

test('route back: a revise decision that would resume the expired implement conversation stops with exit 10', async () => {
  const { workspace, sessionId } = setup(ROUTE_BACK);
  const provider = new ScriptedClient(['status: complete\n\nimplemented', 'status: complete\ndecision: revise\n\nfix it', 'status: complete\n\nfixed']);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, maxDispatches: 2 }, runner);
  // The dispatch ceiling (5) ends the first run after implement and the revise decision.
  expect(first.code).toBe(5);
  expect(provider.calls).toHaveLength(2);
  ageAll(workspace, sessionId);
  const stopped = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner);
  expect(stopped.code).toBe(10);
  expect(stopped.status).toBe('expired');
  expect(provider.calls).toHaveLength(2);
  expect(new SessionStore(workspace).pendingResumes(sessionId)).toMatchObject([{ stageId: 'implement' }]);
});

test('verify repair: resuming an exhausted verify after the TTL stops with exit 10 and creates no execution', async () => {
  const { workspace, sessionId } = setup(VERIFY);
  const provider = new ScriptedClient(['status: complete\n\ndone', 'status: complete\n\ndone'], ['# n\n', null]);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner);
  expect(first.stopReason).toBe('verify_exhausted');
  ageAll(workspace, sessionId);
  const store = new SessionStore(workspace);
  const before = store.executionSnapshots(sessionId).length;
  const stopped = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, resetRevisions: true }, runner);
  expect(stopped.code).toBe(10);
  expect(provider.calls).toHaveLength(1);
  expect(store.executionSnapshots(sessionId)).toHaveLength(before);
  expect(store.pendingResumes(sessionId)).toMatchObject([{ stageId: 'implement' }]);
});

test('a refreshed workflow brings a stage on_expired override that wins over the policy (AC6)', async () => {
  const stage = '  - id: implement\n    role: developer\n    ask: human\n';
  const { workspace, sessionId } = setup(`id: wf\nstages:\n${stage}`);
  const question = 'status: question\n\n' + JSON.stringify({ schema_version: 1, questions: [{
    id: '1', question: 'Scope?', context: 'Needed.', selection: 'single',
    options: [{ id: 'A', label: 'Small' }, { id: 'B', label: 'Large' }],
  }] });
  const provider = new ScriptedClient([question, 'status: complete\n\nDone']);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner);
  expect(first.code).toBe(9);
  ageAll(workspace, sessionId);
  // The draft now sets the override while the policy says `ask`; the refresh brings it into the frozen session.
  writeFileSync(
    path.join(workspace, '.migent', 'workflows', 'wf.yaml'),
    `schema_version: 7\nid: wf\nstages:\n${stage}    session:\n      on_expired: fresh\n`,
    'utf8',
  );
  const done = await executeNamedWorkflow(workspace, { sessionId, reply: 'Small', refreshWorkflow: true }, runner);
  expect(done.code).toBe(0);
  expect(provider.calls[1]?.agentId).toBeNull();
  const events = readFileSync(path.join(workspace, '.migent', 'sessions', sessionId, 'events.jsonl'), 'utf8');
  expect(events).toContain('"origin":"stage"');
});
