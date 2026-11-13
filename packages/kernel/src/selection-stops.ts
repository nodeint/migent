import type { WorkflowDocument } from '@nodeint/migent-workflow';

import type { ExecutionSnapshot } from './outputs.js';
import { stageStopFacts } from './resume-stops.js';
import type { BlockResume, ScheduleState } from './selection.js';
import { latestStageSnapshot, VERIFY_EXHAUSTED, VERIFY_FAILED } from './selection-history.js';
import { firstUnresolvedStop, stageStopsByPrecedence, stopReasonFor, unresolvedStageStops } from './session-status-policy.js';

/** The latest execution is stopped at a stage stop that no resume event has resolved. */
export function unresolvedStageStop(
  latest: ExecutionSnapshot,
  sessionStatus: string,
  resumes: readonly BlockResume[] | null | undefined,
): boolean {
  return firstUnresolvedStop(unresolvedStageStops(latest, latest.executionId, { sessionStatus, resumes })) !== null;
}

export function failedResumed(
  sessionStatus: string,
  executionId: string,
  resumes: readonly BlockResume[] | null | undefined,
): boolean {
  if (sessionStatus !== 'active' || (resumes === null || resumes === undefined)) return false;
  return resumes.some(
    (event) => event.event === 'session.active' && event.executionId === executionId && event.data?.from === 'failed',
  );
}

export function unresumedStageFailure(
  latest: ExecutionSnapshot,
  sessionStatus: ScheduleState['sessionStatus'],
  resumes: ScheduleState['resumes'],
): boolean {
  return (
    latest.status === 'failed' &&
    latest.failureReason !== VERIFY_FAILED &&
    latest.failureReason !== VERIFY_EXHAUSTED &&
    !failedResumed(sessionStatus, latest.executionId, resumes)
  );
}

/** The first stop reason, by precedence, that a stage holds; null when no stage is stopped. */
export function idleStopReason(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  state: ScheduleState,
): string | null {
  const { sessionStatus, resumes, pendingResumes } = state;
  const stages = Object.keys(workflow.stages).map((stageId) => {
    const latest = latestStageSnapshot(snapshots, stageId);
    return { latest, facts: stageStopFacts(stageId, latest, pendingResumes) };
  });
  const stops = stages.flatMap(({ latest, facts }) =>
    unresolvedStageStops(facts, latest?.executionId ?? null, { sessionStatus, resumes }),
  );
  const stop = stageStopsByPrecedence().find((name) => stops.includes(name));
  if (stop !== undefined) return stopReasonFor(stop);
  const latests = stages.flatMap(({ latest }) => (latest === null ? [] : [latest]));
  const failedWith = (reason: string) => latests.some((l) => l.status === 'failed' && l.failureReason === reason);
  if (failedWith(VERIFY_FAILED)) return 'verify_failed';
  if (failedWith(VERIFY_EXHAUSTED)) return 'verify_exhausted';
  return latests.some((latest) => unresumedStageFailure(latest, sessionStatus, resumes)) ? 'stage_failed' : null;
}

/** The latest execution holds its branch: an unresolved stage stop, a verify failure, or an unresumed failure. */
export function stoppedLatest(latest: ExecutionSnapshot, state: Pick<ScheduleState, 'sessionStatus' | 'resumes'>): boolean {
  const { sessionStatus, resumes } = state;
  if (unresolvedStageStop(latest, sessionStatus, resumes)) return true;
  return latest.status === 'failed' && (
    latest.failureReason === VERIFY_EXHAUSTED ||
    latest.failureReason === VERIFY_FAILED ||
    !failedResumed(sessionStatus, latest.executionId, resumes)
  );
}
