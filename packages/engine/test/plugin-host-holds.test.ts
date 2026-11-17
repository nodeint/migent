import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createWorkflowSession, readParsedEvents, SessionLock, SessionStore } from '@nodeint/migent-session';
import { expect, test } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { recordPluginFailure } from '../src/plugin-host/holds.ts';
import { registryOf, ScriptedClient, tempDir } from './support.ts';

const CONFIG = 'agents:\n  fake:\n    client: { type: fake }\n    model: m1\nroles:\n  developer:\n    agent: fake\n';
const CHAIN = 'schema_version: 2\nid: chain\nstages:\n  - id: a\n    role: developer\n  - id: b\n    role: developer\n    depends_on: [a]\n';
const FAN = `schema_version: 2
id: fan
concurrency: 2
stages:
  - id: a
    role: developer
  - id: b
    role: developer
  - id: c
    role: developer
    depends_on: [a, b]
`;
const DONE = 'status: complete\n\ndone';

/** Records a plugin failure through the host API while its first stage runs, as a hook would. */
class HoldingClient extends ScriptedClient {
  constructor(responses: string[], private readonly hold: () => void) {
    super(responses);
  }

  private fired = false;

  public override parseResponse(): [string, string | null] {
    if (!this.fired) {
      this.fired = true;
      this.hold();
    }
    return super.parseResponse();
  }
}

function workspaceWith(workflowId = 'chain', text = CHAIN): string {
  const workspace = tempDir('migent-holds-run-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', `${workflowId}.yaml`), text, 'utf8');
  return workspace;
}

const directoryOf = (workspace: string, sessionId: string): string => path.join(workspace, '.migent', 'sessions', sessionId);
const statusOf = (workspace: string, sessionId: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(directoryOf(workspace, sessionId), 'status.json'), 'utf8')) as Record<string, unknown>;
const stagesOf = (workspace: string, sessionId: string): string[] =>
  new SessionStore(workspace).executionSnapshots(sessionId).map((item) => item.stageId);
/** Hash of every file under each execution directory, so a rewritten outcome or conversation file shows. */
function executionFiles(workspace: string, sessionId: string): Record<string, Record<string, string>> {
  const root = path.join(directoryOf(workspace, sessionId), 'executions');
  const walk = (directory: string, base: string, out: Record<string, string>): Record<string, string> => {
    for (const name of readdirSync(directory)) {
      const full = path.join(directory, name);
      if (statSync(full).isDirectory()) walk(full, `${base}${name}/`, out);
      else out[`${base}${name}`] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
    return out;
  };
  return Object.fromEntries(readdirSync(root).map((id) => [id, walk(path.join(root, id), '', {})] as const));
}
const outcomesOf = (workspace: string, sessionId: string): Record<string, string> =>
  Object.fromEntries(
    new SessionStore(workspace).executionSnapshots(sessionId).map((item) => [item.executionId, item.status] as const),
  );

async function runWithHold(onError: 'stop' | 'fail' | 'ignore', options: { maxDispatches?: number } = {}) {
  const workspace = workspaceWith();
  const sessionId = createWorkflowSession(workspace, 'chain', { task: 'go' });
  const hold = () =>
    recordPluginFailure(workspace, sessionId, { plugin: 'demo', hook: 'execution.finished', invocationId: 'i1', reason: 'error', error: 'boom', onError });
  const client = new HoldingClient([DONE, DONE], hold);
  const runner = new AgentToolRunner(registryOf({ fake: client }), 10);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'chain', sessionId, ...options }, runner);
  return { workspace, sessionId, result, runner, client };
}

test('a stop hold dispatches no new stage, ends blocked and exits 1', async () => {
  const { workspace, sessionId, result } = await runWithHold('stop');
  expect(stagesOf(workspace, sessionId)).toEqual(['a']);
  expect(Object.values(outcomesOf(workspace, sessionId))).toEqual(['completed']);
  expect(result.code).toBe(1);
  expect(result.status).toBe('blocked');
  const status = statusOf(workspace, sessionId);
  expect(status.status).toBe('blocked');
  expect(status.plugin_holds).toMatchObject([{ plugin: 'demo', on_error: 'stop' }]);
});

test('a fail hold dispatches no new stage, keeps the session active and exits 1', async () => {
  const { workspace, sessionId, result } = await runWithHold('fail');
  expect(stagesOf(workspace, sessionId)).toEqual(['a']);
  expect(result.code).toBe(1);
  expect(result.status).toBe('active');
  expect(statusOf(workspace, sessionId).status).toBe('active');
  expect(statusOf(workspace, sessionId).plugin_holds).toMatchObject([{ on_error: 'fail' }]);
});

test('an ignore failure sets no hold and the run completes as without a plugin', async () => {
  const { workspace, sessionId, result } = await runWithHold('ignore');
  expect(stagesOf(workspace, sessionId)).toEqual(['a', 'b']);
  expect(result.code).toBe(0);
  expect(statusOf(workspace, sessionId)).not.toHaveProperty('plugin_holds');
});

test.each(['stop', 'fail'] as const)('continue resolves a %s hold, runs the remaining stage and completes', async (onError) => {
  const { workspace, sessionId } = await runWithHold(onError);
  const before = executionFiles(workspace, sessionId);
  const outcomes = outcomesOf(workspace, sessionId);
  const runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient([DONE]) }), 10);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'chain', sessionId }, runner);
  expect(result.code).toBe(0);
  expect(result.status).toBe('completed');
  expect(stagesOf(workspace, sessionId)).toEqual(['a', 'b']);
  const after = executionFiles(workspace, sessionId);
  for (const [id, files] of Object.entries(before)) expect(after[id]).toEqual(files);
  for (const [id, status] of Object.entries(outcomes)) expect(outcomesOf(workspace, sessionId)[id]).toBe(status);
  const events = readParsedEvents(path.join(directoryOf(workspace, sessionId), 'events.jsonl'));
  expect(events.filter((event) => event.event === 'session.active' && event.data.from === 'plugin_hold')).toHaveLength(1);
  expect(statusOf(workspace, sessionId)).not.toHaveProperty('plugin_holds');
});

test('continue on a held session with no remaining stage resolves the hold, dispatches nothing and completes', async () => {
  const workspace = workspaceWith();
  const sessionId = createWorkflowSession(workspace, 'chain', { task: 'go' });
  const first = await executeNamedWorkflow(
    workspace, { workflowId: 'chain', sessionId }, new AgentToolRunner(registryOf({ fake: new ScriptedClient([DONE, DONE]) }), 10),
  );
  expect(first.code).toBe(0);
  const lock = SessionLock.acquire(directoryOf(workspace, sessionId));
  try {
    recordPluginFailure(workspace, sessionId, { plugin: 'demo', hook: 'session.stopped', invocationId: 'i2', reason: 'error', error: 'late', onError: 'stop' });
  } finally {
    lock.release();
  }
  expect(statusOf(workspace, sessionId).status).toBe('blocked');
  const client = new ScriptedClient([]);
  const second = await executeNamedWorkflow(workspace, { workflowId: 'chain', sessionId }, new AgentToolRunner(registryOf({ fake: client }), 10));
  expect(client.calls).toHaveLength(0);
  expect(second.code).toBe(0);
  expect(second.status).toBe('completed');
  expect(stagesOf(workspace, sessionId)).toEqual(['a', 'b']);
});

test.each([['stop', 'blocked', 'active'], ['fail', 'active', 'active']] as const)(
  'a %s hold at the dispatch ceiling still exits 1 with status %s',
  async (onError, status) => {
    const { workspace, sessionId, result } = await runWithHold(onError, { maxDispatches: 1 });
    expect(stagesOf(workspace, sessionId)).toEqual(['a']);
    expect(result.code).toBe(1);
    expect(result.status).toBe(status);
    expect(statusOf(workspace, sessionId).status).toBe(status);
  },
);

async function runFanWithHold(onError: 'stop' | 'fail') {
  const workspace = workspaceWith('fan', FAN);
  const sessionId = createWorkflowSession(workspace, 'fan', { task: 'go' });
  const hold = () =>
    recordPluginFailure(workspace, sessionId, { plugin: 'demo', hook: 'execution.finished', invocationId: 'i1', reason: 'error', error: 'boom', onError });
  const client = new HoldingClient([DONE, DONE, DONE], hold);
  const runner = new AgentToolRunner(registryOf({ fake: client }), 10);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'fan', sessionId }, runner);
  return { workspace, sessionId, result };
}

test.each(['stop', 'fail'] as const)('a %s hold lets the concurrent sibling finish, leaves the pending stage, and keeps files', async (onError) => {
  const { workspace, sessionId, result } = await runFanWithHold(onError);
  // Settled before the run returned: both in-flight stages are complete, the dependent stage never started.
  expect(stagesOf(workspace, sessionId).sort()).toEqual(['a', 'b']);
  expect(Object.values(outcomesOf(workspace, sessionId))).toEqual(['completed', 'completed']);
  expect(result.code).toBe(1);
  expect(result.status).toBe(onError === 'stop' ? 'blocked' : 'active');
  const held = executionFiles(workspace, sessionId);
  const runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient([DONE]) }), 10);
  const resumed = await executeNamedWorkflow(workspace, { workflowId: 'fan', sessionId }, runner);
  expect(resumed.code).toBe(0);
  expect(stagesOf(workspace, sessionId).sort()).toEqual(['a', 'b', 'c']);
  const after = executionFiles(workspace, sessionId);
  for (const [id, files] of Object.entries(held)) expect(after[id]).toEqual(files);
});
