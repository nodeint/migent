import { exitCode, SESSION_STATUS_CATALOG, type SessionStatusEntry } from '@nodeint/migent-contracts';

/**
 * Session-status rules derived from `SESSION_STATUS_CATALOG`. Every status set, precedence, exit code, and
 * resolution rule is read from the catalog rows, so a new status changes one row and no consumer literal.
 */

const ROWS: readonly SessionStatusEntry[] = SESSION_STATUS_CATALOG;
const rowOf = (status: string): SessionStatusEntry | undefined => ROWS.find((row) => row.name === status);
const flag = (status: string, key: 'ends_scheduling' | 'manually_completable' | 'refreshable' | 'closed' | 'terminal_fields'): boolean =>
  rowOf(status)?.[key] === true;

export const endsScheduling = (status: string): boolean => flag(status, 'ends_scheduling');
export const isManuallyCompletable = (status: string): boolean => flag(status, 'manually_completable');
export const isRefreshable = (status: string): boolean => flag(status, 'refreshable');
export const isClosed = (status: string): boolean => flag(status, 'closed');
export const hasTerminalFields = (status: string): boolean => flag(status, 'terminal_fields');
export const isManifestMirrored = (status: string): boolean => rowOf(status)?.manifest === 'mirrored';

export const isStageStop = (status: string): boolean => rowOf(status)?.kind === 'stage_stop';
export const isSessionStop = (status: string): boolean => rowOf(status)?.kind === 'session_stop';
export const isStopped = (status: string): boolean => isStageStop(status) || isSessionStop(status);

/** The session status a manifest line reads as: read or mirrored rows read through, anything else is active. */
export function manifestStatusToSession(manifestStatus: string | null): string {
  const row = manifestStatus === null ? undefined : rowOf(manifestStatus);
  return row !== undefined && row.manifest !== null ? row.name : 'active';
}

/** The latest execution facts a detector reads. Structurally compatible with `ExecutionSnapshot`. */
export interface StopFacts {
  readonly outcomeStatus?: string | null;
  /**
   * A stage-level fact, not a property of an execution row: the stage has a resume decision pending
   * (`resume.expired` with `ask` and no later `resume.decided`).
   */
  readonly pendingResume?: boolean;
}

export type StageStopName = Extract<(typeof SESSION_STATUS_CATALOG)[number], { kind: 'stage_stop' }>['name'];

/** One detector per stage-stop row: whether the stage's latest execution is stopped in that status. */
export const STAGE_STOP_DETECTORS: Record<StageStopName, (latest: StopFacts) => boolean> = {
  blocked: (latest) => latest.outcomeStatus === 'blocked',
  question: (latest) => latest.outcomeStatus === 'question',
  expired: (latest) => latest.pendingResume === true,
};

/** Stage-stop statuses, lowest precedence first. */
export function stageStopsByPrecedence(): StageStopName[] {
  return ROWS.filter((row) => row.kind === 'stage_stop')
    .sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0))
    .map((row) => row.name as StageStopName);
}

/** The stage-stop status the latest execution is in, or null. */
export function stageStopStatus(latest: StopFacts): StageStopName | null {
  return stageStopsByPrecedence().find((name) => STAGE_STOP_DETECTORS[name](latest)) ?? null;
}

/** The session state a stop's resolution is judged against. */
export interface StopResolutionState {
  sessionStatus: string;
  resumes?: readonly ResolutionEvent[] | null;
}

/**
 * Every stage stop of one stage that no event has resolved, lowest precedence first. Without a pending resume this is
 * exactly `stageStopStatus` kept when `stopResolved` is false: zero or one stop. With one, each `session.active`
 * stop is resolved by its events alone: the pending expiry is recorded after that resolution, and it is what keeps
 * the session out of `active`, so the session-status precondition of `stopResolved` would misread the reply.
 */
export function unresolvedStageStops(
  facts: StopFacts,
  executionId: string | null,
  state: StopResolutionState,
): StageStopName[] {
  if (facts.pendingResume !== true) {
    const stop = stageStopStatus(facts);
    const resolved = stop !== null && executionId !== null && stopResolved(stop, executionId, state);
    return stop === null || resolved ? [] : [stop];
  }
  const resolvedByEvent = (name: StageStopName): boolean =>
    executionId !== null && (state.resumes ?? []).some((event) => isStopResolutionEvent(event, name, executionId));
  return stageStopsByPrecedence()
    .filter((name) => STAGE_STOP_DETECTORS[name](facts))
    .filter((name) => rowOf(name)?.resolution?.event !== 'session.active' || !resolvedByEvent(name));
}

/** The stop that wins among a stage's unresolved stops (they arrive in precedence order). */
export const firstUnresolvedStop = (stops: readonly StageStopName[]): StageStopName | null => stops[0] ?? null;

/** The stop reason a run reports for a status: the catalog exit name (`resume_expired` for `expired`). */
export function stopReasonFor(status: string): string {
  return rowOf(status)?.exit ?? status;
}

/** The highest-precedence stage stop among `statuses`, or null. */
export function foldStoppedStatus(statuses: readonly string[]): StageStopName | null {
  return stageStopsByPrecedence().find((name) => statuses.includes(name)) ?? null;
}

/** One session event as the ledger records it. */
export interface ResolutionEvent {
  event: string;
  executionId?: string | null;
  data?: { from?: unknown } | null;
}

/**
 * Whether the event resolves a stop of `status` on that execution. Stage-stop rows that share a resolution event
 * form one family: an event with any `from` of the family resolves any status of it, as a resume does today.
 */
export function isStopResolutionEvent(
  event: ResolutionEvent | null | undefined,
  status: string,
  executionId: string,
): boolean {
  const resolution = rowOf(status)?.resolution;
  if (!event || !resolution || event.executionId !== executionId || event.event !== resolution.event) return false;
  const family = ROWS.filter((row) => row.kind === 'stage_stop' && row.resolution?.event === resolution.event);
  return family.some((row) => row.resolution?.from === undefined || row.resolution.from === event.data?.from);
}

/** Whether a stop of `status` on that execution was resolved by a resume while the session is `active`. */
export function stopResolved(
  status: string,
  executionId: string,
  session: { sessionStatus: string; resumes?: readonly ResolutionEvent[] | null },
): boolean {
  const events = session.resumes;
  if (session.sessionStatus !== 'active' || events === null || events === undefined) return false;
  return events.some((event) => isStopResolutionEvent(event, status, executionId));
}

/** The `from` value a writer records when it resolves a stop of `status`. */
export function resolutionFrom(status: string): string {
  const from = rowOf(status)?.resolution?.from;
  if (from === undefined) throw new Error(`Session status ${status} records no resolution source`);
  return from;
}

/** The `from` value `resumeBlockedSession` writes. The guard `acceptsBlockedResume` shares it. */
export const BLOCKED_RESUME_FROM = resolutionFrom('blocked');

/**
 * Whether `resumeBlockedSession` accepts a session in this status: a running session, or a stage stop that resolves
 * the way a blocker does. Today that is exactly active and blocked. A question resolves by reply, not by resume.
 */
export function acceptsBlockedResume(status: string): boolean {
  const row = rowOf(status);
  if (row === undefined) return false;
  return row.kind === 'running' || (row.kind === 'stage_stop' && row.resolution?.from === BLOCKED_RESUME_FROM);
}

/** The exit code `session follow --exit-when-done` returns for the status, or null while it is not final. */
export function exitFor(status: string): number | null {
  const exit = rowOf(status)?.exit;
  return exit ? exitCode(exit) : null;
}

/** Why a status change is recorded on `session.<status>`. Null when the status carries no reason. */
export function changeReason(
  status: string,
  outcome: { blocker?: string | null; decision?: string | null; question?: string | null } | null,
): string | null {
  if (status === 'question') return outcome?.question || 'question';
  if (status === 'expired') return 'resume_expired';
  if (status === 'blocked') return outcome?.blocker || 'blocked';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'completed') return outcome?.decision || 'completed';
  return null;
}
