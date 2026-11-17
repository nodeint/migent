import path from 'node:path';

import type { AgentSessionRecord, ExecutionContext, SessionStore } from '@nodeint/migent-session';

import type { ProviderEventReporter } from '../provider-events.js';
import type { RunResult } from '../turn-types.js';
import { type OutcomeData, toStageOutcome } from './outcome-data.js';
import type { ExecutionEnd } from './role-state.js';

type OutcomeFields = Pick<RunResult, 'outcome_status' | 'outcome_decision' | 'questions' | 'questions_file'>;
type FailureFields = Pick<RunResult, 'failure_reason' | 'failure_detail' | 'failure_kind' | 'reset_at'>;

// The outcome fields, where the plain outcome becomes a `StageOutcome` for the consumer.
function outcomeFields(data: OutcomeData | null, context: ExecutionContext): OutcomeFields {
  const outcome = data === null ? null : toStageOutcome(data);
  return {
    outcome_status: outcome?.status ?? '',
    ...(outcome?.status === 'question' ? {
      questions: outcome.questions, questions_file: path.join(context.directory, 'questions.json'),
    } : {}),
    outcome_decision: outcome?.decision ?? '',
  };
}

function failureFields(end: ExecutionEnd): FailureFields {
  const { classification } = end;
  return {
    failure_reason: end.failureReason,
    ...(end.failureDetail === '' ? {} : { failure_detail: end.failureDetail }),
    failure_kind: classification?.kind ?? '',
    reset_at: classification?.kind === 'quota' && classification.resetAt ? classification.resetAt : '',
  };
}

/** The consumer-facing result of a finished role execution. */
export function buildRunResult(
  target: {
    record: AgentSessionRecord; store: SessionStore; context: ExecutionContext; eventReporter: ProviderEventReporter;
  },
  end: ExecutionEnd,
): RunResult {
  const { record, store, context, eventReporter } = target;
  const sessionStatus = store.readSessionStatus(context.sessionId);
  const result: RunResult = {
    agent_id: record.agentId || '',
    options: { ...record.options },
    session_id: context.sessionId,
    execution_id: context.executionId,
    artifact_directory: context.artifactDirectory,
    ...outcomeFields(end.outcome, context),
    ...failureFields(end),
    session_status: typeof sessionStatus.status === 'string' ? sessionStatus.status : '',
    response: end.responseText,
    client: eventReporter.client,
    execution_status: record.status,
  };
  return result;
}
