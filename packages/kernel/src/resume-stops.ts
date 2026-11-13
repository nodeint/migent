import type { StopFacts } from './session-status-policy.js';

/**
 * A resume decision the session waits for. It belongs to the target stage, which may have no execution
 * (`session.resume_from` with `ask`). The source execution can belong to another stage, and that stage is
 * never stopped by it.
 */
export interface PendingResumeStop {
  readonly stageId: string;
  readonly sourceExecutionId: string;
  readonly raisedAt: string | null;
  /** Policy name and the estimate behind the verdict, as `resume.expired` recorded them; null in old events. */
  readonly policy: string | null;
  readonly estimate: PendingEstimate | null;
}

/** The facts a human needs to choose: idle time against the threshold, the policy's TTL and margin, context size. */
export interface PendingEstimate {
  readonly idleSec: number | null;
  readonly thresholdSec: number | null;
  readonly cacheTtlSec: number | null;
  readonly marginSec: number | null;
  /** Null when the client reported no usage: the context size is unknown. */
  readonly contextTokens: number | null;
}

/** One session event as the projection reads it. */
export interface ResumeEventRecord {
  readonly event: string;
  readonly timestamp?: string | null;
  readonly data?: Readonly<Record<string, unknown>> | null;
}

const keyOf = (stageId: string, sourceExecutionId: string): string => JSON.stringify([stageId, sourceExecutionId]);

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function estimateOf(value: unknown): PendingEstimate | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return {
    idleSec: num(record.idleSec), thresholdSec: num(record.thresholdSec), cacheTtlSec: num(record.cacheTtlSec),
    marginSec: num(record.marginSec), contextTokens: num(record.contextTokens),
  };
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * The pending decisions of a session, in the order they were raised. A `resume.expired` event with `action: ask`
 * counts until a later `resume.decided` names the same `(stage_id, source_execution_id)`. Events must be in
 * session order. `fresh` and `resume` verdicts are never pending.
 */
export function pendingResumeStops(events: readonly ResumeEventRecord[]): PendingResumeStop[] {
  const pending = new Map<string, PendingResumeStop>();
  for (const record of events) {
    const stageId = text(record.data?.stage_id);
    const sourceExecutionId = text(record.data?.source_execution_id);
    if (stageId === null || sourceExecutionId === null) continue;
    const key = keyOf(stageId, sourceExecutionId);
    if (record.event === 'resume.decided') pending.delete(key);
    else if (record.event === 'resume.expired' && record.data?.action === 'ask') {
      pending.delete(key);
      pending.set(key, {
        stageId, sourceExecutionId, raisedAt: record.timestamp ?? null,
        policy: text(record.data?.policy), estimate: estimateOf(record.data?.estimate),
      });
    }
  }
  return [...pending.values()];
}

/** Whether a stage is the target of a pending decision. */
export function hasPendingResume(pending: readonly PendingResumeStop[] | null | undefined, stageId: string): boolean {
  return pending?.some((stop) => stop.stageId === stageId) === true;
}

/**
 * The facts the stop detectors read for one stage: its latest execution, if any, plus the stage-level
 * `pendingResume`. Without a pending decision the latest is returned unchanged.
 */
export function stageStopFacts(
  stageId: string,
  latest: StopFacts | null,
  pending: readonly PendingResumeStop[] | null | undefined,
): StopFacts {
  if (!hasPendingResume(pending, stageId)) return latest ?? {};
  return { outcomeStatus: latest?.outcomeStatus ?? null, pendingResume: true };
}
