import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { StageOutcome } from '@nodeint/migent-kernel';
import { SessionLock } from '@nodeint/migent-session';
import { expect, test } from 'vitest';

import { sessionEventLog } from '../src/event-log.ts';
import { readFoldedStatus } from '../src/session-fold.ts';
import { applyPluginHolds } from '../src/session-fold-holds.ts';
import { createPreparedSession, createWorkflowSession } from '../src/session-records.ts';
import { StatusDraft } from '../src/session-status-draft.ts';
import { SessionStore } from '../src/session-store.ts';
import { freezeSessionTask } from '../src/task-file.ts';
import { defaultClients, tempDir, writeSessionConfig } from './support.ts';

const PLAN = `schema_version: 7
id: plan
stages:
  - id: draft
    role: planner
  - id: extra
    role: planner
    depends_on: [draft]
`;

function started(): { workspace: string; store: SessionStore; sessionId: string; directory: string } {
  const workspace = tempDir('migent-holds-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'plan.yaml'), PLAN, 'utf8');
  writeSessionConfig(workspace);
  const sessionId = createWorkflowSession(workspace, 'plan', { task: 'Write a plan' });
  const directory = path.join(workspace, '.migent', 'sessions', sessionId);
  const lock = SessionLock.acquire(directory);
  try {
    freezeSessionTask(workspace, sessionId);
  } finally {
    lock.release();
  }
  return { workspace, store: new SessionStore(workspace, undefined, defaultClients()), sessionId, directory };
}

function withLock(directory: string, action: () => void): void {
  const lock = SessionLock.acquire(directory);
  try {
    action();
  } finally {
    lock.release();
  }
}

function stage(ctx: ReturnType<typeof started>, stageId: string, status: string, outcome: StageOutcome | null): void {
  const { workspace, store, sessionId, directory } = ctx;
  withLock(directory, () => {
    const [record, , context] = store.loadOrCreate({ client: 'fake', model: 'm', options: {}, workspace, sessionId, stageId, stageAttempt: null, executionOrder: null, prompt: stageId });
    store.saveExecution(context, record, { status: 'running' });
    store.saveExecution(context, record, { status, outcome });
  });
}

function fail(ctx: ReturnType<typeof started>, onError: string, extra: Record<string, unknown> = {}): void {
  withLock(ctx.directory, () => {
    sessionEventLog.record(ctx.directory, {
      event: 'plugin.failed',
      timestamp: new Date().toISOString(),
      data: { plugin: 'demo', hook: 'execution.finished', invocation_id: 'i1', reason: 'error', error: 'boom', on_error: onError, ...extra },
    });
    sessionEventLog.commit(ctx.workspace, ctx.directory);
  });
}

function resolve(ctx: ReturnType<typeof started>): void {
  withLock(ctx.directory, () => {
    sessionEventLog.record(ctx.directory, { event: 'session.active', timestamp: new Date().toISOString(), data: { from: 'plugin_hold' } });
    sessionEventLog.commit(ctx.workspace, ctx.directory);
  });
}

const statusOf = (ctx: ReturnType<typeof started>): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(ctx.directory, 'status.json'), 'utf8')) as Record<string, unknown>;

function expectFolded(ctx: ReturnType<typeof started>): Record<string, unknown> {
  const written = statusOf(ctx);
  expect(readFoldedStatus(ctx.workspace, ctx.directory)).toEqual(written);
  return written;
}

const complete = (): StageOutcome => new StageOutcome('complete');

test('an ignore failure leaves status.json without plugin_holds', () => {
  const ctx = started();
  fail(ctx, 'ignore');
  expect(expectFolded(ctx)).not.toHaveProperty('plugin_holds');
  expect(statusOf(ctx).status).toBe('active');
});

test('a stop hold blocks an active session, names the plugin and hook, and a fail hold keeps it active', () => {
  const ctx = started();
  fail(ctx, 'stop');
  const stopped = expectFolded(ctx);
  expect(stopped.status).toBe('blocked');
  expect(stopped.blocker).toContain('demo');
  expect(stopped.blocker).toContain('execution.finished');
  expect(stopped.plugin_holds).toMatchObject([{ plugin: 'demo', hook: 'execution.finished', invocation_id: 'i1', on_error: 'stop', error: 'boom' }]);
  const other = started();
  fail(other, 'fail');
  const failed = expectFolded(other);
  expect(failed.status).toBe('active');
  expect(failed.plugin_holds).toMatchObject([{ on_error: 'fail' }]);
});

test('holds apply over a completed session: stop blocks it and fail reopens it', () => {
  const ctx = started();
  stage(ctx, 'draft', 'completed', complete());
  stage(ctx, 'extra', 'completed', complete());
  expect(statusOf(ctx).status).toBe('completed');
  fail(ctx, 'fail');
  expect(expectFolded(ctx)).toMatchObject({ status: 'active' });
  expect(statusOf(ctx)).not.toHaveProperty('completion_method');
  resolve(ctx);
  expect(expectFolded(ctx)).toMatchObject({ status: 'completed' });
  fail(ctx, 'stop');
  expect(expectFolded(ctx)).toMatchObject({ status: 'blocked' });
});

test('a stop hold keeps a stage stop and adds its blocker beside the stage blocker', () => {
  const ctx = started();
  stage(ctx, 'draft', 'completed', new StageOutcome('blocked', { blocker: 'needs a decision' }));
  expect(statusOf(ctx).status).toBe('blocked');
  fail(ctx, 'stop');
  const folded = expectFolded(ctx);
  expect(folded.status).toBe('blocked');
  expect(String(folded.blocker)).toContain('needs a decision');
  expect(String(folded.blocker)).toContain('demo');
  const cancelled = started();
  stage(cancelled, 'draft', 'cancelled', null);
  fail(cancelled, 'stop');
  expect(expectFolded(cancelled).status).toBe('cancelled');
  expect(statusOf(cancelled).plugin_holds).toHaveLength(1);
  expect(String(statusOf(cancelled).blocker)).toContain('demo');
});

test('a stop hold keeps a question stop and adds its blocker', () => {
  const ctx = started();
  const question = { id: '1', question: 'Which?', context: 'Because.', selection: 'single', recommended: ['A'], options: [{ id: 'A', label: 'A', description: 'first' }, { id: 'B', label: 'B', description: 'second' }] };
  stage(ctx, 'draft', 'completed', new StageOutcome('question', { question: 'Which?', questions: [question as never] }));
  expect(statusOf(ctx).status).toBe('question');
  fail(ctx, 'stop');
  const folded = expectFolded(ctx);
  expect(folded.status).toBe('question');
  expect(String(folded.blocker)).toContain('demo');
  expect(folded.plugin_holds).toHaveLength(1);
});

test.each(['prepared', 'expired', 'corrupt'])('a hold leaves a %s status untouched', (status) => {
  const ctx = started();
  const draft = new StatusDraft({ status, updated_at: '2026-01-01T00:00:00.000Z' });
  const events = [{ event: 'plugin.failed', timestamp: '2026-01-02T00:00:00.000Z', executionId: null, stageId: null, data: { plugin: 'demo', hook: 'h', invocation_id: 'i', reason: 'error', error: 'boom', on_error: 'stop' } }];
  applyPluginHolds(draft, events as never);
  expect(draft.toRecord()).toEqual({ status, updated_at: '2026-01-01T00:00:00.000Z' });
  expect(ctx.sessionId).toBeTruthy();
});

test('manual completion wins over a hold and the holds stay listed', () => {
  const ctx = started();
  fail(ctx, 'stop');
  ctx.store.completeManually(ctx.sessionId);
  const folded = expectFolded(ctx);
  expect(folded.status).toBe('completed');
  expect(folded.completion_method).toBe('manual');
  expect(folded.plugin_holds).toHaveLength(1);
});

test('session.active with from plugin_hold resolves every earlier hold, and a later hold stands', () => {
  const ctx = started();
  fail(ctx, 'stop');
  fail(ctx, 'fail');
  expect(statusOf(ctx).plugin_holds).toHaveLength(2);
  resolve(ctx);
  const resolved = expectFolded(ctx);
  expect(resolved.status).toBe('active');
  expect(resolved).not.toHaveProperty('plugin_holds');
  expect(resolved).not.toHaveProperty('blocker');
  fail(ctx, 'fail');
  expect(expectFolded(ctx).plugin_holds).toHaveLength(1);
});

test('holds do not affect a prepared session', () => {
  const workspace = tempDir('migent-holds-prepared-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'plan.yaml'), PLAN, 'utf8');
  writeSessionConfig(workspace);
  const sessionId = createPreparedSession(workspace, { title: 'Later', workflowId: 'plan' });
  const directory = path.join(workspace, '.migent', 'sessions', sessionId);
  const ctx = { workspace, store: new SessionStore(workspace), sessionId, directory };
  expect(statusOf(ctx).status).toBe('prepared');
  fail(ctx, 'stop');
  expect(statusOf(ctx).status).toBe('prepared');
  expect(statusOf(ctx)).not.toHaveProperty('plugin_holds');
});
