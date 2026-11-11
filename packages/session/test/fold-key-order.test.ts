import { expect, test } from 'vitest';

import type { ParsedEvent } from '../src/session-events.ts';
import { foldStatus } from '../src/session-fold.ts';
import type { FoldExecution, FoldInputs } from '../src/session-fold-types.ts';

/**
 * Characterization of the status fold. `status.json` is written with the fold's key order, and the
 * drift check sorts keys, so only a serialized comparison catches an order change.
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
  status: string,
  outcome: Record<string, unknown> | null,
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

function inputs(overrides: Partial<FoldInputs>): FoldInputs {
  return {
    schemaVersion: 2,
    manifest: {
      sessionId: 's1',
      title: 'Manifest title',
      workflowId: 'plan',
      workflowPath: '.migent/workflows/plan.yaml',
      role: null,
      task: 'Do it',
      createdAt: '2026-01-01T00:00:00Z',
      priorSessionId: 'p0',
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

function serialized(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}

const FRESH_EVENTS = [
  event('session.created', '2026-01-01T00:00:00Z', { data: { handoff: { from: 'x' } } }),
  event('task.frozen', '2026-01-01T00:00:01Z', { data: { sha256: 'abc' } }),
  event('baseline.captured', '2026-01-01T00:00:02Z', { data: { commit: 'deadbeef' } }),
  event('execution.started', '2026-01-01T00:00:10Z', { executionId: 'e1', stageId: 'draft', data: { execution_order: 1 } }),
  event('provider.stage_started', '2026-01-01T00:00:11Z', { executionId: 'e1', stageId: 'draft' }),
];

test('fold: running stage keeps its key order', () => {
  const ids = new Set(['e1']);
  const status = foldStatus(
    inputs({ events: FRESH_EVENTS, executions: [execution('e1', 1, 'draft', 'running', null)], presentExecutionIds: ids }),
  );
  expect(serialized(status)).toMatchSnapshot();
});

test('fold: blocked then resumed, with latest decision and outputs', () => {
  const blocked = { status: 'blocked', blocker: 'need key', decision: 'revise' };
  const events = [
    ...FRESH_EVENTS,
    event('execution.blocked', '2026-01-01T00:00:20Z', { executionId: 'e1', stageId: 'draft', data: { outcome: blocked } }),
    event('session.active', '2026-01-01T00:00:30Z', { executionId: 'e1', stageId: 'draft', data: { from: 'blocked' } }),
    event('outputs.published', '2026-01-01T00:00:31Z', {
      data: { outputs: [{ name: 'plan', path: 'outputs/plan.md', source_execution_id: 'e1', published_by_execution_id: 'e1' }] },
    }),
    event('revisions.reset', '2026-01-01T00:00:32Z', { data: { baselines: { draft: 2 } } }),
  ];
  const blockedStatus = foldStatus(
    inputs({ events: events.slice(0, 6), executions: [execution('e1', 1, 'draft', 'blocked', blocked)], presentExecutionIds: new Set(['e1']) }),
  );
  const resumedStatus = foldStatus(
    inputs({
      events,
      executions: [execution('e1', 1, 'draft', 'blocked', blocked)],
      presentExecutionIds: new Set(['e1']),
      outputFiles: ['extra.md', 'plan.md'],
    }),
  );
  expect(serialized(blockedStatus)).toMatchSnapshot();
  expect(serialized(resumedStatus)).toMatchSnapshot();
});

test('fold: question with recipient and file', () => {
  const outcome = { status: 'question', questions: [{ id: '1', question: 'Which?', context: 'Because', selection: 'single', options: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }] }] };
  const status = foldStatus(
    inputs({
      events: [...FRESH_EVENTS, event('execution.question', '2026-01-01T00:00:20Z', { executionId: 'e1', stageId: 'draft', data: { outcome } })],
      executions: [execution('e1', 1, 'draft', 'question', outcome)],
      presentExecutionIds: new Set(['e1']),
    }),
  );
  expect(serialized(status)).toMatchSnapshot();
});

test('fold: cancelled with a recorded reply, then skipped stages', () => {
  const events = [
    ...FRESH_EVENTS,
    event('execution.cancelled', '2026-01-01T00:00:20Z', { executionId: 'e1', stageId: 'draft', data: {} }),
    event('session.active', '2026-01-01T00:00:40Z', { executionId: 'e1', stageId: 'draft', data: { from: 'cancelled_reply' } }),
  ];
  const cancelled = foldStatus(
    inputs({ events: events.slice(0, 6), executions: [execution('e1', 1, 'draft', 'cancelled', null)], presentExecutionIds: new Set(['e1']) }),
  );
  const replied = foldStatus(
    inputs({
      events,
      executions: [execution('e1', 1, 'draft', 'cancelled', null), execution('e2', 2, 'extra', 'skipped', null)],
      presentExecutionIds: new Set(['e1', 'e2']),
    }),
  );
  expect(serialized(cancelled)).toMatchSnapshot();
  expect(serialized(replied)).toMatchSnapshot();
});

test('fold: manual completion and title record', () => {
  const events = [
    ...FRESH_EVENTS,
    event('execution.blocked', '2026-01-01T00:00:20Z', {
      executionId: 'e1',
      stageId: 'draft',
      data: { outcome: { status: 'blocked', blocker: 'stuck' } },
    }),
    event('session.completed', '2026-01-01T00:01:00Z', { data: { manual: true, from: 'blocked' } }),
  ];
  const status = foldStatus(
    inputs({
      events,
      executions: [execution('e1', 1, 'draft', 'blocked', { status: 'blocked', blocker: 'stuck' })],
      presentExecutionIds: new Set(['e1']),
      titleRecord: { title: 'Renamed', updated_at: '2026-01-01T00:02:00Z', history: [] },
    }),
  );
  expect(serialized(status)).toMatchSnapshot();
});

test('fold: schema 1 with a previous status', () => {
  const v1Manifest = { ...inputs({}).manifest, schemaVersion: 1, manifestStatus: 'blocked' };
  const outcome = { status: 'blocked', blocker: 'old', decision: 'stop' };
  const status = foldStatus(
    inputs({
      schemaVersion: 1,
      manifest: v1Manifest,
      previousStatus: { session_id: 's1', status: 'active', extra_key: 1, updated_at: '2025-12-31T00:00:00Z' },
      events: [
        { ...event('task.frozen', '2026-01-01T00:00:01Z', { data: { sha256: 'abc' } }), v: 2 },
        { ...event('provider.stage_started', '2026-01-01T00:00:11Z', { executionId: 'e1', stageId: 'draft' }), v: 2 },
      ],
      executions: [execution('e1', 1, 'draft', 'blocked', outcome)],
      presentExecutionIds: new Set(['e1']),
    }),
  );
  expect(serialized(status)).toMatchSnapshot();
});

test('fold: schema 2 session.* events without an execution', () => {
  const status = foldStatus(
    inputs({
      events: [
        ...FRESH_EVENTS,
        event('session.cancelled', '2026-01-01T00:00:50Z', { data: { reason: 'user' } }),
      ],
      executions: [execution('e1', 1, 'draft', 'running', null)],
      presentExecutionIds: new Set(['e1']),
    }),
  );
  expect(serialized(status)).toMatchSnapshot();
});
