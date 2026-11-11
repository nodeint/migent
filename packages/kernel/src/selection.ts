import { pyRepr } from '@nodeint/migent-workflow';
import {
  dependencyClosure,
  isWorkflowV2,
  routeListsStage,
  type StageSpec,
  type WorkflowDocument,
} from '@nodeint/migent-workflow';

import { type ExecutionSnapshot,isArtifactSchema, missingWorkflowOutputNames } from './outputs.js';
import {
  currentCompleteByStage,
  dependsOnStage,
  incomingRouters,
  latestSnapshot,
  latestStageSnapshot,
  latestVisitOrder,
  revisionStop,
  routersCompletedSince,
  routerSkippedSince,
  type ScheduleView,
  scheduleView,
  supersedingSkip,
  VERIFY_EXHAUSTED,
  VERIFY_FAILED,
  verifyExhaustedExecution,
  verifyFailedExecution,
} from './selection-history.js';
import { declarationOrder } from './selection-pool.js';

export { runnableNow,type RunPool } from './selection-pool.js';

const terminalSessionStatuses = new Set(['blocked', 'question', 'cancelled', 'completed']);

export class NextStage {
  constructor(public readonly stageId: string) {}
}

export class Stop {
  constructor(public readonly reason: string) {}
}

/** Python selection.Error. Named so it does not shadow the global Error. */
export class NextStageError {
  constructor(public readonly message: string) {}
}

export type NextStageResult = NextStage | Stop | NextStageError;

/** One resume event of the session, as recorded by the ledger. */
export interface BlockResume {
  event: string;
  executionId?: string | null;
  data?: { from?: unknown };
}

/** The session facts a scheduling decision reads next to the workflow and its snapshots. */
export interface ScheduleState {
  readonly sessionStatus: string;
  readonly revisionBaselines?: Readonly<Record<string, number>> | null;
  readonly resumes?: readonly BlockResume[] | null;
}

// Tests and callers address these through the scheduling module.
export { currentCompleteByStage, latestCompleteByStage } from './selection-history.js';

export function nextStage(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  state: ScheduleState,
): NextStageResult {
  const { sessionStatus, resumes } = state;
  if (snapshots.some((snapshot) => snapshot.status === 'running')) {
    return new NextStageError('an execution is still running');
  }
  if (terminalSessionStatuses.has(sessionStatus)) return new Stop(sessionStatus);
  const latest = latestSnapshot(snapshots);
  if (latest !== null && latest.status === 'failed') {
    if (
      latest.failureReason !== VERIFY_EXHAUSTED &&
      latest.failureReason !== VERIFY_FAILED &&
      !failedResumed(sessionStatus, latest.executionId, resumes)
    ) {
      return new Stop('stage_failed');
    }
    return new NextStage(latest.stageId);
  }
  if (isWorkflowV2(workflow)) return nextVersion2Stage(workflow, snapshots, sessionStatus);
  if (
    latest !== null &&
    latest.status === 'completed' &&
    latest.outcomeStatus === 'complete'
  ) {
    const stage = workflow.stages[latest.stageId];
    if (stage !== undefined && Object.keys(stage.routes).length > 0) {
      return routedNextStage(workflow, snapshots, { stage, latest });
    }
  }
  const selected = sequentialCandidates(workflow, snapshots, sessionStatus);
  if (selected.length === 0) return new NextStageError('no eligible stage');
  if (selected.length > 1) {
    return new NextStageError(`ambiguous next stage: ${selected.join(', ')}`);
  }
  return new NextStage(selected[0]);
}

/** Same stage list nextStage uses once a route has been followed. */
export function sequentialCandidates(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  sessionStatus: string,
): string[] {
  const candidates = candidateStageIds(workflow, snapshots);
  const ready = readyStages(workflow, snapshots, { sessionStatus });
  // A failed stage stays stopped until continue writes `from: failed` for that execution.
  return sameStageIds(ready, candidates) ? ready : candidates;
}

/**
 * Nothing is running, failed, blocked, or cancelled, and no stage can start.
 * Missing outputs do not make the graph busy; the caller checks those separately.
 */
export function version2GraphQuiet(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  sessionStatus: string,
): boolean {
  const progressed = snapshots.some(
    (snapshot) =>
      snapshot.status === 'skipped' || (snapshot.status === 'completed' && snapshot.outcomeStatus === 'complete'),
  );
  if (!progressed) return false;
  if (hasBlockingLatest(snapshots)) return false;
  return sequentialCandidates(workflow, snapshots, sessionStatus).length === 0;
}

/** Missing output names under the workflow's schema: v7 reads the skip-aware current completions. */
export function missingOutputNames(workflow: WorkflowDocument, snapshots: readonly ExecutionSnapshot[]): string[] {
  return missingWorkflowOutputNames(
    workflow,
    snapshots,
    isArtifactSchema(workflow) ? currentCompleteByStage(workflow, snapshots) : undefined,
  );
}

export function missingOutputProducers(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  sessionStatus: string,
): string[] {
  if (!isWorkflowV2(workflow) || !version2GraphQuiet(workflow, snapshots, sessionStatus)) return [];
  const missing = new Set(missingOutputNames(workflow, snapshots));
  const producers: string[] = [];
  for (const output of workflow.outputs ?? []) {
    if (!missing.has(output.name) || producers.includes(output.fromStage)) continue;
    producers.push(output.fromStage);
  }
  return producers;
}

/** Stage ids that may run now, in declaration order. */
export function readyStages(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  state: ScheduleState,
): string[] {
  const { sessionStatus, revisionBaselines, resumes } = state;
  return candidateStageIds(workflow, snapshots).filter((stageId) => {
    const latest = latestStageSnapshot(snapshots, stageId);
    if (latest !== null) {
      if (latest.status === 'running') return false;
      // Continue reopens this execution. A new dispatch would leave the cancelled one behind.
      if (latest.status === 'cancelled') return false;
      // Snapshots keep the blocked outcome after continue. The resume event is the signal.
      if ((latest.outcomeStatus === 'blocked' || latest.outcomeStatus === 'question') && !blockResumed(sessionStatus, latest.executionId, resumes)) {
        return false;
      }
      if (latest.status === 'failed') {
        if (latest.failureReason === VERIFY_EXHAUSTED || latest.failureReason === VERIFY_FAILED) return false;
        if (!failedResumed(sessionStatus, latest.executionId, resumes)) return false;
      }
    }
    if (revisionStop(workflow, snapshots, { stageId, revisionBaselines })) return false;
    return true;
  });
}

function blockResumed(
  sessionStatus: string,
  executionId: string,
  resumes: readonly BlockResume[] | null | undefined,
): boolean {
  if (sessionStatus !== 'active' || (resumes === null || resumes === undefined)) return false;
  return resumes.some(
    (event) => event.event === 'session.active' && event.executionId === executionId && (event.data?.from === 'blocked' || event.data?.from === 'question'),
  );
}

function failedResumed(
  sessionStatus: string,
  executionId: string,
  resumes: readonly BlockResume[] | null | undefined,
): boolean {
  if (sessionStatus !== 'active' || (resumes === null || resumes === undefined)) return false;
  return resumes.some(
    (event) => event.event === 'session.active' && event.executionId === executionId && event.data?.from === 'failed',
  );
}

function sameStageIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function stageDispatchError(
  workflow: WorkflowDocument,
  stageId: string,
  snapshots: readonly ExecutionSnapshot[],
): string | null {
  if (Object.keys(workflow.stages).length === 0) return null;
  const stage = workflow.stages[stageId];
  if (stage === undefined) return `Stage is not declared: ${stageId}.`;
  const view = scheduleView(workflow, snapshots);
  const latestComplete = view.current;
  for (const dep of stage.dependsOn) {
    if (latestComplete[dep] === undefined) return dependencyError({ workflow, snapshots, view }, stageId, dep);
  }
  const incoming = incomingRouters(workflow, stageId);
  if (incoming.length === 0) return null;
  if (isWorkflowV2(workflow)) return version2RouteError(workflow, stageId, view);
  const completedIncoming = incoming.filter((router) => latestComplete[router.id] !== undefined);
  if (completedIncoming.length === 0) {
    if (stage.dependsOn.length > 0) return `Stage ${stageId} is waiting for a routing decision.`;
    return null;
  }
  let [router] = completedIncoming;
  for (const item of completedIncoming.slice(1)) {
    const best = latestComplete[router.id];
    const current = latestComplete[item.id];
    if (current.executionOrder > best.executionOrder) router = item;
  }
  const decision = (latestComplete[router.id].outcomeDecision ?? '').toLowerCase();
  if (!routeListsStage(router.routes[decision], stageId)) {
    return `Stage ${stageId} is not routed by ${router.id} decision ${pyRepr(decision)}.`;
  }
  return null;
}

function dependencyError(
  scope: {
    readonly workflow: WorkflowDocument; readonly snapshots: readonly ExecutionSnapshot[]; readonly view: ScheduleView,
  },
  stageId: string,
  dep: string,
): string {
  const { workflow, snapshots, view } = scope;
  if (view.complete[dep] !== undefined) {
    const skip = supersedingSkip(workflow, snapshots, dep);
    if (skip !== null) {
      if (skip.stageId === dep) return `Stage ${stageId} depends on ${dep}, which was skipped by run_when.`;
      return `Stage ${stageId} depends on ${dep}, whose completion predates the run_when skip of ${skip.stageId}.`;
    }
  } else if (view.skips[dep] !== undefined) {
    return `Stage ${stageId} depends on ${dep}, which was skipped by run_when.`;
  }
  return `Stage ${stageId} depends on ${dep}, which has not completed.`;
}

function nextVersion2Stage(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  sessionStatus: string,
): NextStageResult {
  const latest = latestSnapshot(snapshots);
  if (latest !== null && latest.status === 'completed' && latest.outcomeStatus === 'complete') {
    const stage = workflow.stages[latest.stageId];
    if (stage !== undefined && Object.keys(stage.routes).length > 0) {
      const decision = (latest.outcomeDecision ?? '').toLowerCase();
      const target = stage.routes[decision];
      if (target === undefined) {
        return new NextStageError(`stage ${stage.id} decision ${pyRepr(decision)} is not a valid route.`);
      }
      // A list starts each listed stage from the ready set. complete ends this branch only.
      if (typeof target === 'string' && target !== 'complete') {
        const error = stageDispatchError(workflow, target, snapshots);
        if (error !== null) {
          // A quiet graph with a missing output still reruns the producer.
          const producers = missingOutputProducers(workflow, snapshots, sessionStatus);
          if (producers.length > 0) return new NextStage(producers[0]);
          return new NextStageError(error);
        }
        return new NextStage(target);
      }
    }
  }
  const selected = sequentialCandidates(workflow, snapshots, sessionStatus);
  if (selected.length > 0) return new NextStage(selected[0]);
  const producers = missingOutputProducers(workflow, snapshots, sessionStatus);
  if (producers.length > 0) return new NextStage(producers[0]);
  return new NextStageError('no eligible stage');
}

function version2RouteError(workflow: WorkflowDocument, stageId: string, view: ScheduleView): string | null {
  const since = latestVisitOrder(view, stageId);
  for (const router of incomingRouters(workflow, stageId)) {
    if (routerSkippedSince(view, router.id, since)) {
      if (dependsOnStage(workflow, router, stageId)) continue;
      return `Stage ${stageId} is not routed by ${router.id}: ${router.id} was skipped by run_when.`;
    }
    const snapshot = view.current[router.id];
    if (snapshot === undefined || snapshot.executionOrder <= since) continue;
    const decision = (snapshot.outcomeDecision ?? '').toLowerCase();
    if (!routeListsStage(router.routes[decision], stageId)) {
      if (dependsOnStage(workflow, router, stageId)) continue;
      return `Stage ${stageId} is not routed by ${router.id} decision ${pyRepr(decision)}.`;
    }
  }
  return null;
}

function routedNextStage(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  routed: { readonly stage: StageSpec; readonly latest: ExecutionSnapshot },
): NextStageResult {
  const { stage, latest } = routed;
  const decision = (latest.outcomeDecision ?? '').toLowerCase();
  const target = stage.routes[decision];
  if (typeof target !== 'string') {
    return new NextStageError(
      `stage ${stage.id} decision ${pyRepr(decision)} is not a valid route.`,
    );
  }
  if (target === 'complete') return new Stop('completed');
  const error = stageDispatchError(workflow, target, snapshots);
  if (error === null) return new NextStage(target);
  return new NextStageError(error);
}

function candidateStageIds(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
): string[] {
  const view = scheduleView(workflow, snapshots);
  const candidates: string[] = [];
  for (const [stageId, stage] of Object.entries(workflow.stages)) {
    if (stageDispatchError(workflow, stageId, snapshots) !== null) continue;
    const since = latestVisitOrder(view, stageId);
    if (since < 0) {
      candidates.push(stageId);
      continue;
    }
    if (hasLaterRouteTo(workflow, view, { stageId, completeOrder: since })) {
      candidates.push(stageId);
      continue;
    }
    if (hasNewerDependency(view.current, stage, since)) candidates.push(stageId);
  }
  return candidates;
}

function hasNewerDependency(
  complete: Readonly<Record<string, ExecutionSnapshot>>,
  stage: StageSpec,
  completeOrder: number,
): boolean {
  for (const depId of stage.dependsOn) {
    const snapshot = complete[depId];
    if (snapshot !== undefined && snapshot.executionOrder > completeOrder) return true;
  }
  return false;
}

function hasLaterRouteTo(
  workflow: WorkflowDocument,
  view: ScheduleView,
  visit: { readonly stageId: string; readonly completeOrder: number },
): boolean {
  const { stageId, completeOrder } = visit;
  if (isWorkflowV2(workflow)) {
    const relevant = routersCompletedSince(workflow, view, { stageId, since: completeOrder });
    return relevant !== null && relevant.length > 0;
  }
  for (const router of incomingRouters(workflow, stageId)) {
    const snapshot = view.complete[router.id];
    if (snapshot === undefined || snapshot.executionOrder <= completeOrder) continue;
    const decision = (snapshot.outcomeDecision ?? '').toLowerCase();
    if (routeListsStage(router.routes[decision], stageId)) return true;
  }
  return false;
}

function hasBlockingLatest(snapshots: readonly ExecutionSnapshot[]): boolean {
  const latest = new Map<string, ExecutionSnapshot>();
  for (const snapshot of snapshots) {
    const current = latest.get(snapshot.stageId);
    if (
      current === undefined ||
      snapshot.executionOrder > current.executionOrder ||
      (snapshot.executionOrder === current.executionOrder && snapshot.executionId > current.executionId)
    ) {
      latest.set(snapshot.stageId, snapshot);
    }
  }
  for (const snapshot of latest.values()) {
    if (snapshot.status === 'failed' || snapshot.status === 'cancelled' || snapshot.status === 'running') return true;
    if (snapshot.outcomeStatus === 'blocked' || snapshot.outcomeStatus === 'question') return true;
  }
  return false;
}

/** Ready stages that are not on a branch already stopped by block, verify, or retries. */
export function readyOutsideStoppedBranches(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  state: ScheduleState,
): string[] {
  const stopped = stoppedStageIds(workflow, snapshots, state);
  return readyStages(workflow, snapshots, state).filter(
    (stageId) => !onStoppedBranch(workflow, stageId, stopped),
  );
}

/** What the pool may start. Verify repair and missing outputs are included once per command. */
export interface SchedulableState extends ScheduleState {
  readonly verifyTried: ReadonlySet<string>;
  readonly verifyOnlyTried?: ReadonlySet<string>;
}

export function schedulableStageIds(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  state: SchedulableState,
): string[] {
  const { sessionStatus, verifyTried, verifyOnlyTried = new Set<string>() } = state;
  const stopped = stoppedStageIds(workflow, snapshots, state);
  const ready = readyOutsideStoppedBranches(workflow, snapshots, state);
  const extra: string[] = [];
  for (const stageId of Object.keys(workflow.stages)) {
    if (ancestorStopped(workflow, stageId, stopped)) continue;
    const repair = !verifyTried.has(stageId) && verifyExhaustedExecution(snapshots, stageId) !== null;
    const rerun = !verifyOnlyTried.has(stageId) && verifyFailedExecution(snapshots, stageId) !== null;
    if (!repair && !rerun) continue;
    extra.push(stageId);
  }
  return declarationOrder(workflow, [
    ...ready,
    ...extra,
    ...missingOutputProducers(workflow, snapshots, sessionStatus),
  ]);
}

/** Stop reason once nothing is running and nothing was started. `no eligible stage` means the graph is stuck. */
export function version2IdleReason(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  state: ScheduleState,
): string {
  const { sessionStatus, revisionBaselines, resumes } = state;
  if (version2GraphQuiet(workflow, snapshots, sessionStatus)) {
    if (missingOutputNames(workflow, snapshots).length > 0) return 'outputs_missing';
    return 'completed';
  }
  for (const stageId of Object.keys(workflow.stages)) {
    const latest = latestStageSnapshot(snapshots, stageId);
    if (latest?.outcomeStatus === 'blocked' && !blockResumed(sessionStatus, latest.executionId, resumes)) {
      return 'blocked';
    }
  }
  for (const stageId of Object.keys(workflow.stages)) {
    const latest = latestStageSnapshot(snapshots, stageId);
    if (latest?.outcomeStatus === 'question' && !blockResumed(sessionStatus, latest.executionId, resumes)) return 'question';
  }
  for (const stageId of Object.keys(workflow.stages)) {
    const latest = latestStageSnapshot(snapshots, stageId);
    if (latest !== null && latest.status === 'failed' && latest.failureReason === VERIFY_FAILED) {
      return 'verify_failed';
    }
  }
  for (const stageId of Object.keys(workflow.stages)) {
    const latest = latestStageSnapshot(snapshots, stageId);
    if (latest !== null && latest.status === 'failed' && latest.failureReason === VERIFY_EXHAUSTED) {
      return 'verify_exhausted';
    }
  }
  for (const stageId of Object.keys(workflow.stages)) {
    const latest = latestStageSnapshot(snapshots, stageId);
    if (
      latest?.status === 'failed' &&
      latest.failureReason !== VERIFY_FAILED &&
      latest.failureReason !== VERIFY_EXHAUSTED &&
      !failedResumed(sessionStatus, latest.executionId, resumes)
    ) {
      return 'stage_failed';
    }
  }
  for (const stageId of candidateStageIds(workflow, snapshots)) {
    if (revisionStop(workflow, snapshots, { stageId, revisionBaselines })) return 'revisions_exhausted';
  }
  return 'no eligible stage';
}

function stoppedStageIds(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  state: ScheduleState,
): Set<string> {
  const { sessionStatus, resumes } = state;
  const stopped = new Set<string>();
  for (const stageId of Object.keys(workflow.stages)) {
    const latest = latestStageSnapshot(snapshots, stageId);
    if (latest === null) continue;
    if ((latest.outcomeStatus === 'blocked' || latest.outcomeStatus === 'question') && !blockResumed(sessionStatus, latest.executionId, resumes)) {
      stopped.add(stageId);
    }
    if (latest.status === 'failed' && latest.failureReason === VERIFY_EXHAUSTED) stopped.add(stageId);
    if (latest.status === 'failed' && latest.failureReason === VERIFY_FAILED) stopped.add(stageId);
    if (
      latest.status === 'failed' &&
      latest.failureReason !== VERIFY_EXHAUSTED &&
      latest.failureReason !== VERIFY_FAILED &&
      !failedResumed(sessionStatus, latest.executionId, resumes)
    ) {
      stopped.add(stageId);
    }
  }
  return stopped;
}

function onStoppedBranch(workflow: WorkflowDocument, stageId: string, stopped: ReadonlySet<string>): boolean {
  return stopped.has(stageId) || ancestorStopped(workflow, stageId, stopped);
}

function ancestorStopped(workflow: WorkflowDocument, stageId: string, stopped: ReadonlySet<string>): boolean {
  for (const dep of dependencyClosure(workflow.stages, stageId)) {
    if (stopped.has(dep)) return true;
  }
  return false;
}
