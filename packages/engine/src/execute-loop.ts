/** Once, loop, and pool dispatch for an opened session, plus the tracking of in-flight dispatches. */
import path from 'node:path';

import { exitCode } from '@nodeint/migent-contracts';
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
  const status = store.readSessionStatus(sessionId);
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
  return onceResult(store.readSessionStatus(sessionId), stage);
}

const STAGE_STOP_REASONS: readonly string[] = [VERIFY_FAILED, VERIFY_EXHAUSTED];

// Maps the single dispatched stage and the refreshed session status to the pass result.
function onceResult(status: Record<string, unknown>, stage: Record<string, unknown>): ExecuteResult {
  const failureReason = text(stage.failure_reason);
  if (STAGE_STOP_REASONS.includes(failureReason)) return executeFinal(status, failureReason, [stage]);
  if (stage.failure_kind === 'quota') return executeFinal(status, 'quota', [stage]);
  const after = text(status.status);
  const stopReason = TERMINAL_SESSION_STATUSES.has(after) ? after : 'stage';
  const result = executeFinal(status, stopReason, [stage]);
  if (stage.outcome_status === 'question') {
    result.code = 9;
    result.stopReason = 'question';
  }
  if (stopReason === 'stage' && stage.outcome_status !== 'complete' && stage.execution_status !== 'skipped') {
    result.code = stage.outcome_status === 'question' ? exitCode('question') : exitCode('blocked');
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
  const resumes = blockResumes(workspace, sessionId);
  const schedule = { sessionStatus: text(status.status), revisionBaselines: revisionBaselines(status), resumes };
  const schedulable = schedulableStageIds(workflow, snapshots, { ...schedule, verifyTried: new Set() });
  const runnable = runnableNow(workflow, schedulable, {
    running: runningStageIds(snapshots),
    concurrency: workflow.concurrency ?? 1,
    snapshots,
  });
  let chosen: string;
  if (stageId === null) {
    const [next] = runnable;
    if (next === undefined) return idleResult(run, state, schedule);
    chosen = next;
  } else {
    if (unresumedFailure(snapshots, resumes, stageId)) return executeFinal(status, 'stage_failed', []);
    if (!schedulable.includes(stageId)) {
      const first = runnable[0] ?? readyStages(workflow, snapshots, schedule)[0] ?? '';
      throw new ConfigurationError(`Stage ${stageId} is not the eligible stage ${first}.`);
    }
    chosen = stageId;
  }
  if (revisionStop(workflow, snapshots, { stageId: chosen, revisionBaselines: schedule.revisionBaselines })) {
    return executeFinal(status, 'revisions_exhausted', []);
  }
  return chosen;
}


// Reports why nothing can run, or fails when the workflow has no eligible stage at all.
function idleResult(
  run: Pick<ExecuteRun, 'workflow'>,
  state: PassState & { readonly stages?: Record<string, unknown>[] },
  schedule: Schedule,
): ExecuteResult {
  const reason = version2IdleReason(run.workflow, state.snapshots, schedule);
  if (reason === 'no eligible stage') throw new ConfigurationError('no eligible stage');
  return executeFinal(state.status, reason, state.stages ?? []);
}


// True when the stage's latest execution failed (not by verify) and was never resumed from failure.
function unresumedFailure(snapshots: readonly ExecutionSnapshot[], resumes: Resumes, stageId: string): boolean {
  const latest = latestSnapshotForStage(snapshots, stageId);
  if (latest?.status !== 'failed') return false;
  if (latest.failureReason === VERIFY_EXHAUSTED || latest.failureReason === VERIFY_FAILED) return false;
  return !resumes.some(
    (event) =>
      event.event === 'session.active' && event.executionId === latest.executionId && event.data?.from === 'failed',
  );
}

type Resumes = ReturnType<typeof blockResumes>;

/** Scheduling inputs shared by the version 2 stage selectors. */
interface Schedule {
  readonly sessionStatus: string;
  readonly revisionBaselines: Record<string, number> | null;
  readonly resumes: Resumes;
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
  const pool = new Version2Pool(run, limits);
  while (true) {
    const result = await pool.pass();
    if (result !== null) return result;
  }
}

type Flight = { promise: Promise<void>; settled: boolean };

/** Dispatches runnable version 2 stages concurrently until the session idles or hits a limit. */
class Version2Pool {
  private readonly stages: Record<string, unknown>[] = [];
  private dispatched: number;
  private readonly verifyTried: Set<string>;
  private readonly verifyOnlyTried: Set<string>;
  private readonly flights: Flight[] = [];
  private readonly errors: unknown[] = [];
  private readonly maxDispatches: number | null;

  constructor(
    private readonly run: ExecuteRun,
    limits: LoopLimits,
  ) {
    this.maxDispatches = limits.maxDispatches;
    this.dispatched = limits.alreadyDispatched ?? 0;
    this.verifyTried = new Set<string>(limits.verifyTriedSeed ?? []);
    this.verifyOnlyTried = new Set<string>(limits.verifyOnlyTriedSeed ?? []);
  }

  // Runs one scheduling pass; returns the final result, or null to keep looping.
  public async pass(): Promise<ExecuteResult | null> {
    const { workspace, store, sessionId } = this.run;
    cancellationSignal().throwIfCancelled();
    await this.observe();
    store.reapOrphanedExecutions(sessionId, 'raise');
    const snapshots = store.executionSnapshots(sessionId);
    const status = store.readSessionStatus(sessionId);
    const sessionStatus = text(status.status);
    if (sessionStatus === 'cancelled') {
      await this.settleAll();
      return executeFinal(status, 'cancelled', []);
    }
    const capped = await this.settleCeiling();
    if (capped) return capped;
    const resumes = blockResumes(workspace, sessionId);
    const schedule = { sessionStatus, revisionBaselines: revisionBaselines(status), resumes };
    this.startRunnable({ snapshots, status }, schedule);
    const cappedAfterStart = await this.settleCeiling();
    if (cappedAfterStart) return cappedAfterStart;
    if (this.flights.length === 0) return idleResult(this.run, { snapshots, status, stages: this.stages }, schedule);
    await Promise.race(this.flights.map((flight) => flight.promise));
    return null;
  }

  // Starts as many runnable stages as concurrency and the dispatch ceiling allow.
  private startRunnable(state: PassState, schedule: Schedule): void {
    const { workspace, workflow, sessionId } = this.run;
    const { snapshots, status } = state;
    const room = (this.maxDispatches ?? Number.POSITIVE_INFINITY) - this.dispatched;
    if (room <= 0) return;
    const { verifyTried, verifyOnlyTried } = this;
    const schedulable = schedulableStageIds(workflow, snapshots, { ...schedule, verifyTried, verifyOnlyTried });
    const running = runningStageIds(snapshots);
    const cap = Math.min(workflow.concurrency ?? 1, running.length + room);
    const starting = runnableNow(workflow, schedulable, { running, concurrency: cap, snapshots });
    if (schedule.sessionStatus === 'blocked' && starting.length > 0) reactivateBlockedSession(workspace, sessionId, status);
    for (const stageId of starting) this.startStage(stageId, state);
  }

  private startStage(stageId: string, state: PassState): void {
    const { sessionId, tasks } = this.run;
    const { status, snapshots } = state;
    const flight: Flight = { promise: Promise.resolve(), settled: false };
    flight.promise = trackDispatch(sessionId, tasks, (note) =>
      dispatchExecuteStage(this.run, { stageId, status, snapshots }, note),
    )
      .then((stage) => {
        this.stages.push(stage);
        if (stage.failure_reason === VERIFY_EXHAUSTED) this.verifyTried.add(stageId);
        if (stage.failure_reason === VERIFY_FAILED) this.verifyOnlyTried.add(stageId);
      })
      .catch((error: unknown) => {
        this.errors.push(error);
      })
      .finally(() => {
        flight.settled = true;
      });
    this.flights.push(flight);
    this.dispatched += 1;
  }

  private observe(): Promise<void> {
    return observeFlights(this.flights, this.errors);
  }

  private async settleAll(): Promise<void> {
    await Promise.allSettled(this.flights.map((flight) => flight.promise));
  }

  private async settleCeiling(): Promise<ExecuteResult | null> {
    if (this.maxDispatches === null || this.dispatched < this.maxDispatches) return null;
    await this.settleAll();
    await this.observe();
    const { verifyTried, verifyOnlyTried } = this;
    return dispatchLimitResult(this.run, { verifyTried, verifyOnlyTried }, this.stages);
  }
}

// Rethrows the first dispatch error once every flight settles; otherwise drops settled flights.
async function observeFlights(
  flights: { promise: Promise<void>; settled: boolean }[],
  errors: readonly unknown[],
): Promise<void> {
  const [error] = errors;
  if (error !== undefined) {
    await Promise.allSettled(flights.map((flight) => flight.promise));
    throw error;
  }
  for (let index = flights.length - 1; index >= 0; index -= 1) {
    if (flights[index].settled) flights.splice(index, 1);
  }
}

// Builds the final result once the dispatch ceiling is reached and every flight has settled.
function dispatchLimitResult(
  run: ExecuteRun,
  tried: { verifyTried: ReadonlySet<string>; verifyOnlyTried: ReadonlySet<string> },
  stages: Record<string, unknown>[],
): ExecuteResult {
  const { workspace, store, workflow, sessionId } = run;
  const { verifyTried, verifyOnlyTried } = tried;
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
}

// Marks a blocked session active again because a stage is about to start.
function reactivateBlockedSession(workspace: string, sessionId: string, status: Record<string, unknown>): void {
  status.status = 'active';
  delete status.blocked_by_execution_id;
  delete status.blocked_by_execution_ids;
  delete status.blocked_by_stage_id;
  delete status.blocker;
  delete status.terminal_execution_id;
  writeJsonAtomic(path.join(workspace, '.migent', 'sessions', sessionId, 'status.json'), status);
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
