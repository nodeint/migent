/** Once, loop, and pool dispatch for an opened session, plus the tracking of in-flight dispatches. */
import path from 'node:path';

import { cancellationSignal, ConfigurationError,type ExecutionSnapshot } from '@nodeint/migent-kernel';
import { readyStages, revisionStop, runnableNow, schedulableStageIds, Stop, VERIFY_EXHAUSTED, VERIFY_FAILED, version2IdleReason, writeJsonAtomic } from '@nodeint/migent-kernel';
import { clearInFlightExecution, noteInFlightExecution } from '@nodeint/migent-session';
import { isRecord, isWorkflowV2 } from '@nodeint/migent-workflow';

import {
  assertStageDispatchable,
  blockResumes,
  dispatchExecuteStage,
  executeFinal,
  type ExecuteResult,
  type ExecuteRun,
  selectedStage,
  TERMINAL_SESSION_STATUSES,
  text,
} from './dispatch.js';


export async function runExecuteOnce(run: ExecuteRun, stageId: string | null): Promise<ExecuteResult> {
  const { workspace, store, workflow, sessionId, tasks } = run;
  store.reapOrphanedExecutions(sessionId, 'raise');
  const snapshots = store.executionSnapshots(sessionId);
  let status = store.readSessionStatus(sessionId);
  const sessionStatus = text(status.status);
  if (TERMINAL_SESSION_STATUSES.has(sessionStatus)) return executeFinal(status, sessionStatus, []);
  const chosen = isWorkflowV2(workflow)
    ? version2OnceStage(run, { snapshots, status }, stageId)
    : version1OnceStage(run, { snapshots, status }, stageId);
  if (typeof chosen !== 'string') return chosen;
  assertStageDispatchable(workspace, workflow, { sessionId, stageId: chosen });
  const stage = await trackDispatch(sessionId, tasks, (note) =>
    dispatchExecuteStage(run, { stageId: chosen, status, snapshots }, note),
  );
  status = store.readSessionStatus(sessionId);
  const after = text(status.status);
  if (stage.failure_reason === VERIFY_FAILED) return executeFinal(status, VERIFY_FAILED, [stage]);
  if (stage.failure_reason === VERIFY_EXHAUSTED) return executeFinal(status, VERIFY_EXHAUSTED, [stage]);
  if (stage.failure_kind === 'quota') return executeFinal(status, 'quota', [stage]);
  const stopReason = TERMINAL_SESSION_STATUSES.has(after) ? after : 'stage';
  const result = executeFinal(status, stopReason, [stage]);
  if (stage.outcome_status === 'question') {
    result.code = 9;
    result.stopReason = 'question';
  }
  if (stopReason === 'stage' && stage.outcome_status !== 'complete' && stage.execution_status !== 'skipped') {
    result.code = stage.outcome_status === 'question' ? 9 : 1;
  }
  return result;
}

/** The executions and session status read at the start of a pass. */
interface PassState {
  readonly snapshots: readonly ExecutionSnapshot[];
  readonly status: Record<string, unknown>;
}

function version1OnceStage(
  run: Pick<ExecuteRun, 'workspace' | 'workflow' | 'sessionId'>,
  state: PassState,
  stageId: string | null,
): string | ExecuteResult {
  const { workspace, workflow, sessionId } = run;
  const { snapshots, status } = state;
  const selected = selectedStage(
    workflow,
    snapshots,
    { sessionStatus: text(status.status), resumes: blockResumes(workspace, sessionId) },
  );
  if (selected instanceof Stop) return executeFinal(status, selected.reason, []);
  if (stageId !== null && selected.stageId !== stageId) {
    throw new ConfigurationError(`Stage ${stageId} is not the eligible stage ${selected.stageId}.`);
  }
  if (revisionStop(workflow, snapshots, { stageId: selected.stageId, revisionBaselines: revisionBaselines(status) })) {
    return executeFinal(status, 'revisions_exhausted', []);
  }
  return selected.stageId;
}

function version2OnceStage(
  run: Pick<ExecuteRun, 'workspace' | 'workflow' | 'sessionId'>,
  state: PassState,
  stageId: string | null,
): string | ExecuteResult {
  const { workspace, workflow, sessionId } = run;
  const { snapshots, status } = state;
  const sessionStatus = text(status.status);
  const baselines = revisionBaselines(status);
  const resumes = blockResumes(workspace, sessionId);
  const schedule = { sessionStatus, revisionBaselines: baselines, resumes };
  const ready = readyStages(workflow, snapshots, schedule);
  const schedulable = schedulableStageIds(workflow, snapshots, { ...schedule, verifyTried: new Set() });
  const running = runningStageIds(snapshots);
  if (stageId !== null) {
    const latest = latestSnapshotForStage(snapshots, stageId);
    if (
      latest?.status === 'failed' &&
      latest.failureReason !== VERIFY_EXHAUSTED &&
      latest.failureReason !== VERIFY_FAILED &&
      !resumes.some(
        (event) =>
          event.event === 'session.active' &&
          event.executionId === latest.executionId &&
          event.data?.from === 'failed',
      )
    ) {
      return executeFinal(status, 'stage_failed', []);
    }
    if (!schedulable.includes(stageId)) {
      const first = runnableNow(workflow, schedulable, { running, concurrency: workflow.concurrency ?? 1, snapshots })[0] ?? ready[0] ?? '';
      throw new ConfigurationError(`Stage ${stageId} is not the eligible stage ${first}.`);
    }
    if (revisionStop(workflow, snapshots, { stageId, revisionBaselines: baselines })) {
      return executeFinal(status, 'revisions_exhausted', []);
    }
    return stageId;
  }
  const [next] = runnableNow(workflow, schedulable, { running, concurrency: workflow.concurrency ?? 1, snapshots });
  if (next === undefined) {
    const reason = version2IdleReason(workflow, snapshots, schedule);
    if (reason === 'no eligible stage') throw new ConfigurationError('no eligible stage');
    return executeFinal(status, reason, []);
  }
  if (revisionStop(workflow, snapshots, { stageId: next, revisionBaselines: baselines })) {
    return executeFinal(status, 'revisions_exhausted', []);
  }
  return next;
}

/** How far a loop may go, and what earlier dispatches of the run already used. */
export interface LoopLimits {
  readonly maxDispatches: number | null;
  readonly alreadyDispatched?: number;
  readonly verifyTriedSeed?: readonly string[];
  readonly verifyOnlyTriedSeed?: readonly string[];
}

export async function runExecuteLoop(run: ExecuteRun, limits: LoopLimits): Promise<ExecuteResult> {
  const { workspace, store, workflow, sessionId, tasks } = run;
  if (isWorkflowV2(workflow)) return runVersion2Pool(run, limits);
  const stages: Record<string, unknown>[] = [];
  let dispatched = limits.alreadyDispatched ?? 0;
  const accept = (stage: Record<string, unknown>): ExecuteResult | null => {
    stages.push(stage);
    if (stage.failure_reason === VERIFY_FAILED) {
      return executeFinal(store.readSessionStatus(sessionId), VERIFY_FAILED, stages);
    }
    if (stage.failure_reason === VERIFY_EXHAUSTED) {
      return executeFinal(store.readSessionStatus(sessionId), VERIFY_EXHAUSTED, stages);
    }
    return null;
    return null;
  };
  while (true) {
    cancellationSignal().throwIfCancelled();
    store.reapOrphanedExecutions(sessionId, 'raise');
    const snapshots = store.executionSnapshots(sessionId);
    const status = store.readSessionStatus(sessionId);
    const selected = selectedStage(
      workflow,
      snapshots,
      { sessionStatus: text(status.status), resumes: blockResumes(workspace, sessionId) },
    );
    if (selected instanceof Stop) return executeFinal(status, selected.reason, stages);
    if (
      revisionStop(workflow, snapshots, { stageId: selected.stageId, revisionBaselines: revisionBaselines(status) })
    ) {
      return executeFinal(status, 'revisions_exhausted', stages);
    }
    if (limits.maxDispatches !== null && dispatched >= limits.maxDispatches) {
      return executeFinal(status, 'dispatch_limit', stages);
    }
    dispatched += 1;
    const dispatchedStage = await trackDispatch(sessionId, tasks, (note) =>
      dispatchExecuteStage(run, { stageId: selected.stageId, status, snapshots }, note),
    );
    const stopped = accept(dispatchedStage);
    if (stopped) return stopped;
  }
}

async function runVersion2Pool(run: ExecuteRun, limits: LoopLimits): Promise<ExecuteResult> {
  const { workspace, store, workflow, sessionId, tasks } = run;
  const { maxDispatches, alreadyDispatched = 0, verifyTriedSeed = [], verifyOnlyTriedSeed = [] } = limits;
  const stages: Record<string, unknown>[] = [];
  let dispatched = alreadyDispatched;
  const verifyTried = new Set<string>(verifyTriedSeed);
  const verifyOnlyTried = new Set<string>(verifyOnlyTriedSeed);
  const flights: { promise: Promise<void>; settled: boolean }[] = [];
  const errors: unknown[] = [];
  const concurrency = workflow.concurrency ?? 1;
  const observe = async (): Promise<void> => {
    const [error] = errors;
    if (error !== undefined) {
      await Promise.allSettled(flights.map((flight) => flight.promise));
      throw error;
    }
    for (let index = flights.length - 1; index >= 0; index -= 1) {
      if (flights[index]!.settled) flights.splice(index, 1);
    }
  };
  const startStage = (
    stageId: string,
    status: Record<string, unknown>,
    snapshots: readonly ExecutionSnapshot[],
  ): void => {
    const flight = { promise: Promise.resolve(), settled: false };
    flight.promise = trackDispatch(sessionId, tasks, (note) =>
      dispatchExecuteStage(run, { stageId, status, snapshots }, note),
    )
      .then((stage) => {
        stages.push(stage);
        if (stage.failure_reason === VERIFY_EXHAUSTED) verifyTried.add(stageId);
        if (stage.failure_reason === VERIFY_FAILED) verifyOnlyTried.add(stageId);
      })
      .catch((error: unknown) => {
        errors.push(error);
      })
      .finally(() => {
        flight.settled = true;
      });
    flights.push(flight);
    dispatched += 1;
  };
  const settleCeiling = async (): Promise<ExecuteResult | null> => {
    if (maxDispatches === null || dispatched < maxDispatches) return null;
    await Promise.allSettled(flights.map((flight) => flight.promise));
    await observe();
    const endStatus = store.readSessionStatus(sessionId);
    const endSnapshots = store.executionSnapshots(sessionId);
    const endSession = text(endStatus.status);
    const endBaselines = revisionBaselines(endStatus);
    const endResumes = blockResumes(workspace, sessionId);
    const endSchedule = { sessionStatus: endSession, revisionBaselines: endBaselines, resumes: endResumes };
    const remaining = schedulableStageIds(workflow, endSnapshots, { ...endSchedule, verifyTried, verifyOnlyTried });
    if (remaining.length > 0) return executeFinal(endStatus, 'dispatch_limit', stages);
    const reason = version2IdleReason(workflow, endSnapshots, endSchedule);
    if (reason === 'no eligible stage') return executeFinal(endStatus, 'dispatch_limit', stages);
    return executeFinal(endStatus, reason, stages);
  };
  while (true) {
    cancellationSignal().throwIfCancelled();
    await observe();
    store.reapOrphanedExecutions(sessionId, 'raise');
    const snapshots = store.executionSnapshots(sessionId);
    const status = store.readSessionStatus(sessionId);
    const sessionStatus = text(status.status);
    if (sessionStatus === 'cancelled') {
      await Promise.allSettled(flights.map((flight) => flight.promise));
      return executeFinal(status, 'cancelled', []);
    }
    const capped = await settleCeiling();
    if (capped) return capped;
    const baselines = revisionBaselines(status);
    const resumes = blockResumes(workspace, sessionId);
    const schedule = { sessionStatus, revisionBaselines: baselines, resumes };
    const schedulable = schedulableStageIds(workflow, snapshots, { ...schedule, verifyTried, verifyOnlyTried });
    const running = runningStageIds(snapshots);
    const ceiling = maxDispatches === null ? Number.POSITIVE_INFINITY : maxDispatches;
    const room = ceiling - dispatched;
    if (room > 0) {
      const cap = Math.min(concurrency, running.length + room);
      const starting = runnableNow(workflow, schedulable, { running, concurrency: cap, snapshots });
      if (sessionStatus === 'blocked' && starting.length > 0) {
        status.status = 'active';
        delete status.blocked_by_execution_id;
        delete status.blocked_by_execution_ids;
        delete status.blocked_by_stage_id;
        delete status.blocker;
        delete status.terminal_execution_id;
        writeJsonAtomic(path.join(workspace, '.migent', 'sessions', sessionId, 'status.json'), status);
      }
      for (const stageId of starting) startStage(stageId, status, snapshots);
    }
    const cappedAfterStart = await settleCeiling();
    if (cappedAfterStart) return cappedAfterStart;
    if (flights.length === 0) {
      const reason = version2IdleReason(workflow, snapshots, schedule);
      if (reason === 'no eligible stage') throw new ConfigurationError('no eligible stage');
      return executeFinal(status, reason, stages);
    }
    await Promise.race(flights.map((flight) => flight.promise));
  }
}

function runningStageIds(snapshots: readonly ExecutionSnapshot[]): string[] {
  const ids: string[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.status === 'running' && !ids.includes(snapshot.stageId)) ids.push(snapshot.stageId);
  }
  return ids;
}

function revisionBaselines(status: Record<string, unknown>): Record<string, number> | null {
  const raw = status.revision_baselines;
  if (!isRecord(raw)) return null;
  const baselines: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number') baselines[key] = value;
  }
  return baselines;
}

function latestSnapshotForStage(
  snapshots: readonly ExecutionSnapshot[],
  stageId: string,
): ExecutionSnapshot | null {
  let latest: ExecutionSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.stageId !== stageId) continue;
    if (latest === null || snapshot.executionOrder > latest.executionOrder) latest = snapshot;
  }
  return latest;
}

export function trackDispatch(
  sessionId: string,
  tasks: Map<string, Promise<unknown>>,
  run: (note: (executionId: string) => void) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  let executionId: string | null = null;
  let resolveTask: (value: Record<string, unknown>) => void = () => {};
  let rejectTask: (error: unknown) => void = () => {};
  const task = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });
  void (async () => {
    try {
      resolveTask(
        await run((id) => {
          executionId = id;
          noteInFlightExecution(sessionId, id);
          tasks.set(id, task);
        }),
      );
    } catch (error) {
      rejectTask(error);
    }
  })();
  return task.finally(() => {
    if (executionId === null) return;
    tasks.delete(executionId);
    clearInFlightExecution(sessionId, executionId);
  });
}

export function startTracked<T>(
  track: { sessionId: string; executionId: string; tasks: Map<string, Promise<unknown>> },
  start: () => Promise<T>,
): Promise<T> {
  const { sessionId, executionId, tasks } = track;
  noteInFlightExecution(sessionId, executionId);
  // Resolve first so every id is noted before any resume can reap.
  const task = Promise.resolve()
    .then(start)
    .finally(() => {
      tasks.delete(executionId);
      clearInFlightExecution(sessionId, executionId);
    });
  tasks.set(executionId, task);
  return task;
}
