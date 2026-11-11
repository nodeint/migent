/** Once, loop, and pool dispatch for an opened session, plus the tracking of in-flight dispatches. */
import path from 'node:path';

import { cancellationSignal, ConfigurationError,type ExecutionSnapshot } from '@nodeint/migent-kernel';
import { readyStages, revisionStop, runnableNow, schedulableStageIds, Stop, VERIFY_EXHAUSTED, VERIFY_FAILED, version2IdleReason, writeJsonAtomic } from '@nodeint/migent-kernel';
import { clearInFlightExecution, noteInFlightExecution, type SessionStore } from '@nodeint/migent-session';
import { isRecord, isWorkflowV2, type WorkflowDocument } from '@nodeint/migent-workflow';

import type { AgentToolRunner } from './agent-runner.js';
import {
  assertStageDispatchable,
  blockResumes,
  dispatchExecuteStage,
  executeFinal,
  type ExecuteResult,
  type PendingStageReply,
  selectedStage,
  TERMINAL_SESSION_STATUSES,
  text,
} from './dispatch.js';


export async function runExecuteOnce(
  workspace: string,
  store: SessionStore,
  workflow: WorkflowDocument,
  workflowId: string,
  sessionId: string,
  stageId: string | null,
  runner: AgentToolRunner,
  tasks: Map<string, Promise<unknown>>,
  reply: PendingStageReply | null,
): Promise<ExecuteResult> {
  store.reapOrphanedExecutions(sessionId, 'raise');
  const snapshots = store.executionSnapshots(sessionId);
  let status = store.readSessionStatus(sessionId);
  const sessionStatus = text(status.status);
  if (TERMINAL_SESSION_STATUSES.has(sessionStatus)) return executeFinal(status, sessionStatus, []);
  const chosen = isWorkflowV2(workflow)
    ? version2OnceStage(workspace, workflow, sessionId, snapshots, status, stageId)
    : version1OnceStage(workspace, workflow, sessionId, snapshots, status, stageId);
  if (typeof chosen !== 'string') return chosen;
  assertStageDispatchable(workspace, workflow, sessionId, chosen);
  const stage = await trackDispatch(sessionId, tasks, (note) =>
    dispatchExecuteStage(
      workspace,
      workflow,
      workflowId,
      sessionId,
      chosen,
      status,
      snapshots,
      runner,
      note,
      reply,
    ),
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

function version1OnceStage(
  workspace: string,
  workflow: WorkflowDocument,
  sessionId: string,
  snapshots: readonly ExecutionSnapshot[],
  status: Record<string, unknown>,
  stageId: string | null,
): string | ExecuteResult {
  const selected = selectedStage(workflow, snapshots, text(status.status), blockResumes(workspace, sessionId));
  if (selected instanceof Stop) return executeFinal(status, selected.reason, []);
  if (stageId !== null && selected.stageId !== stageId) {
    throw new ConfigurationError(`Stage ${stageId} is not the eligible stage ${selected.stageId}.`);
  }
  if (revisionStop(workflow, snapshots, selected.stageId, revisionBaselines(status))) {
    return executeFinal(status, 'revisions_exhausted', []);
  }
  return selected.stageId;
}

function version2OnceStage(
  workspace: string,
  workflow: WorkflowDocument,
  sessionId: string,
  snapshots: readonly ExecutionSnapshot[],
  status: Record<string, unknown>,
  stageId: string | null,
): string | ExecuteResult {
  const sessionStatus = text(status.status);
  const baselines = revisionBaselines(status);
  const resumes = blockResumes(workspace, sessionId);
  const ready = readyStages(workflow, snapshots, sessionStatus, baselines, resumes);
  const schedulable = schedulableStageIds(workflow, snapshots, sessionStatus, baselines, resumes, new Set());
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
      const first = runnableNow(workflow, schedulable, running, workflow.concurrency ?? 1, snapshots)[0] ?? ready[0] ?? '';
      throw new ConfigurationError(`Stage ${stageId} is not the eligible stage ${first}.`);
    }
    if (revisionStop(workflow, snapshots, stageId, baselines)) {
      return executeFinal(status, 'revisions_exhausted', []);
    }
    return stageId;
  }
  const [next] = runnableNow(workflow, schedulable, running, workflow.concurrency ?? 1, snapshots);
  if (next === undefined) {
    const reason = version2IdleReason(workflow, snapshots, sessionStatus, baselines, resumes);
    if (reason === 'no eligible stage') throw new ConfigurationError('no eligible stage');
    return executeFinal(status, reason, []);
  }
  if (revisionStop(workflow, snapshots, next, baselines)) {
    return executeFinal(status, 'revisions_exhausted', []);
  }
  return next;
}

export async function runExecuteLoop(
  workspace: string,
  store: SessionStore,
  workflow: WorkflowDocument,
  workflowId: string,
  sessionId: string,
  maxDispatches: number | null,
  runner: AgentToolRunner,
  tasks: Map<string, Promise<unknown>>,
  reply: PendingStageReply | null,
  alreadyDispatched = 0,
  verifyTriedSeed: readonly string[] = [],
  verifyOnlyTriedSeed: readonly string[] = [],
): Promise<ExecuteResult> {
  if (isWorkflowV2(workflow)) {
    return runVersion2Pool(
      workspace,
      store,
      workflow,
      workflowId,
      sessionId,
      maxDispatches,
      runner,
      tasks,
      reply,
      alreadyDispatched,
      verifyTriedSeed,
      verifyOnlyTriedSeed,
    );
  }
  const stages: Record<string, unknown>[] = [];
  let dispatched = alreadyDispatched;
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
    const selected = selectedStage(workflow, snapshots, text(status.status), blockResumes(workspace, sessionId));
    if (selected instanceof Stop) return executeFinal(status, selected.reason, stages);
    if (revisionStop(workflow, snapshots, selected.stageId, revisionBaselines(status))) {
      return executeFinal(status, 'revisions_exhausted', stages);
    }
    if (maxDispatches !== null && dispatched >= maxDispatches) {
      return executeFinal(status, 'dispatch_limit', stages);
    }
    dispatched += 1;
    const dispatchedStage = await trackDispatch(sessionId, tasks, (note) =>
      dispatchExecuteStage(
        workspace,
        workflow,
        workflowId,
        sessionId,
        selected.stageId,
        status,
        snapshots,
        runner,
        note,
        reply,
      ),
    );
    const stopped = accept(dispatchedStage);
    if (stopped) return stopped;
  }
}

async function runVersion2Pool(
  workspace: string,
  store: SessionStore,
  workflow: WorkflowDocument,
  workflowId: string,
  sessionId: string,
  maxDispatches: number | null,
  runner: AgentToolRunner,
  tasks: Map<string, Promise<unknown>>,
  reply: PendingStageReply | null,
  alreadyDispatched = 0,
  verifyTriedSeed: readonly string[] = [],
  verifyOnlyTriedSeed: readonly string[] = [],
): Promise<ExecuteResult> {
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
      dispatchExecuteStage(
        workspace,
        workflow,
        workflowId,
        sessionId,
        stageId,
        status,
        snapshots,
        runner,
        note,
        reply,
      ),
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
    const remaining = schedulableStageIds(
      workflow,
      endSnapshots,
      endSession,
      endBaselines,
      endResumes,
      verifyTried,
      verifyOnlyTried,
    );
    if (remaining.length > 0) return executeFinal(endStatus, 'dispatch_limit', stages);
    const reason = version2IdleReason(workflow, endSnapshots, endSession, endBaselines, endResumes);
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
    const schedulable = schedulableStageIds(
      workflow,
      snapshots,
      sessionStatus,
      baselines,
      resumes,
      verifyTried,
      verifyOnlyTried,
);
    const running = runningStageIds(snapshots);
    const ceiling = maxDispatches === null ? Number.POSITIVE_INFINITY : maxDispatches;
    const room = ceiling - dispatched;
    if (room > 0) {
      const cap = Math.min(concurrency, running.length + room);
      const starting = runnableNow(workflow, schedulable, running, cap, snapshots);
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
      const reason = version2IdleReason(workflow, snapshots, sessionStatus, baselines, resumes);
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
  sessionId: string,
  executionId: string,
  tasks: Map<string, Promise<unknown>>,
  start: () => Promise<T>,
): Promise<T> {
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
