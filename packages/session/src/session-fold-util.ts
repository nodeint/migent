import type { StageOutcomeStatus } from '@nodeint/migent-contracts';
import { StageOutcome, storedQuestions } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';

import { type ParsedEvent, parseExecutionId } from './session-events.js';
import type { FoldExecution } from './session-fold-types.js';



export function differingKeys(left: Record<string, unknown>, right: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const different: string[] = [];
  for (const key of [...keys].sort()) {
    if (canonical(left[key]) !== canonical(right[key])) different.push(key);
  }
  return different;
}

export function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key]);
  return sorted;
}

export function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function later(current: string | null, next: string | null): string | null {
  if (!next) return current;
  if (!current) return next;
  const left = Date.parse(current);
  const right = Date.parse(next);
  if (Number.isNaN(left) || Number.isNaN(right)) return current >= next ? current : next;
  return left >= right ? current : next;
}

export function textOr(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Session ids are strings; a hand-edited manifest may hold an unquoted integer. */
export function identityText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return textOr(value);
}

export function asInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return 0;
}

export function eventExecutionOrder(event: ParsedEvent): number {
  const fromId = event.executionId ? (parseExecutionId(event.executionId)?.order ?? 0) : 0;
  return Math.max(asInt(event.data.execution_order), fromId);
}

export function isExecutionScoped(eventName: string): boolean {
  return (
    eventName.startsWith('execution.') ||
    eventName.startsWith('stage.') ||
    eventName.startsWith('provider.') ||
    eventName.startsWith('verify.') ||
    (eventName.startsWith('session.') && eventName !== 'session.created' && eventName !== 'session.activated')
  );
}

export function outcomeRecord(event: ParsedEvent): Record<string, unknown> | null {
  if (isRecord(event.data.outcome)) return event.data.outcome;
  const top: Record<string, unknown> = {};
  if (typeof event.raw.status === 'string') top.status = event.raw.status;
  if (typeof event.raw.blocker === 'string') top.blocker = event.raw.blocker;
  if (typeof event.raw.decision === 'string') top.decision = event.raw.decision;
  if (typeof event.raw.question === 'string') top.question = event.raw.question;
  return Object.keys(top).length > 0 ? top : null;
}

export function decisionOf(outcome: Record<string, unknown> | null): string | null {
  if (outcome === null) return null;
  return textOr(outcome.decision);
}

export function toStageOutcome(outcome: Record<string, unknown> | null): StageOutcome | null {
  if (outcome === null || typeof outcome.status !== 'string') return null;
  return new StageOutcome(
    outcome.status as StageOutcomeStatus, // event-template: unchecked (stored outcome)
    {
      blocker: textOr(outcome.blocker),
      decision: textOr(outcome.decision),
      question: textOr(outcome.question),
      questions: storedQuestions(outcome),
    },
  );
}

export function latestExecution(executions: readonly FoldExecution[]): FoldExecution | null {
  let best: FoldExecution | null = null;
  for (const execution of executions) {
    if (best === null) {
      best = execution;
      continue;
    }
    if (execution.executionOrder > best.executionOrder) best = execution;
    else if (execution.executionOrder === best.executionOrder && execution.executionId > best.executionId) {
      best = execution;
    }
  }
  return best;
}
