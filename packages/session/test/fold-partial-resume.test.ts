import { expect, test } from 'vitest';

import type { ParsedEvent } from '../src/session-events.ts';
import { foldStatus } from '../src/session-fold.ts';
import type { FoldExecution, FoldInputs } from '../src/session-fold-types.ts';

/**
 * Characterization of the fold with no resume policy: any matching resume reopens the session, even while
 * a sibling stage is still stopped. Written before the resume-policy fold step, and it must pass unchanged.
 */

let seq = 0;

function event(
  name: string,
  timestamp: string,
  extra: { executionId?: string; stageId?: string; data?: Record<string, unknown> } = {},
): ParsedEvent {
  seq += 1;
  const data = extra.data ?? {};
  return {
    raw: { v: 2, seq, event: name, timestamp, ...data },
    v: 2,
    seq,
    event: name,
    timestamp,
    executionId: extra.executionId ?? null,
    stageId: extra.stageId ?? null,
    summary: null,
    data,
  };
}

function execution(
  id: string,
  order: number,
  stageId: string,
  outcome: Record<string, unknown>,
  status = 'blocked',
): FoldExecution {
  return {
    executionId: id,
    executionOrder: order,
    stageId,
    stageAttempt: 1,
    client: 'codex',
    model: 'm',
    resumesExecutionId: null,
    status,
    outcome,
    error: null,
    failureReason: null,
    createdAt: '2026-01-01T00:00:10Z',
    completedAt: status === 'running' ? null : '2026-01-01T00:00:20Z',
    artifactDirectory: `executions/${id}`,
  };
}

const BLOCKED = { status: 'blocked', blocker: 'need key' };
const QUESTION = {
  status: 'question',
  questions: [
    { id: '1', question: 'Which?', context: 'Because', selection: 'single', options: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }] },
  ],
};

function inputs(overrides: Partial<FoldInputs>): FoldInputs {
  return {
    schemaVersion: 2,
    manifest: {
      sessionId: 's1',
      title: null,
      workflowId: 'plan',
      workflowPath: '.migent/workflows/plan.yaml',
      role: null,
      task: 'Do it',
      createdAt: '2026-01-01T00:00:00Z',
      priorSessionId: null,
      manifestStatus: null,
      schemaVersion: 2,
    },
    events: [],
    executions: [],
    presentExecutionIds: new Set(),
    previousStatus: null,
    outputFiles: [],
    workflow: null,
    titleRecord: null,
    ...overrides,
  };
}

const resume = (executionId: string, stageId: string, from: string, timestamp: string): ParsedEvent =>
  event('session.active', timestamp, { executionId, stageId, data: { from } });

const started = (id: string, stageId: string, order: number): ParsedEvent =>
  event('execution.started', '2026-01-01T00:00:10Z', { executionId: id, stageId, data: { execution_order: order } });

function twoStopped(second: Record<string, unknown>, resumes: ParsedEvent[]): Record<string, unknown> {
  return foldStatus(
    inputs({
      events: [event('session.created', '2026-01-01T00:00:00Z'), started('e1', 'a', 1), started('e2', 'b', 2), ...resumes],
      executions: [execution('e1', 1, 'a', BLOCKED), execution('e2', 2, 'b', second)],
      presentExecutionIds: new Set(['e1', 'e2']),
    }),
  );
}

test('two blocked stages and one resume fold to active', () => {
  const status = twoStopped(BLOCKED, [resume('e1', 'a', 'blocked', '2026-01-01T00:00:30Z')]);
  expect(status.status).toBe('active');
  expect(status.updated_at).toBe('2026-01-01T00:00:30Z');
});

test('two blocked stages and no resume stay blocked', () => {
  expect(twoStopped(BLOCKED, []).status).toBe('blocked');
});

test('one blocked and one question stage with a reply to the question fold to active', () => {
  const status = twoStopped(QUESTION, [resume('e2', 'b', 'question', '2026-01-01T00:00:30Z')]);
  expect(status.status).toBe('active');
});

test('a reply to a question of a blocked and question pair keeps the newest resume time', () => {
  const status = twoStopped(QUESTION, [
    resume('e1', 'a', 'blocked', '2026-01-01T00:00:30Z'),
    resume('e2', 'b', 'question', '2026-01-01T00:00:40Z'),
  ]);
  expect(status.status).toBe('active');
  expect(status.updated_at).toBe('2026-01-01T00:00:40Z');
});

// With a pending resume decision (resume policies).

const expiredEvent = (stageId: string, source: string, timestamp = '2026-01-01T00:00:35Z'): ParsedEvent =>
  event('resume.expired', timestamp, { stageId, data: { stage_id: stageId, source_execution_id: source, action: 'ask' } });

const decidedEvent = (stageId: string, source: string): ParsedEvent =>
  event('resume.decided', '2026-01-01T00:00:50Z', { stageId, data: { stage_id: stageId, source_execution_id: source, choice: 'resume' } });

function withExpiry(
  rows: [string, string, Record<string, unknown>, string?][],
  events: ParsedEvent[],
): Record<string, unknown> {
  const executions = rows.map(([id, stageId, outcome, status], index) =>
    execution(id, index + 1, stageId, outcome, status ?? (outcome.status === 'complete' ? 'completed' : String(outcome.status))));
  return foldStatus(
    inputs({
      events: [event('session.created', '2026-01-01T00:00:00Z'), ...executions.map((row) => started(row.executionId, row.stageId, row.executionOrder)), ...events],
      executions,
      presentExecutionIds: new Set(executions.map((row) => row.executionId)),
    }),
  );
}

const replyA = resume('e1', 'a', 'question', '2026-01-01T00:00:30Z');

test('question -> reply -> pending expiry on the same stage folds to expired', () => {
  const status = withExpiry([['e1', 'a', QUESTION]], [replyA, expiredEvent('a', 'e1')]);
  expect(status.status).toBe('expired');
});

test('blocked -> resume -> pending expiry folds to expired', () => {
  const status = withExpiry([['e1', 'a', BLOCKED]], [resume('e1', 'a', 'blocked', '2026-01-01T00:00:30Z'), expiredEvent('a', 'e1')]);
  expect(status.status).toBe('expired');
});

test('a sibling blocker still wins over the expiry', () => {
  const status = withExpiry([['e1', 'a', QUESTION], ['e2', 'b', BLOCKED]], [replyA, expiredEvent('a', 'e1')]);
  expect(status.status).toBe('blocked');
});

test('a sibling question still wins over the expiry', () => {
  const second = { ...QUESTION };
  const status = withExpiry([['e1', 'a', BLOCKED], ['e2', 'b', second]], [resume('e1', 'a', 'blocked', '2026-01-01T00:00:30Z'), expiredEvent('a', 'e1')]);
  expect(status.status).toBe('question');
});

test('two blocked stages, one resumed and then expired, fold to blocked', () => {
  const status = withExpiry([['e1', 'a', BLOCKED], ['e2', 'b', BLOCKED]], [resume('e1', 'a', 'blocked', '2026-01-01T00:00:30Z'), expiredEvent('a', 'e1')]);
  expect(status.status).toBe('blocked');
});

test('a resumed blocker with no expiry, next to a pending expiry elsewhere, stays active', () => {
  const status = withExpiry(
    [['e1', 'a', BLOCKED], ['e2', 'b', { status: 'complete' }]],
    [resume('e1', 'a', 'blocked', '2026-01-01T00:00:30Z'), expiredEvent('b', 'e2')],
  );
  expect(status.status).toBe('active');
});

test('a decision clears the stop; a decision for another source does not', () => {
  const rows: [string, string, Record<string, unknown>][] = [['e1', 'a', QUESTION]];
  expect(withExpiry(rows, [replyA, expiredEvent('a', 'e1'), decidedEvent('a', 'e1')]).status).toBe('active');
  expect(withExpiry(rows, [replyA, expiredEvent('a', 'e1'), decidedEvent('a', 'other')]).status).toBe('expired');
});

test('a fresh or resume verdict raises no stop', () => {
  const fresh = event('resume.expired', '2026-01-01T00:00:35Z', {
    stageId: 'a',
    data: { stage_id: 'a', source_execution_id: 'e1', action: 'fresh' },
  });
  expect(withExpiry([['e1', 'a', QUESTION]], [replyA, fresh]).status).toBe('active');
});

test('a running sibling keeps the session active, and the stop shows once it ends', () => {
  const running: [string, string, Record<string, unknown>, string] = ['e2', 'b', { status: 'complete' }, 'running'];
  const events = [replyA, expiredEvent('a', 'e1')];
  expect(withExpiry([['e1', 'a', QUESTION], running], events).status).toBe('active');
  expect(withExpiry([['e1', 'a', QUESTION], ['e2', 'b', { status: 'complete' }]], events).status).toBe('expired');
  expect(withExpiry([['e1', 'a', QUESTION], ['e2', 'b', BLOCKED]], events).status).toBe('blocked');
});

test('a running sibling with a blocker resolved by resume stays active', () => {
  const running: [string, string, Record<string, unknown>, string] = ['e2', 'b', { status: 'complete' }, 'running'];
  const events = [resume('e1', 'a', 'blocked', '2026-01-01T00:00:30Z'), expiredEvent('a', 'e1')];
  expect(withExpiry([['e1', 'a', BLOCKED], running], events).status).toBe('active');
});
