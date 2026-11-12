import { expect, test } from 'vitest';

import type { ParsedEvent } from '../src/session-events.ts';
import { foldStatus } from '../src/session-fold.ts';
import type { FoldExecution, FoldInputs } from '../src/session-fold-types.ts';

/** Characterization: a blocked session reopens on a resume of its own execution with `from` blocked or question. */

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


const BLOCKED = { status: 'blocked', blocker: 'need key' };
const BASE = [
  event('session.created', '2026-01-01T00:00:00Z'),
  event('execution.started', '2026-01-01T00:00:10Z', { executionId: 'e1', stageId: 'draft', data: { execution_order: 1 } }),
  event('execution.blocked', '2026-01-01T00:00:20Z', { executionId: 'e1', stageId: 'draft', data: { outcome: BLOCKED } }),
];

function resume(from: string, timestamp: string, executionId = 'e1'): ParsedEvent {
  return event('session.active', timestamp, { executionId, stageId: 'draft', data: { from } });
}

function folded(resumes: ParsedEvent[]): Record<string, unknown> {
  return foldStatus(
    inputs({
      events: [...BASE, ...resumes],
      executions: [execution('e1', 1, 'draft', 'blocked', BLOCKED)],
      presentExecutionIds: new Set(['e1']),
    }),
  );
}

test('a blocked session without a matching resume stays blocked', () => {
  expect(folded([resume('failed', '2026-01-01T00:00:30Z'), resume('blocked', '2026-01-01T00:00:35Z', 'other')]).status).toBe('blocked');
});

test('blocked and question resumes of the stopped execution reopen the session at the newest one', () => {
  const status = folded([resume('blocked', '2026-01-01T00:00:30Z'), resume('question', '2026-01-01T00:00:40Z')]);
  expect(status.status).toBe('active');
  expect(status.updated_at).toBe('2026-01-01T00:00:40Z');
});
