import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AgentToolRunner } from '@nodeint/migent-engine';
import { StageOutcome } from '@nodeint/migent-kernel';
import { bindPriorSessionId, createAgentSession, createPreparedSession, createWorkflowSession, repairSession,SessionLock, SessionStore } from '@nodeint/migent-session';
import { parseYamlDocument } from '@nodeint/migent-workflow';
import { afterEach, expect, test } from 'vitest';

import { cliHooks } from '../src/hooks.ts';
import { main } from '../src/index.ts';
import { capture, registryOf, removeWorkspace, ScriptedClient, writeFakeWorkflowWorkspace } from './support.ts';

const PLAN = 'schema_version: 7\nid: plan\nartifacts:\n  plan: { file: plan.md }\nstages:\n  - id: draft\n    role: planner\n    artifacts: [plan]\n';
const IMPLEMENT = 'schema_version: 7\nid: implement\nstages:\n  - { id: work, role: developer }\n';
const UUID = '3f2b8c1e-5a47-4d0e-9b6a-1c2d3e4f5a6b';

const workspaces: string[] = [];
afterEach(() => {
  cliHooks.runner = null;
  for (const workspace of workspaces.splice(0)) removeWorkspace(workspace);
});

function workspaceOf(): string {
  const workspace = writeFakeWorkflowWorkspace({ plan: PLAN, implement: IMPLEMENT });
  workspaces.push(workspace);
  return workspace;
}

function sessionDir(workspace: string, id: string): string {
  return path.join(workspace, '.migent', 'sessions', id);
}

/** Parse manifest.yaml directly, not through the normalizing reader. */
function rawManifest(workspace: string, id: string): Record<string, unknown> {
  return parseYamlDocument(readFileSync(path.join(sessionDir(workspace, id), 'manifest.yaml'), 'utf8')) as Record<string, unknown>;
}

function stopSession(workspace: string, sessionId: string): void {
  const store = new SessionStore(workspace);
  const [record, , context] = store.loadOrCreate('fake', 'model', {}, workspace, sessionId, 'draft', null, null, 'draft');
  const lock = SessionLock.acquire(sessionDir(workspace, sessionId));
  try {
    store.saveExecution(context, record, 'running');
    writeFileSync(path.join(context.artifactDirectory, 'plan.md'), '# Plan\n', 'utf8');
    store.saveExecution(context, record, 'completed', null, new StageOutcome('complete'));
  } finally {
    lock.release();
  }
}

test('every manifest writer stores ids as YAML strings', () => {
  const workspace = workspaceOf();
  const workflow = createWorkflowSession(workspace, 'plan', 'Plan it');
  const prepared = createPreparedSession(workspace, 'Later', 'plan');
  const role = createAgentSession(workspace, 'planner', 'A role task');
  expect([workflow, prepared, role]).toEqual(['1', '2', '3']);
  for (const id of [workflow, prepared, role]) expect(rawManifest(workspace, id).session_id).toBe(id);

  const fallback = new SessionStore(workspace);
  const [, , context] = fallback.loadOrCreate('fake', 'model', {}, workspace, null, 'draft', null, null, 'draft');
  expect(rawManifest(workspace, context.sessionId).session_id).toBe(context.sessionId);
  expect(context.sessionId).toMatch(/^[1-9][0-9]*$/);
});

test('a numeric prior id survives repair and prepared-session start', async () => {
  const workspace = workspaceOf();
  const producer = createWorkflowSession(workspace, 'plan', 'Plan it');
  stopSession(workspace, producer);
  expect((await capture(() => main(['session', 'complete', producer], workspace))).value).toBe(0);

  const prepared = createPreparedSession(workspace, 'Impl', 'implement', producer);
  expect(rawManifest(workspace, prepared).prior_session_id).toBe(producer);
  const status = (): { prior_session_id?: unknown } =>
    JSON.parse(readFileSync(path.join(sessionDir(workspace, prepared), 'status.json'), 'utf8'));
  expect(status().prior_session_id).toBe(producer);
  expect(repairSession(workspace, prepared).prior_session_id).toBe(producer);
  expect(status().prior_session_id).toBe(producer);
  expect(() => bindPriorSessionId(workspace, prepared, producer)).not.toThrow();

  const direct = createWorkflowSession(workspace, 'implement', 'Impl 2', producer);
  expect(rawManifest(workspace, direct).prior_session_id).toBe(producer);
  expect(() => bindPriorSessionId(workspace, direct, producer)).not.toThrow();
});

/** Rename a numeric session into a UUID-named one, as a pre-change Migent would have written it. */
function toUuidSession(workspace: string, id: string): void {
  const from = sessionDir(workspace, id);
  const to = sessionDir(workspace, UUID);
  renameSync(from, to);
  const rewrite = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { rewrite(file); continue; }
      if (!/\.(json|jsonl|yaml)$/.test(entry.name)) continue;
      const text = readFileSync(file, 'utf8');
      const next = text.replaceAll(`"${id}"`, `"${UUID}"`).replaceAll(`sessions/${id}/`, `sessions/${UUID}/`);
      if (next !== text) writeFileSync(file, next);
    }
  };
  rewrite(to);
}

test('a UUID-named session still lists, shows, completes, continues and serves as --prior', async () => {
  const workspace = workspaceOf();
  const created = createWorkflowSession(workspace, 'plan', 'Plan it');
  stopSession(workspace, created);
  toUuidSession(workspace, created);

  const list = await capture(() => main(['session', 'list'], workspace));
  expect(list.value).toBe(0);
  expect(list.stdout + list.stderr).toContain(UUID);

  const show = await capture(() => main(['session', 'show', UUID, '--json'], workspace));
  expect(show.value).toBe(0);
  expect(JSON.parse(show.stdout)).toMatchObject({ session_id: UUID });

  const complete = await capture(() => main(['session', 'complete', UUID], workspace));
  expect(complete.value).toBe(0);
  const executions = path.join(sessionDir(workspace, UUID), 'executions');
  const before = readdirSync(executions);
  await capture(() => main(['session', 'continue', UUID], workspace));
  expect(readdirSync(executions)).toEqual(before);

  const next = createPreparedSession(workspace, 'Impl', 'implement', UUID);
  expect(next).toBe('1');
  expect(rawManifest(workspace, next).prior_session_id).toBe(UUID);
  expect(() => bindPriorSessionId(workspace, next, UUID)).not.toThrow();
});

test('session run --session --prior starts a prepared session and keeps the numeric prior', async () => {
  const workspace = workspaceOf();
  const producer = createWorkflowSession(workspace, 'plan', 'Plan it');
  stopSession(workspace, producer);
  expect((await capture(() => main(['session', 'complete', producer], workspace))).value).toBe(0);

  const prepared = createPreparedSession(workspace, 'Impl', 'implement', producer);
  writeFileSync(path.join(sessionDir(workspace, prepared), 'task.md'), 'Implement the plan.\n', 'utf8');
  const provider = new ScriptedClient(['status: complete\n\ndone'], [null]);
  cliHooks.runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  const started = await capture(() => main(['session', 'run', '--session', prepared, '--prior', producer, '--once'], workspace));
  expect(started.value).toBe(0);
  expect(provider.calls).toHaveLength(1);
  const status = JSON.parse(readFileSync(path.join(sessionDir(workspace, prepared), 'status.json'), 'utf8')) as Record<string, unknown>;
  expect(status.prior_session_id).toBe(producer);
  expect(status.status).not.toBe('prepared');
  expect(readdirSync(path.join(sessionDir(workspace, prepared), 'executions'))).toHaveLength(1);
  expect(rawManifest(workspace, prepared).prior_session_id).toBe(producer);
});

const TWO_STAGES = 'schema_version: 7\nid: two\nartifacts:\n  a: { file: a.md }\n  b: { file: b.md }\nstages:\n  - id: first\n    role: planner\n    artifacts: [a]\n  - id: second\n    role: planner\n    depends_on: [first]\n    artifacts: [b]\n';

test('a runnable UUID-named session continues with a new execution', async () => {
  const workspace = writeFakeWorkflowWorkspace({ two: TWO_STAGES });
  workspaces.push(workspace);
  cliHooks.runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient(['status: complete\n\none'], ['# A\n']) }), 10);
  const started = await capture(() => main(['session', 'run', '--workflow', 'two', '--task', 'Do two', '--once'], workspace));
  expect(started.value).toBe(0);
  const id = '1';
  expect(readdirSync(path.join(sessionDir(workspace, id), 'executions'))).toHaveLength(1);
  toUuidSession(workspace, id);

  const provider = new ScriptedClient(['status: complete\n\ntwo'], ['# B\n']);
  cliHooks.runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  const resumed = await capture(() => main(['session', 'continue', UUID, '--once'], workspace));
  expect(resumed.value).toBe(0);
  expect(provider.calls).toHaveLength(1);
  const executions = readdirSync(path.join(sessionDir(workspace, UUID), 'executions'));
  expect(executions).toHaveLength(2);
  expect(executions.some((name) => name.includes('second'))).toBe(true);
});
