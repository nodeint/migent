import { missingWorkflowOutputNames, type ExecutionSnapshot } from "./outputs.js";
import { pyRepr } from "./record.js";
import {
  dependencyClosure,
  isWorkflowV2,
  routeListsStage,
  type StageSpec,
  type WorkflowDocument,
} from "./workflow.js";

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
  resumes?: readonly BlockResume[] | null,
): NextStageResult {
  if (snapshots.some((snapshot) => snapshot.status === "running")) {
    return new NextStageError("an execution is still running");
  }
  if (terminalSessionStatuses.has(sessionStatus)) return new Stop(sessionStatus);
  const latest = latestSnapshot(snapshots);
  if (latest !== null && latest.status === "failed") {
    if (
      latest.failureReason !== VERIFY_EXHAUSTED &&
      latest.failureReason !== VERIFY_FAILED &&
      !failedResumed(sessionStatus, latest.executionId, resumes)
    ) {
      return new Stop("stage_failed");
    }
    return new NextStage(latest.stageId);
  }
  if (isWorkflowV2(workflow)) return nextVersion2Stage(workflow, snapshots, sessionStatus, latest);
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
  const selected = sequentialCandidates(workflow, snapshots, sessionStatus);
  if (selected.length === 0) return new NextStageError("no eligible stage");
  if (selected.length > 1) {
    return new NextStageError(`ambiguous next stage: ${selected.join(", ")}`);
  }
  return new NextStage(selected[0]!);
}

/** Same stage list nextStage uses once a route has been followed. */
export function sequentialCandidates(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  sessionStatus: string,
): string[] {
  const candidates = candidateStageIds(workflow, snapshots);
  const ready = readyStages(workflow, snapshots, sessionStatus);
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
  if (!snapshots.some((snapshot) => snapshot.status === "completed" && snapshot.outcomeStatus === "complete")) {
    return false;
  }
  if (hasBlockingLatest(snapshots)) return false;
  return sequentialCandidates(workflow, snapshots, sessionStatus).length === 0;
}

export function missingOutputProducers(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  sessionStatus: string,
): string[] {
  if (!isWorkflowV2(workflow) || !version2GraphQuiet(workflow, snapshots, sessionStatus)) return [];
  const missing = new Set(missingWorkflowOutputNames(workflow, snapshots));
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
  sessionStatus: string,
  revisionBaselines?: Readonly<Record<string, number>> | null,
  resumes?: readonly BlockResume[] | null,
): string[] {
  return candidateStageIds(workflow, snapshots).filter((stageId) => {
    const latest = latestStageSnapshot(snapshots, stageId);
    if (latest !== null) {
      if (latest.status === "running") return false;
      // Continue reopens this execution. A new dispatch would leave the cancelled one behind.
      if (latest.status === "cancelled") return false;
      // Snapshots keep the blocked outcome after continue. The resume event is the signal.
      if (latest.outcomeStatus === "blocked" && !blockResumed(sessionStatus, latest.executionId, resumes)) {
        return false;
      }
      if (latest.status === "failed") {
        if (latest.failureReason === VERIFY_EXHAUSTED || latest.failureReason === VERIFY_FAILED) return false;
        if (!failedResumed(sessionStatus, latest.executionId, resumes)) return false;
      }
    }
    if (revisionStop(workflow, snapshots, stageId, revisionBaselines)) return false;
    return true;
  });
}

interface BlockResume {
  event: string;
  executionId?: string | null;
  data?: { from?: unknown };
}

function blockResumed(
  sessionStatus: string,
  executionId: string,
  resumes: readonly BlockResume[] | null | undefined,
): boolean {
  if (sessionStatus !== "active" || resumes == null) return false;
  return resumes.some(
    (event) => event.event === "session.active" && event.executionId === executionId && event.data?.from === "blocked",
  );
}

function failedResumed(
  sessionStatus: string,
  executionId: string,
  resumes: readonly BlockResume[] | null | undefined,
): boolean {
  if (sessionStatus !== "active" || resumes == null) return false;
  return resumes.some(
    (event) => event.event === "session.active" && event.executionId === executionId && event.data?.from === "failed",
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
  const latestComplete = latestCompleteByStage(snapshots);
  for (const dep of stage.dependsOn) {
    if (latestComplete[dep] === undefined) {
      return `Stage ${stageId} depends on ${dep}, which has not completed.`;
    }
  }
  const incoming = incomingRouters(workflow, stageId);
  if (incoming.length === 0) return null;
  if (isWorkflowV2(workflow)) return version2RouteError(workflow, stageId, latestComplete);
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
  if (!routeListsStage(router.routes[decision], stageId)) {
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
export const VERIFY_FAILED = "verify_failed";

export function failedStageCount(snapshots: readonly ExecutionSnapshot[], stageId: string): number {
  return snapshots.filter(
    (snapshot) =>
      snapshot.stageId === stageId &&
      snapshot.status === "failed" &&
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
  if (latest !== null && latest.status === "failed" && latest.failureReason === VERIFY_EXHAUSTED) {
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
  if (latest !== null && latest.status === "failed" && latest.failureReason === VERIFY_FAILED) {
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
  const latest = latestStageSnapshot(snapshots, stageId);
  if (latest !== null && latest.status === "failed") return false;
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

function nextVersion2Stage(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  sessionStatus: string,
  latest: ExecutionSnapshot | null,
): NextStageResult {
  if (latest !== null && latest.status === "completed" && latest.outcomeStatus === "complete") {
    const stage = workflow.stages[latest.stageId];
    if (stage !== undefined && Object.keys(stage.routes).length > 0) {
      const decision = (latest.outcomeDecision ?? "").toLowerCase();
      const target = stage.routes[decision];
      if (target === undefined) {
        return new NextStageError(`stage ${stage.id} decision ${pyRepr(decision)} is not a valid route.`);
      }
      // A list starts each listed stage from the ready set. complete ends this branch only.
      if (typeof target === "string" && target !== "complete") {
        const error = stageDispatchError(workflow, target, snapshots);
        if (error !== null) {
          // A quiet graph with a missing output still reruns the producer.
          const producers = missingOutputProducers(workflow, snapshots, sessionStatus);
          if (producers.length > 0) return new NextStage(producers[0]!);
          return new NextStageError(error);
        }
        return new NextStage(target);
      }
    }
  }
  const selected = sequentialCandidates(workflow, snapshots, sessionStatus);
  if (selected.length > 0) return new NextStage(selected[0]!);
  const producers = missingOutputProducers(workflow, snapshots, sessionStatus);
  if (producers.length > 0) return new NextStage(producers[0]!);
  return new NextStageError("no eligible stage");
}

function version2RouteError(
  workflow: WorkflowDocument,
  stageId: string,
  latestComplete: Readonly<Record<string, ExecutionSnapshot>>,
): string | null {
  const since = latestComplete[stageId]?.executionOrder ?? -1;
  for (const router of incomingRouters(workflow, stageId)) {
    const snapshot = latestComplete[router.id];
    if (snapshot === undefined || snapshot.executionOrder <= since) continue;
    const decision = (snapshot.outcomeDecision ?? "").toLowerCase();
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
  stage: StageSpec,
  latest: ExecutionSnapshot,
): NextStageResult {
  const decision = (latest.outcomeDecision ?? "").toLowerCase();
  const target = stage.routes[decision];
  if (typeof target !== "string") {
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
  if (isWorkflowV2(workflow)) {
    const relevant = routersCompletedSince(workflow, complete, stageId, completeOrder);
    return relevant !== null && relevant.length > 0;
  }
  for (const router of incomingRouters(workflow, stageId)) {
    const snapshot = complete[router.id];
    if (snapshot === undefined || snapshot.executionOrder <= completeOrder) continue;
    const decision = (snapshot.outcomeDecision ?? "").toLowerCase();
    if (routeListsStage(router.routes[decision], stageId)) return true;
  }
  return false;
}

/** A router downstream of the stage is a route back, so its other decisions do not block it. */
function dependsOnStage(workflow: WorkflowDocument, router: StageSpec, stageId: string): boolean {
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
  const complete = latestCompleteByStage(snapshots);
  const since = complete[stageId]?.executionOrder ?? -1;
  return routersCompletedSince(workflow, complete, stageId, since);
}

function routersCompletedSince(
  workflow: WorkflowDocument,
  complete: Readonly<Record<string, ExecutionSnapshot>>,
  stageId: string,
  since: number,
): ExecutionSnapshot[] | null {
  const relevant: ExecutionSnapshot[] = [];
  for (const router of incomingRouters(workflow, stageId)) {
    const snapshot = complete[router.id];
    if (snapshot === undefined || snapshot.executionOrder <= since) continue;
    const decision = (snapshot.outcomeDecision ?? "").toLowerCase();
    if (!routeListsStage(router.routes[decision], stageId)) {
      if (dependsOnStage(workflow, router, stageId)) continue;
      return null;
    }
    relevant.push(snapshot);
  }
  relevant.sort((left, right) => left.executionOrder - right.executionOrder);
  return relevant;
}

function latestRouteTo(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  stageId: string,
): ExecutionSnapshot | null {
  if (isWorkflowV2(workflow)) {
    const relevant = relevantRouterSnapshots(workflow, snapshots, stageId);
    if (relevant === null || relevant.length === 0) return null;
    return relevant[relevant.length - 1]!;
  }
  let best: ExecutionSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.status !== "completed" || snapshot.outcomeStatus !== "complete") continue;
    const source = workflow.stages[snapshot.stageId];
    if (source === undefined) continue;
    const decision = (snapshot.outcomeDecision ?? "").toLowerCase();
    if (!routeListsStage(source.routes[decision], stageId)) continue;
    if (best === null || snapshot.executionOrder > best.executionOrder) best = snapshot;
  }
  return best;
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
    if (snapshot.status === "failed" || snapshot.status === "cancelled" || snapshot.status === "running") return true;
    if (snapshot.outcomeStatus === "blocked") return true;
  }
  return false;
}

function latestStageSnapshot(
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

function latestSnapshot(snapshots: readonly ExecutionSnapshot[]): ExecutionSnapshot | null {
  if (snapshots.length === 0) return null;
  return snapshots.reduce((best, snapshot) =>
    snapshot.executionOrder > best.executionOrder ? snapshot : best,
  );
}

function incomingRouters(workflow: WorkflowDocument, stageId: string): StageSpec[] {
  return Object.values(workflow.stages).filter((stage) =>
    Object.values(stage.routes).some((target) => routeListsStage(target, stageId)),
  );
}

export function runnableNow(
  workflow: WorkflowDocument,
  ready: readonly string[],
  running: readonly string[],
  concurrency: number,
  snapshots: readonly ExecutionSnapshot[] = [],
): string[] {
  if (concurrency < 1) return [];
  const ordered = declarationOrder(workflow, ready);
  const suspended = suspendedReady(workflow, ordered);
  const working = new Set(running);
  if (working.size >= concurrency) return [];
  const started: string[] = [];
  for (const stageId of ordered) {
    if (working.size >= concurrency) break;
    if (!workflow.stages[stageId] || working.has(stageId) || suspended.has(stageId)) continue;
    if (overlapsWorking(workflow, stageId, working)) continue;
    if (mustRunAlone(workflow, stageId, snapshots)) {
      // Borrowed agent. Skip it while anything else is in this turn; do not block the rest.
      if (working.size > 0) continue;
      started.push(stageId);
      break;
    }
    started.push(stageId);
    working.add(stageId);
  }
  return started;
}

/** Ready stages that are not on a branch already stopped by block, verify, or retries. */
export function readyOutsideStoppedBranches(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  sessionStatus: string,
  revisionBaselines?: Readonly<Record<string, number>> | null,
  resumes?: readonly BlockResume[] | null,
): string[] {
  const stopped = stoppedStageIds(workflow, snapshots, sessionStatus, resumes);
  return readyStages(workflow, snapshots, sessionStatus, revisionBaselines, resumes).filter(
    (stageId) => !onStoppedBranch(workflow, stageId, stopped),
  );
}

/** What the pool may start. Verify repair and missing outputs are included once per command. */
export function schedulableStageIds(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  sessionStatus: string,
  revisionBaselines: Readonly<Record<string, number>> | null | undefined,
  resumes: readonly BlockResume[] | null | undefined,
  verifyTried: ReadonlySet<string>,
  verifyOnlyTried: ReadonlySet<string> = new Set(),
): string[] {
  const stopped = stoppedStageIds(workflow, snapshots, sessionStatus, resumes);
  const ready = readyOutsideStoppedBranches(
    workflow,
    snapshots,
    sessionStatus,
    revisionBaselines,
    resumes,
  );
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
  sessionStatus: string,
  revisionBaselines?: Readonly<Record<string, number>> | null,
  resumes?: readonly BlockResume[] | null,
): string {
  if (version2GraphQuiet(workflow, snapshots, sessionStatus)) {
    if (missingWorkflowOutputNames(workflow, snapshots).length > 0) return "outputs_missing";
    return "completed";
  }
  for (const stageId of Object.keys(workflow.stages)) {
    const latest = latestStageSnapshot(snapshots, stageId);
    if (latest !== null && latest.outcomeStatus === "blocked" && !blockResumed(sessionStatus, latest.executionId, resumes)) {
      return "blocked";
    }
  }
  for (const stageId of Object.keys(workflow.stages)) {
    const latest = latestStageSnapshot(snapshots, stageId);
    if (latest !== null && latest.status === "failed" && latest.failureReason === VERIFY_FAILED) {
      return "verify_failed";
    }
  }
  for (const stageId of Object.keys(workflow.stages)) {
    const latest = latestStageSnapshot(snapshots, stageId);
    if (latest !== null && latest.status === "failed" && latest.failureReason === VERIFY_EXHAUSTED) {
      return "verify_exhausted";
    }
  }
  for (const stageId of Object.keys(workflow.stages)) {
    const latest = latestStageSnapshot(snapshots, stageId);
    if (
      latest?.status === "failed" &&
      latest.failureReason !== VERIFY_FAILED &&
      latest.failureReason !== VERIFY_EXHAUSTED &&
      !failedResumed(sessionStatus, latest.executionId, resumes)
    ) {
      return "stage_failed";
    }
  }
  for (const stageId of candidateStageIds(workflow, snapshots)) {
    if (revisionStop(workflow, snapshots, stageId, revisionBaselines)) return "revisions_exhausted";
  }
  return "no eligible stage";
}

function stoppedStageIds(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  sessionStatus: string,
  resumes: readonly BlockResume[] | null | undefined,
): Set<string> {
  const stopped = new Set<string>();
  for (const stageId of Object.keys(workflow.stages)) {
    const latest = latestStageSnapshot(snapshots, stageId);
    if (latest === null) continue;
    if (latest.outcomeStatus === "blocked" && !blockResumed(sessionStatus, latest.executionId, resumes)) {
      stopped.add(stageId);
    }
    if (latest.status === "failed" && latest.failureReason === VERIFY_EXHAUSTED) stopped.add(stageId);
    if (latest.status === "failed" && latest.failureReason === VERIFY_FAILED) stopped.add(stageId);
    if (
      latest.status === "failed" &&
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

function declarationOrder(workflow: WorkflowDocument, ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  const ordered: string[] = [];
  for (const stageId of Object.keys(workflow.stages)) {
    if (wanted.has(stageId)) ordered.push(stageId);
  }
  return ordered;
}

function suspendedReady(workflow: WorkflowDocument, ready: readonly string[]): Set<string> {
  const readySet = new Set(ready);
  const suspended = new Set<string>();
  for (const stageId of ready) {
    for (const other of dependencyClosure(workflow.stages, stageId)) {
      if (!readySet.has(other)) continue;
      suspended.add(stageId);
      break;
    }
  }
  return suspended;
}

function overlapsWorking(workflow: WorkflowDocument, stageId: string, working: ReadonlySet<string>): boolean {
  const closure = dependencyClosure(workflow.stages, stageId);
  for (const other of working) {
    if (other === stageId) continue;
    if (closure.has(other) || dependencyClosure(workflow.stages, other).has(stageId)) return true;
  }
  return false;
}

function mustRunAlone(
  workflow: WorkflowDocument,
  stageId: string,
  snapshots: readonly ExecutionSnapshot[],
): boolean {
  const stage = workflow.stages[stageId];
  if (!stage?.resumeFrom) return false;
  // Verify repair and a route back continue this stage's own agent.
  if (verifyExhaustedExecution(snapshots, stageId) !== null) return false;
  if (revisionResumeExecution(workflow, snapshots, stageId) !== null) return false;
  return true;
}
