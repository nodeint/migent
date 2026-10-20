import type { ExecutionSnapshot } from "./outputs.js";
import { pyRepr } from "./record.js";
import type { StageSpec, WorkflowDocument } from "./workflow.js";

const terminalSessionStatuses = new Set(["blocked", "cancelled", "completed"]);

export class NextStage {
  constructor(readonly stageId: string) {}
}

export class Stop {
  constructor(readonly reason: string) {}
}

/** Python selection.Error. Named so it does not shadow the global Error. */
export class NextStageError {
  constructor(readonly message: string) {}
}

export type NextStageResult = NextStage | Stop | NextStageError;

export function nextStage(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  sessionStatus: string,
): NextStageResult {
  if (snapshots.some((snapshot) => snapshot.status === "running")) {
    return new NextStageError("an execution is still running");
  }
  if (terminalSessionStatuses.has(sessionStatus)) return new Stop(sessionStatus);
  const latest = latestSnapshot(snapshots);
  if (latest !== null && latest.status === "failed") return new NextStage(latest.stageId);
  if (
    latest !== null &&
    latest.status === "completed" &&
    latest.outcomeStatus === "complete"
  ) {
    const stage = workflow.stages[latest.stageId];
    if (stage !== undefined && Object.keys(stage.routes).length > 0) {
      return routedNextStage(workflow, snapshots, stage, latest);
    }
  }
  const candidates = candidateStageIds(workflow, snapshots);
  if (candidates.length === 0) return new NextStageError("no eligible stage");
  if (candidates.length > 1) {
    return new NextStageError(`ambiguous next stage: ${candidates.join(", ")}`);
  }
  return new NextStage(candidates[0]!);
}

export function stageDispatchError(
  workflow: WorkflowDocument,
  stageId: string,
  snapshots: readonly ExecutionSnapshot[],
): string | null {
  if (Object.keys(workflow.stages).length === 0) return null;
  const stage = workflow.stages[stageId];
  if (stage === undefined) return `Stage is not declared: ${stageId}.`;
  const latestComplete = latestCompleteByStage(snapshots);
  for (const dep of stage.dependsOn) {
    if (latestComplete[dep] === undefined) {
      return `Stage ${stageId} depends on ${dep}, which has not completed.`;
    }
  }
  const incoming = incomingRouters(workflow, stageId);
  if (incoming.length === 0) return null;
  const completedIncoming = incoming.filter((router) => latestComplete[router.id] !== undefined);
  if (completedIncoming.length === 0) {
    if (stage.dependsOn.length > 0) return `Stage ${stageId} is waiting for a routing decision.`;
    return null;
  }
  let router = completedIncoming[0]!;
  for (const item of completedIncoming.slice(1)) {
    const best = latestComplete[router.id]!;
    const current = latestComplete[item.id]!;
    if (current.executionOrder > best.executionOrder) router = item;
  }
  const decision = (latestComplete[router.id]!.outcomeDecision ?? "").toLowerCase();
  const target = router.routes[decision];
  if (target !== stageId) {
    return `Stage ${stageId} is not routed by ${router.id} decision ${pyRepr(decision)}.`;
  }
  return null;
}

export function latestCompleteByStage(
  snapshots: readonly ExecutionSnapshot[],
): Record<string, ExecutionSnapshot> {
  const latest: Record<string, ExecutionSnapshot> = {};
  for (const snapshot of snapshots) {
    if (snapshot.status !== "completed" || snapshot.outcomeStatus !== "complete") continue;
    const current = latest[snapshot.stageId];
    if (current === undefined || snapshot.executionOrder > current.executionOrder) {
      latest[snapshot.stageId] = snapshot;
    }
  }
  return latest;
}

export const VERIFY_EXHAUSTED = "verify_exhausted";

export function failedStageCount(snapshots: readonly ExecutionSnapshot[], stageId: string): number {
  return snapshots.filter(
    (snapshot) =>
      snapshot.stageId === stageId &&
      snapshot.status === "failed" &&
      snapshot.failureReason !== VERIFY_EXHAUSTED,
  ).length;
}

/** The latest execution when it is a verify-exhausted failure of `stageId`. */
export function verifyExhaustedExecution(
  snapshots: readonly ExecutionSnapshot[],
  stageId: string,
): ExecutionSnapshot | null {
  const latest = latestSnapshot(snapshots);
  if (
    latest !== null &&
    latest.stageId === stageId &&
    latest.status === "failed" &&
    latest.failureReason === VERIFY_EXHAUSTED
  ) {
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
    if (snapshot.stageId !== stageId) continue;
    if (latest === null || snapshot.executionOrder > latest.executionOrder) latest = snapshot;
  }
  return latest?.executionId ?? null;
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
  const own = snapshots.filter((snapshot) => snapshot.stageId === stageId);
  if (own.length === 0) return null;
  let latestOwn = own[0]!;
  let latestCompleteOwn: ExecutionSnapshot | null = null;
  for (const snapshot of own) {
    if (snapshot.executionOrder > latestOwn.executionOrder) latestOwn = snapshot;
    if (snapshot.status !== "completed" || snapshot.outcomeStatus !== "complete") continue;
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
export function revisionStop(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  stageId: string,
  revisionBaselines?: Readonly<Record<string, number>> | null,
): boolean {
  const stage = workflow.stages[stageId];
  if (stage === undefined || stage.maxRevisions === null) return false;
  const latest = latestSnapshot(snapshots);
  if (latest !== null && latest.stageId === stageId && latest.status === "failed") return false;
  const completed = snapshots.filter(
    (snapshot) =>
      snapshot.stageId === stageId &&
      snapshot.status === "completed" &&
      snapshot.outcomeStatus === "complete",
  ).length;
  if (completed === 0) return false;
  const recorded = revisionBaselines?.[stageId] ?? 1;
  const baseline = Math.max(1, recorded);
  return completed - baseline >= stage.maxRevisions;
}

function routedNextStage(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  stage: StageSpec,
  latest: ExecutionSnapshot,
): NextStageResult {
  const decision = (latest.outcomeDecision ?? "").toLowerCase();
  const target = stage.routes[decision];
  if (target === undefined) {
    return new NextStageError(
      `stage ${stage.id} decision ${pyRepr(decision)} is not a valid route.`,
    );
  }
  if (target === "complete") return new Stop("completed");
  const error = stageDispatchError(workflow, target, snapshots);
  if (error === null) return new NextStage(target);
  return new NextStageError(error);
}

function candidateStageIds(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
): string[] {
  const complete = latestCompleteByStage(snapshots);
  const candidates: string[] = [];
  for (const [stageId, stage] of Object.entries(workflow.stages)) {
    if (stageDispatchError(workflow, stageId, snapshots) !== null) continue;
    const snapshot = complete[stageId];
    if (snapshot === undefined) {
      candidates.push(stageId);
      continue;
    }
    if (hasLaterRouteTo(workflow, complete, stageId, snapshot.executionOrder)) {
      candidates.push(stageId);
      continue;
    }
    if (hasNewerDependency(complete, stage, snapshot.executionOrder)) candidates.push(stageId);
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
  complete: Readonly<Record<string, ExecutionSnapshot>>,
  stageId: string,
  completeOrder: number,
): boolean {
  for (const router of incomingRouters(workflow, stageId)) {
    const snapshot = complete[router.id];
    if (snapshot === undefined || snapshot.executionOrder <= completeOrder) continue;
    const decision = (snapshot.outcomeDecision ?? "").toLowerCase();
    if (router.routes[decision] === stageId) return true;
  }
  return false;
}

function latestRouteTo(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  stageId: string,
): ExecutionSnapshot | null {
  let best: ExecutionSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.status !== "completed" || snapshot.outcomeStatus !== "complete") continue;
    const source = workflow.stages[snapshot.stageId];
    if (source === undefined) continue;
    const decision = (snapshot.outcomeDecision ?? "").toLowerCase();
    if (source.routes[decision] !== stageId) continue;
    if (best === null || snapshot.executionOrder > best.executionOrder) best = snapshot;
  }
  return best;
}

function latestSnapshot(snapshots: readonly ExecutionSnapshot[]): ExecutionSnapshot | null {
  if (snapshots.length === 0) return null;
  return snapshots.reduce((best, snapshot) =>
    snapshot.executionOrder > best.executionOrder ? snapshot : best,
  );
}

function incomingRouters(workflow: WorkflowDocument, stageId: string): StageSpec[] {
  return Object.values(workflow.stages).filter((stage) =>
    Object.values(stage.routes).includes(stageId),
  );
}
