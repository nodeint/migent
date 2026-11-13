import {
  foldStoppedStatus,
  isStageStop,
  type PendingResumeStop,
  stageStopFacts,
  stageStopStatus,
  unresolvedStageStops,
} from '@nodeint/migent-kernel';
import type { WorkflowDocument } from '@nodeint/migent-workflow';

import { CANCELLED_REPLY, type ParsedEvent } from './session-events.js';
import { latestPerStage, sessionStatusWithPending, type StatusExecution } from './session-ledger.js';

export interface PendingExpiryStatus {
  status: string;
  /** Latest executions that are still blocked, for the terminal fields of a `blocked` status. */
  blockedIds: string[];
}

interface FoldContext {
  rows: readonly StatusExecution[];
  previousStatus: Readonly<Record<string, unknown>>;
  workflow: WorkflowDocument | null;
  pending: readonly PendingResumeStop[];
  events: readonly ParsedEvent[];
}

/**
 * The status a session with a pending resume decision takes after the resume and reply steps have run. Those steps
 * reopen a session as soon as any stopped execution has a matching resume, which would hide a stop recorded on the
 * same stage right after. This step runs only with pending decisions and only when the plain fold found a stage stop
 * that those steps turned into `active`. Null means the status stays as it is: a running execution, a branch that can
 * start, a stage whose resume is free of a pending decision, or a cancelled reply all keep the session `active`.
 */
export function pendingExpiryStatus(context: FoldContext): PendingExpiryStatus | null {
  const { rows, previousStatus, workflow, pending, events } = context;
  if (pending.length === 0) return null;
  const folded = sessionStatusWithPending(rows, previousStatus, { workflow, pending });
  if (!isStageStop(folded)) return null;
  const latest = latestPerStage(rows);
  if (latest.some((row) => row.status === 'running' || isRepliedCancel(row, events))) return null;
  const held = new Set(pending.map((stop) => stop.stageId));
  const state = { sessionStatus: 'active', resumes: events };
  const stops: string[] = [];
  const blockedIds: string[] = [];
  for (const row of latest) {
    const facts = stageStopFacts(row.stageId, { outcomeStatus: row.outcome?.status ?? null }, pending);
    const unresolved = unresolvedStageStops(facts, row.executionId, state);
    // A stopped stage whose resume no pending decision holds can be dispatched, so the session stays active.
    if (unresolved.length === 0 && stageStopStatus(facts) !== null && !held.has(row.stageId)) return null;
    stops.push(...unresolved);
    if (unresolved.includes('blocked')) blockedIds.push(row.executionId);
  }
  if ([...held].some((stageId) => !hasRow(latest, stageId))) stops.push('expired');
  const status = foldStoppedStatus(stops);
  return status === null ? null : { status, blockedIds };
}

const hasRow = (latest: readonly StatusExecution[], stageId: string): boolean =>
  latest.some((row) => row.stageId === stageId);

/** A cancelled stage with a recorded reply can be dispatched, so the session stays active. */
function isRepliedCancel(row: StatusExecution, events: readonly ParsedEvent[]): boolean {
  return row.status === 'cancelled' && hasCancelledReply(events, row.executionId);
}

function hasCancelledReply(events: readonly ParsedEvent[], executionId: string): boolean {
  return events.some(
    (event) => event.event === 'session.active' && event.executionId === executionId && event.data.from === CANCELLED_REPLY,
  );
}
