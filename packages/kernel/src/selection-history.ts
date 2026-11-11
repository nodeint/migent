/** Pure execution-history queries and verify/revision policy over stage snapshots; no scheduling. */
import { conditionalReach, dependencyClosure, isWorkflowV2, routeListsStage, type StageSpec, type WorkflowDocument } from '@nodeint/migent-workflow';

import { type ExecutionSnapshot } from './outputs.js';

/** Highest-order skip snapshot of each stage. Only run_when stages have any. */
export function latestSkipByStage(snapshots: readonly ExecutionSnapshot[]): Record<string, ExecutionSnapshot> {
  const latest: Record<string, ExecutionSnapshot> = {};
  for (const snapshot of snapshots) {
    if (snapshot.status !== 'skipped') continue;
    const current = latest[snapshot.stageId];
    if (current === undefined || snapshot.executionOrder > current.executionOrder) latest[snapshot.stageId] = snapshot;
  }
  return latest;
}

/** The newest skip whose reach includes the stage. A completion that is not newer than it is superseded. */
export function supersedingSkip(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  stageId: string,
): ExecutionSnapshot | null {
  return supersedingSkipFrom(workflow, latestSkipByStage(snapshots), stageId);
}

export function supersedingSkipFrom(
  workflow: WorkflowDocument,
  skips: Readonly<Record<string, ExecutionSnapshot>>,
  stageId: string,
): ExecutionSnapshot | null {
  let best: ExecutionSnapshot | null = null;
  for (const skip of Object.values(skips)) {
    if (!conditionalReach(workflow.stages, skip.stageId).has(stageId)) continue;
    if (best === null || skip.executionOrder > best.executionOrder) best = skip;
  }
  return best;
}

/**
 * Latest completion of each stage that scheduling may still read. A skip supersedes the completions of
 * every stage in its reach that are not newer than the skip. Without skips this equals latestCompleteByStage.
 */
export function currentCompleteByStage(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
): Record<string, ExecutionSnapshot> {
  return scheduleView(workflow, snapshots).current;
}

export interface ScheduleView {
  complete: Record<string, ExecutionSnapshot>;
  skips: Record<string, ExecutionSnapshot>;
  current: Record<string, ExecutionSnapshot>;
}

export function scheduleView(workflow: WorkflowDocument, snapshots: readonly ExecutionSnapshot[]): ScheduleView {
  const complete = latestCompleteByStage(snapshots);
  const skips = latestSkipByStage(snapshots);
  if (Object.keys(skips).length === 0) return { complete, skips, current: complete };
  const current: Record<string, ExecutionSnapshot> = {};
  for (const [stageId, snapshot] of Object.entries(complete)) {
    const skip = supersedingSkipFrom(workflow, skips, stageId);
    if (skip === null || snapshot.executionOrder > skip.executionOrder) current[stageId] = snapshot;
  }
  return { complete, skips, current };
}

/** Order of the stage's latest completion or skip, or -1 when it has neither. */
export function latestVisitOrder(view: ScheduleView, stageId: string): number {
  return Math.max(view.complete[stageId]?.executionOrder ?? -1, view.skips[stageId]?.executionOrder ?? -1);
}

export function latestCompleteByStage(
  snapshots: readonly ExecutionSnapshot[],
): Record<string, ExecutionSnapshot> {
  const latest: Record<string, ExecutionSnapshot> = {};
  for (const snapshot of snapshots) {
    if (snapshot.status !== 'completed' || snapshot.outcomeStatus !== 'complete') continue;
    const current = latest[snapshot.stageId];
    if (current === undefined || snapshot.executionOrder > current.executionOrder) {
      latest[snapshot.stageId] = snapshot;
    }
  }
  return latest;
}

export const VERIFY_EXHAUSTED = 'verify_exhausted';

export const VERIFY_FAILED = 'verify_failed';

export function failedStageCount(snapshots: readonly ExecutionSnapshot[], stageId: string): number {
  return snapshots.filter(
    (snapshot) =>
      snapshot.stageId === stageId &&
      snapshot.status === 'failed' &&
      snapshot.failureReason !== VERIFY_EXHAUSTED &&
      snapshot.failureReason !== VERIFY_FAILED,
  ).length;
}

/** The stage's latest execution when that execution is a verify-exhausted failure. */
export function verifyExhaustedExecution(
  snapshots: readonly ExecutionSnapshot[],
  stageId: string,
): ExecutionSnapshot | null {
  const latest = latestStageSnapshot(snapshots, stageId);
  if (latest !== null && latest.status === 'failed' && latest.failureReason === VERIFY_EXHAUSTED) {
    return latest;
  }
  return null;
}

/** The stage's latest execution when that execution is a verify-only failure. */
export function verifyFailedExecution(
  snapshots: readonly ExecutionSnapshot[],
  stageId: string,
): ExecutionSnapshot | null {
  const latest = latestStageSnapshot(snapshots, stageId);
  if (latest !== null && latest.status === 'failed' && latest.failureReason === VERIFY_FAILED) {
    return latest;
  }
  return null;
}

/**
 * Execution that holds a stage's provider agent. Any later visit continues it.
 * A stage that has not run yet has no agent. `resume_from` does not use this:
 * that stage continues the named dependency's agent instead.
 */
export function stageAgentExecution(
  snapshots: readonly ExecutionSnapshot[],
  stageId: string,
): string | null {
  let latest: ExecutionSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.stageId !== stageId || snapshot.status === 'skipped') continue;
    if (latest === null || snapshot.executionOrder > latest.executionOrder) latest = snapshot;
  }
  return latest?.executionId ?? null;
}

/**
 * True when this dispatch continues an execution that already received this
 * stage's prompt. A `resume_from` visit joins the dependency's agent until a
 * route comes back, so that visit still needs the full stage prompt.
 */
export function stagePromptAlreadyDelivered(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  stageId: string,
): boolean {
  const stage = workflow.stages[stageId];
  if (stage === undefined) return false;
  if (stage.resumeFrom) return revisionResumeExecution(workflow, snapshots, stageId) !== null;
  return stageAgentExecution(snapshots, stageId) !== null;
}

/**
 * Provider session to continue when a `resume_from` stage is routed back to
 * itself. The latest execution of that stage holds the agent. A visit that
 * was not routed back resolves `resume_from` instead.
 */
export function revisionResumeExecution(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  stageId: string,
): string | null {
  const own = snapshots.filter((snapshot) => snapshot.stageId === stageId && snapshot.status !== 'skipped');
  if (own.length === 0) return null;
  let [latestOwn] = own;
  let latestCompleteOwn: ExecutionSnapshot | null = null;
  for (const snapshot of own) {
    if (snapshot.executionOrder > latestOwn.executionOrder) latestOwn = snapshot;
    if (snapshot.status !== 'completed' || snapshot.outcomeStatus !== 'complete') continue;
    if (latestCompleteOwn === null || snapshot.executionOrder > latestCompleteOwn.executionOrder) {
      latestCompleteOwn = snapshot;
    }
  }
  if (latestCompleteOwn === null) return null;
  const route = latestRouteTo(workflow, snapshots, stageId);
  if (route === null) return null;
  const routedBack =
    route.executionId === latestCompleteOwn.executionId ||
    route.executionOrder > latestCompleteOwn.executionOrder;
  if (!routedBack) return null;
  return latestOwn.executionId;
}

/**
 * True when another routed visit would pass the stage's maxRevisions.
 * The first successful visit is free. A failed retry of the visit already
 * started does not count. A baseline is the successful visits at the last continue.
 */
export interface RevisionQuery {
  readonly stageId: string;
  readonly revisionBaselines?: Readonly<Record<string, number>> | null;
}

export function revisionStop(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  query: RevisionQuery,
): boolean {
  const { stageId, revisionBaselines } = query;
  const stage = workflow.stages[stageId];
  if (stage === undefined || stage.maxRevisions === null) return false;
  const latest = latestStageSnapshot(snapshots, stageId);
  if (latest !== null && latest.status === 'failed') return false;
  const completed = snapshots.filter(
    (snapshot) =>
      snapshot.stageId === stageId &&
      snapshot.status === 'completed' &&
      snapshot.outcomeStatus === 'complete',
  ).length;
  if (completed === 0) return false;
  const recorded = revisionBaselines?.[stageId] ?? 1;
  const baseline = Math.max(1, recorded);
  return completed - baseline >= stage.maxRevisions;
}

/** The router's latest visit is a skip after `since`. It lists no target. */
export function routerSkippedSince(view: ScheduleView, routerId: string, since: number): boolean {
  const skip = view.skips[routerId];
  if (skip === undefined || skip.executionOrder <= since) return false;
  return skip.executionOrder > (view.complete[routerId]?.executionOrder ?? -1);
}

/** A router downstream of the stage is a route back, so its other decisions do not block it. */
export function dependsOnStage(workflow: WorkflowDocument, router: StageSpec, stageId: string): boolean {
  return dependencyClosure(workflow.stages, router.id).has(stageId);
}

/**
 * Null when a router that finished since `since` does not list the stage.
 * A router that depends on the stage does not block it when it goes elsewhere.
 */
export function relevantRouterSnapshots(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  stageId: string,
): ExecutionSnapshot[] | null {
  const view = scheduleView(workflow, snapshots);
  return routersCompletedSince(workflow, view, { stageId, since: latestVisitOrder(view, stageId) });
}

export function routersCompletedSince(
  workflow: WorkflowDocument,
  view: ScheduleView,
  visit: { readonly stageId: string; readonly since: number },
): ExecutionSnapshot[] | null {
  const { stageId, since } = visit;
  const relevant: ExecutionSnapshot[] = [];
  for (const router of incomingRouters(workflow, stageId)) {
    if (routerSkippedSince(view, router.id, since)) {
      if (dependsOnStage(workflow, router, stageId)) continue;
      return null;
    }
    const snapshot = view.current[router.id];
    if (snapshot === undefined || snapshot.executionOrder <= since) continue;
    const decision = (snapshot.outcomeDecision ?? '').toLowerCase();
    if (!routeListsStage(router.routes[decision], stageId)) {
      if (dependsOnStage(workflow, router, stageId)) continue;
      return null;
    }
    relevant.push(snapshot);
  }
  relevant.sort((left, right) => left.executionOrder - right.executionOrder);
  return relevant;
}

export function latestRouteTo(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  stageId: string,
): ExecutionSnapshot | null {
  if (isWorkflowV2(workflow)) {
    const relevant = relevantRouterSnapshots(workflow, snapshots, stageId);
    if (relevant === null || relevant.length === 0) return null;
    return relevant[relevant.length - 1];
  }
  let best: ExecutionSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.status !== 'completed' || snapshot.outcomeStatus !== 'complete') continue;
    const source = workflow.stages[snapshot.stageId];
    if (source === undefined) continue;
    const decision = (snapshot.outcomeDecision ?? '').toLowerCase();
    if (!routeListsStage(source.routes[decision], stageId)) continue;
    if (best === null || snapshot.executionOrder > best.executionOrder) best = snapshot;
  }
  return best;
}

export function latestStageSnapshot(
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

export function latestSnapshot(snapshots: readonly ExecutionSnapshot[]): ExecutionSnapshot | null {
  if (snapshots.length === 0) return null;
  return snapshots.reduce((best, snapshot) =>
    snapshot.executionOrder > best.executionOrder ? snapshot : best,
  );
}

export function incomingRouters(workflow: WorkflowDocument, stageId: string): StageSpec[] {
  return Object.values(workflow.stages).filter((stage) =>
    Object.values(stage.routes).some((target) => routeListsStage(target, stageId)),
  );
}
