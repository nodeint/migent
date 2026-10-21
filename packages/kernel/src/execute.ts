import { createHash } from "node:crypto";
import { AgentToolRunner, type RunResult } from "./agent-runner.js";
import { writeFileAtomic, writeJsonAtomic } from "./atomic-file.js";
import { CancellationRequested, cancellationSignal, raiseCancellation, resetCancellation } from "./command-executor.js";
import { loadRoleInstructions, loadYamlMapping, resolveStageTarget } from "./config.js";
import { ConfigurationError, OutputsMissing } from "./errors.js";
import {
  assertStageDispatchable,
  dispatchNamedStage,
  type StageDispatchRequest,
  type StageDispatchResult,
} from "./dispatch.js";
import { isRecord } from "./record.js";
import { buildStagePrompt, buildStageReplyPrompt, buildStageResumePrompt, buildVerifyRepairPrompt } from "./prompt.js";
import { log, utcNow } from "./runtime.js";
import { appendLifecycleEvent, readParsedEvents } from "./session-events.js";
import { commitFoldedStatus } from "./session-fold.js";
import {
  WORKFLOW_FREEZE_FILE,
  frozenRoleInstructions,
  frozenStageTarget,
  loadFrozenWorkflow,
  readWorkflowFreeze,
  requireLiveWorkflow,
  warnIfFrozenDrift,
  writeWorkflowFreeze,
} from "./session-freeze.js";
import {
  VERIFY_EXHAUSTED,
  failedStageCount,
  nextStage,
  readyStages,
  revisionStop,
  runnableNow,
  schedulableStageIds,
  stagePromptAlreadyDelivered,
  verifyExhaustedExecution,
  version2IdleReason,
  NextStage,
  NextStageError,
  Stop,
} from "./selection.js";
import { repairSessionUnlocked } from "./session-repair.js";
import { activatePreparedSession, bindPriorSessionId, createWorkflowSession, resolvePriorSessionId } from "./session-records.js";
import { freezeSessionTask } from "./task-file.js";
import { isSessionLockLost, SessionLock, SessionLockHeldError } from "./session-lock.js";
import {
  clearInFlightExecution,
  clearInFlightExecutions,
  noteInFlightExecution,
  SessionStore,
} from "./session-store.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isWorkflowV2, loadNamedWorkflow, type WorkflowDocument } from "./workflow.js";
import type { ExecutionSnapshot } from "./outputs.js";

export const DEFAULT_MAX_DISPATCHES = 20;

const EXECUTE_EXIT_CODES: Record<string, number> = {
  completed: 0,
  blocked: 1,
  cancelled: 130,
  retry_exhausted: 3,
  revisions_exhausted: 4,
  dispatch_limit: 5,
  verify_exhausted: 6,
  stage: 0,
};

const TERMINAL_SESSION_STATUSES = new Set(["completed", "blocked", "cancelled"]);

export interface ExecuteRequest {
  workflowId?: string | null;
  task?: string | null;
  sessionId?: string | null;
  stageId?: string | null;
  priorSessionId?: string | null;
  maxAttempts?: number | null;
  maxDispatches?: number | null;
  once?: boolean;
  resetRevisions?: boolean;
  startPrepared?: boolean;
  refreshWorkflow?: boolean;
  /** Reply for one blocked stage. The new execution's prompt body is this text. */
  reply?: string | null;
}

interface PendingStageReply {
  stageId: string;
  text: string | null;
}

export interface ExecuteResult {
  code: number;
  status: string;
  stopReason: string;
  sessionId: string;
  latestDecision: string | null;
  latestExecutionId: string | null;
  outputs: Record<string, unknown>;
  stages: Array<Record<string, unknown>>;
}

export async function executeNamedWorkflow(
  workspace: string,
  request: ExecuteRequest,
  runner?: AgentToolRunner,
): Promise<ExecuteResult> {
  const held: { lock: SessionLock | null; sessionId: string | null } = { lock: null, sessionId: null };
  try {
    return await executeLocked(workspace, request, held, runner);
  } catch (error) {
    if (!(error instanceof SessionLockHeldError) && !isSessionLockLost(error)) throw error;
    // Same shape as any other plain Error in the run: stderr message, exit 2.
    process.stderr.write(`migent: ${error.message}\n`);
    return {
      code: 2,
      status: "",
      stopReason: "configuration",
      sessionId: request.sessionId ?? "",
      latestDecision: null,
      latestExecutionId: null,
      outputs: {},
      stages: [],
    };
  } finally {
    if (held.sessionId) clearInFlightExecutions(held.sessionId);
    held.lock?.release();
    resetCancellation();
  }
}

async function executeLocked(
  workspace: string,
  request: ExecuteRequest,
  held: { lock: SessionLock | null; sessionId: string | null },
  runner?: AgentToolRunner,
): Promise<ExecuteResult> {
  const stageId = request.stageId ?? null;
  const once = request.once ?? false;
  const maxAttempts = request.maxAttempts === undefined ? 3 : request.maxAttempts;
  const maxDispatches =
    request.maxDispatches === undefined ? DEFAULT_MAX_DISPATCHES : request.maxDispatches;
  if (!once && (maxAttempts === null || maxAttempts < 1)) {
    throw new ConfigurationError("--attempts must be at least 1.");
  }
  if (!once && maxDispatches !== null && maxDispatches < 1) {
    throw new ConfigurationError("--max-dispatches must be at least 1.");
  }
  const store = new SessionStore(workspace);
  let sessionId = request.sessionId ?? null;
  let workflow: WorkflowDocument | null = null;
  let workflowId: string;
  let resumeCancelled = false;
  let reopenLatestCancelled = false;
  let stageReply: PendingStageReply | null = null;
  const replyText = typeof request.reply === "string" ? request.reply : null;
  if (sessionId) {
    held.sessionId = sessionId;
    held.lock = SessionLock.acquire(path.join(workspace, ".migent", "sessions", sessionId));
    repairSessionUnlocked(workspace, sessionId);
    if (request.refreshWorkflow) refreshSessionWorkflow(workspace, sessionId, request.startPrepared === true);
    const bound = bindExecuteRun(workspace, sessionId, request.workflowId, request.priorSessionId);
    workflowId = bound.workflowId;
    if (!request.refreshWorkflow) {
      const workflowPath = typeof bound.status.workflow_path === "string" ? bound.status.workflow_path : null;
      const storedWorkflow = typeof bound.status.workflow_id === "string" ? bound.status.workflow_id : null;
      warnIfFrozenDrift(workspace, sessionId, workflowPath, storedWorkflow);
    }
    let sessionStatus = typeof bound.status.status === "string" ? bound.status.status : "";
    if (replyText !== null && replyText.trim() === "") {
      throw new ConfigurationError("--reply is empty.");
    }
    if (replyText !== null && sessionStatus !== "blocked") {
      throw new ConfigurationError(
        `--reply requires a blocked session. Session ${sessionId} is ${sessionStatus || "unknown"}.`,
      );
    }
    if (request.startPrepared) {
      if (sessionStatus !== "prepared") {
        const hint =
          sessionStatus === "active"
            ? `Session ${sessionId} is active. Resume with: migent session continue ${sessionId}`
            : `Session ${sessionId} is ${sessionStatus || "unknown"}. migent session run --session --workflow only starts a prepared session.`;
        throw new ConfigurationError(hint);
      }
      activatePreparedSession(workspace, sessionId);
      sessionStatus = "active";
    } else if (sessionStatus === "prepared") {
      throw new ConfigurationError(
        `Session ${sessionId} is prepared. Run: ${preparedRunHint(sessionId, bound.status)}`,
      );
    }
    if (sessionStatus === "blocked") {
      const blocked = store.blockedStages(sessionId);
      if (replyText !== null) {
        if (blocked.length > 1 && stageId === null) {
          const names = blocked.map((item) => item.stageId).join(", ");
          throw new ConfigurationError(`--reply needs --stage when more than one stage is blocked: ${names}.`);
        }
        const target = stageId ?? blocked[0]?.stageId ?? "";
        if (!blocked.some((item) => item.stageId === target)) {
          throw new ConfigurationError(
            blocked.length === 0
              ? `Session ${sessionId} is blocked without an execution.`
              : `Stage ${target} is not blocked. Blocked stages: ${blocked.map((item) => item.stageId).join(", ")}.`,
          );
        }
        stageReply = { stageId: target, text: replyText };
      }
      const resumed = store.resumeBlockedSession(
        sessionId,
        stageReply !== null && blocked.length > 1 ? stageReply.stageId : null,
      );
      sessionStatus = "active";
      for (const item of resumed) {
        const stageLabel = item.stageId || "its stage";
        const withReply = stageReply?.stageId === item.stageId ? " with a reply" : "";
        log(`session ${sessionId} was blocked by ${item.executionId}. Resuming ${stageLabel}${withReply}.`);
      }
      // Decision 8 hides a cancelled sibling. Reopen that stage in place before new work.
      resumeCancelled = true;
      reopenLatestCancelled = true;
    }
    if (sessionStatus === "cancelled") {
      resumeCancelled = true;
    } else if (!reopenLatestCancelled && TERMINAL_SESSION_STATUSES.has(sessionStatus)) {
      return executeFinal(bound.status, sessionStatus, []);
    }
  } else {
    if (replyText !== null) throw new ConfigurationError("--reply requires a blocked session.");
    if (request.refreshWorkflow) {
      throw new ConfigurationError("--refresh-workflow requires an existing session.");
    }
    if (!request.workflowId) throw new ConfigurationError("Creating a session requires a workflow.");
    if (!request.task) throw new ConfigurationError("Creating a session requires --task.");
    workflow = loadNamedWorkflow(workspace, request.workflowId);
    workflowId = workflow.id;
    resolvePriorSessionId(workspace, workflow, request.priorSessionId);
    if (stageId !== null) requireEligibleStage(workflow, [], "active", stageId);
    sessionId = createWorkflowSession(workspace, workflowId, request.task, request.priorSessionId);
    held.sessionId = sessionId;
    held.lock = SessionLock.acquire(path.join(workspace, ".migent", "sessions", sessionId));
    log(`session_id: ${sessionId}`);
  }
  const frozenDocument = loadFrozenWorkflow(path.join(workspace, ".migent", "sessions", sessionId));
  if (frozenDocument) workflow = frozenDocument;
  else if (workflow === null) workflow = loadNamedWorkflow(workspace, workflowId);
  if (request.resetRevisions) {
    store.reapOrphanedExecutions(sessionId, "raise");
    const snapshots = store.executionSnapshots(sessionId);
    const status = store.readSessionStatus(sessionId);
    const current = text(status.status);
    if (current === "cancelled") {
      store.resetRevisionCounts(sessionId, snapshots);
    } else if (isWorkflowV2(workflow)) {
      // The reset is what lifts the cap, so the cap must not hide the stage continue is about to allow.
      const openBaselines: Record<string, number> = {};
      for (const stageId of Object.keys(workflow.stages)) openBaselines[stageId] = Number.MAX_SAFE_INTEGER;
      const startable = schedulableStageIds(
        workflow,
        snapshots,
        current,
        openBaselines,
        maxAttempts ?? 0,
        blockResumes(workspace, sessionId),
        new Set(),
      );
      if (startable.length > 0) store.resetRevisionCounts(sessionId, snapshots);
    } else {
      const selected = selectedStage(workflow, snapshots, current);
      if (selected instanceof NextStage) store.resetRevisionCounts(sessionId, snapshots);
    }
  }
  const onSigint = () => {
    try {
      raiseCancellation(2);
    } catch {
      // The flag stays set; the command loop observes it.
    }
  };
  const onSigterm = () => {
    try {
      raiseCancellation(15);
    } catch {
      // The flag stays set; the command loop observes it.
    }
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  const tasks = new Map<string, Promise<unknown>>();
  try {
    const activeRunner = runner ?? new AgentToolRunner();
    const stageJsons: Array<Record<string, unknown>> = [];
    if (stageReply !== null) {
      // Send the reply before a cancelled sibling can end the command or fold the session blocked.
      const replySnapshots = store.executionSnapshots(sessionId);
      const replyStatus = store.readSessionStatus(sessionId);
      assertStageDispatchable(workspace, workflow, sessionId, stageReply.stageId);
      stageJsons.push(
        await trackDispatch(sessionId, tasks, (note) =>
          dispatchExecuteStage(
            workspace,
            workflow,
            workflowId,
            sessionId,
            stageReply.stageId,
            replyStatus,
            replySnapshots,
            activeRunner,
            note,
            stageReply,
          ),
        ),
      );
    }
    if (resumeCancelled) {
      const reopened = store.reopenCancelledExecutions(sessionId, reopenLatestCancelled);
      if (!reopenLatestCancelled || reopened.length > 0) {
        for (const item of reopened) {
          log(`session ${sessionId} was cancelled during ${item.executionId}. Resuming that execution.`);
        }
        const settled = await Promise.allSettled(
          reopened.map((item) =>
            startTracked(sessionId, item.executionId, tasks, () =>
              activeRunner.continueCancelled(workspace, sessionId, item.executionId),
            ),
          ),
        );
        const rejected = settled.find((item) => item.status === "rejected");
        if (rejected && rejected.status === "rejected") throw rejected.reason;
        const continued = settled.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []));
        for (let index = 0; index < reopened.length; index += 1) {
          const item = reopened[index]!;
          const result = continued[index]!;
          const outcome = result.outcome_status || (result.failure_reason ? "failed" : "finished");
          const decision = result.outcome_decision ? ` decision=${result.outcome_decision}` : "";
          log(`stage ${item.stageId || "stage"} · ${outcome}${decision}.`);
          stageJsons.push(runResultJson(result));
        }
        const status = store.readSessionStatus(sessionId);
        const after = text(status.status);
        if (continued.some((item) => item.failure_reason === VERIFY_EXHAUSTED)) {
          return executeFinal(status, VERIFY_EXHAUSTED, stageJsons);
        }
        // A cancelled session stops here for one stage. A blocked sibling still needs dispatch.
        if (!reopenLatestCancelled && (once || stageId !== null || TERMINAL_SESSION_STATUSES.has(after))) {
          const stopReason = TERMINAL_SESSION_STATUSES.has(after) ? after : "stage";
          const result = executeFinal(status, stopReason, stageJsons);
          if (stopReason === "stage" && continued.some((item) => item.outcome_status !== "complete")) result.code = 1;
          return result;
        }
        if (!reopenLatestCancelled) {
          const rest = await runExecuteLoop(
            workspace,
            store,
            workflow,
            workflowId,
            sessionId,
            maxAttempts,
            maxDispatches,
            activeRunner,
            tasks,
            stageReply,
            stageReply !== null && stageReply.text === null ? 1 : 0,
            stageJsons[0]?.failure_reason === VERIFY_EXHAUSTED && stageReply !== null ? [stageReply.stageId] : [],
          );
          rest.stages = [...stageJsons, ...rest.stages];
          return rest;
        }
      }
    }
    const replySent = stageReply !== null && stageReply.text === null;
    const replyResult = replySent ? stageJsons[0] : undefined;
    const replyExhausted = replyResult?.failure_reason === VERIFY_EXHAUSTED;
    if (replyExhausted && (!isWorkflowV2(workflow) || once || stageId !== null)) {
      return executeFinal(store.readSessionStatus(sessionId), VERIFY_EXHAUSTED, stageJsons);
    }
    if (replySent && (once || stageId !== null)) {
      const status = store.readSessionStatus(sessionId);
      const after = text(status.status);
      const stopReason = TERMINAL_SESSION_STATUSES.has(after) ? after : "stage";
      const result = executeFinal(status, stopReason, stageJsons);
      if (stopReason === "stage" && stageJsons.some((item) => item.outcome_status !== "complete")) result.code = 1;
      return result;
    }
    const replyDispatches = replySent ? 1 : 0;
    const replyVerifyTried = replyExhausted && stageReply !== null ? [stageReply.stageId] : [];
    const continued = once || stageId !== null
      ? await runExecuteOnce(
          workspace,
          store,
          workflow,
          workflowId,
          sessionId,
          stageId,
          activeRunner,
          tasks,
          stageReply,
        )
      : await runExecuteLoop(
          workspace,
          store,
          workflow,
          workflowId,
          sessionId,
          maxAttempts,
          maxDispatches,
          activeRunner,
          tasks,
          stageReply,
          replyDispatches,
          replyVerifyTried,
        );
    if (stageJsons.length > 0) continued.stages = [...stageJsons, ...continued.stages];
    return continued;
  } catch (error) {
    if (error instanceof CancellationRequested) {
      await Promise.allSettled([...tasks.values()]);
      log(error.message);
      return executeFinal(store.readSessionStatus(sessionId), "cancelled", []);
    }
    if (error instanceof OutputsMissing) {
      process.stderr.write(`migent: ${error.message}\n`);
      return executeFinal(store.readSessionStatus(sessionId), "outputs_missing", []);
    }
    // ConfigurationError stays an exception. Callers map it to exit 2, matching Python.
    if (error instanceof ConfigurationError) throw error;
    if (error instanceof Error && !hasErrorCode(error)) {
      process.stderr.write(`migent: ${error.message}\n`);
      return {
        code: 2,
        status: "",
        stopReason: "configuration",
        sessionId,
        latestDecision: null,
        latestExecutionId: null,
        outputs: {},
        stages: [],
      };
    }
    throw error;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

function requireEligibleStage(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  sessionStatus: string,
  stageId: string,
): string {
  if (isWorkflowV2(workflow)) {
    const ready = readyStages(workflow, snapshots, sessionStatus);
    if (ready.includes(stageId)) return stageId;
    const first = runnableNow(workflow, ready, [], workflow.concurrency ?? 1, snapshots)[0] ?? ready[0] ?? "";
    throw new ConfigurationError(`Stage ${stageId} is not the eligible stage ${first}.`);
  }
  const selected = selectedStage(workflow, snapshots, sessionStatus);
  if (selected instanceof Stop) throw new ConfigurationError(`Session is ${selected.reason}.`);
  if (selected.stageId !== stageId) {
    throw new ConfigurationError(`Stage ${stageId} is not the eligible stage ${selected.stageId}.`);
  }
  return selected.stageId;
}

function selectedStage(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  sessionStatus: string,
): NextStage | Stop {
  const selected = nextStage(workflow, snapshots, sessionStatus);
  if (selected instanceof NextStageError) throw new ConfigurationError(selected.message);
  if (selected instanceof NextStage || selected instanceof Stop) return selected;
  throw new ConfigurationError("no eligible stage");
}

async function runExecuteOnce(
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
  store.reapOrphanedExecutions(sessionId, "raise");
  const snapshots = store.executionSnapshots(sessionId);
  let status = store.readSessionStatus(sessionId);
  const sessionStatus = text(status.status);
  if (TERMINAL_SESSION_STATUSES.has(sessionStatus)) return executeFinal(status, sessionStatus, []);
  const chosen = isWorkflowV2(workflow)
    ? version2OnceStage(workspace, workflow, sessionId, snapshots, status, stageId)
    : version1OnceStage(workflow, snapshots, status, stageId);
  if (typeof chosen !== "string") return chosen;
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
  if (stage.failure_reason === VERIFY_EXHAUSTED) return executeFinal(status, VERIFY_EXHAUSTED, [stage]);
  const stopReason = TERMINAL_SESSION_STATUSES.has(after) ? after : "stage";
  const result = executeFinal(status, stopReason, [stage]);
  if (stopReason === "stage" && stage.outcome_status !== "complete") result.code = 1;
  return result;
}

function version1OnceStage(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  status: Record<string, unknown>,
  stageId: string | null,
): string | ExecuteResult {
  const selected = selectedStage(workflow, snapshots, text(status.status));
  if (selected instanceof Stop) return executeFinal(status, selected.reason, []);
  if (stageId !== null && selected.stageId !== stageId) {
    throw new ConfigurationError(`Stage ${stageId} is not the eligible stage ${selected.stageId}.`);
  }
  if (revisionStop(workflow, snapshots, selected.stageId, revisionBaselines(status))) {
    return executeFinal(status, "revisions_exhausted", []);
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
  const ready = readyStages(workflow, snapshots, sessionStatus, baselines, 3, resumes);
  const schedulable = schedulableStageIds(workflow, snapshots, sessionStatus, baselines, 3, resumes, new Set());
  const running = runningStageIds(snapshots);
  if (stageId !== null) {
    if (!ready.includes(stageId)) {
      const first = runnableNow(workflow, schedulable, running, workflow.concurrency ?? 1, snapshots)[0] ?? ready[0] ?? "";
      throw new ConfigurationError(`Stage ${stageId} is not the eligible stage ${first}.`);
    }
    if (revisionStop(workflow, snapshots, stageId, baselines)) {
      return executeFinal(status, "revisions_exhausted", []);
    }
    return stageId;
  }
  const next = runnableNow(workflow, schedulable, running, workflow.concurrency ?? 1, snapshots)[0];
  if (next === undefined) {
    const reason = version2IdleReason(workflow, snapshots, sessionStatus, baselines, 3, resumes);
    if (reason === "no eligible stage") throw new ConfigurationError("no eligible stage");
    return executeFinal(status, reason, []);
  }
  if (revisionStop(workflow, snapshots, next, baselines)) {
    return executeFinal(status, "revisions_exhausted", []);
  }
  return next;
}

async function runExecuteLoop(
  workspace: string,
  store: SessionStore,
  workflow: WorkflowDocument,
  workflowId: string,
  sessionId: string,
  maxAttempts: number | null,
  maxDispatches: number | null,
  runner: AgentToolRunner,
  tasks: Map<string, Promise<unknown>>,
  reply: PendingStageReply | null,
  alreadyDispatched = 0,
  verifyTriedSeed: readonly string[] = [],
): Promise<ExecuteResult> {
  if (isWorkflowV2(workflow)) {
    return runVersion2Pool(
      workspace,
      store,
      workflow,
      workflowId,
      sessionId,
      maxAttempts,
      maxDispatches,
      runner,
      tasks,
      reply,
      alreadyDispatched,
      verifyTriedSeed,
    );
  }
  const stages: Array<Record<string, unknown>> = [];
  let dispatched = alreadyDispatched;
  const attempts = maxAttempts ?? 0;
  while (true) {
    store.reapOrphanedExecutions(sessionId, "raise");
    const snapshots = store.executionSnapshots(sessionId);
    const status = store.readSessionStatus(sessionId);
    const selected = selectedStage(workflow, snapshots, text(status.status));
    if (selected instanceof Stop) return executeFinal(status, selected.reason, stages);
    if (failedStageCount(snapshots, selected.stageId) >= attempts) {
      return executeFinal(status, "retry_exhausted", stages);
    }
    if (revisionStop(workflow, snapshots, selected.stageId, revisionBaselines(status))) {
      return executeFinal(status, "revisions_exhausted", stages);
    }
    if (maxDispatches !== null && dispatched >= maxDispatches) {
      return executeFinal(status, "dispatch_limit", stages);
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
    stages.push(dispatchedStage);
    if (dispatchedStage.failure_reason === VERIFY_EXHAUSTED) {
      return executeFinal(store.readSessionStatus(sessionId), VERIFY_EXHAUSTED, stages);
    }
  }
}

async function runVersion2Pool(
  workspace: string,
  store: SessionStore,
  workflow: WorkflowDocument,
  workflowId: string,
  sessionId: string,
  maxAttempts: number | null,
  maxDispatches: number | null,
  runner: AgentToolRunner,
  tasks: Map<string, Promise<unknown>>,
  reply: PendingStageReply | null,
  alreadyDispatched = 0,
  verifyTriedSeed: readonly string[] = [],
): Promise<ExecuteResult> {
  const stages: Array<Record<string, unknown>> = [];
  let dispatched = alreadyDispatched;
  const attempts = maxAttempts ?? 0;
  const verifyTried = new Set<string>(verifyTriedSeed);
  const flights: Array<{ promise: Promise<void>; settled: boolean }> = [];
  const errors: unknown[] = [];
  const concurrency = workflow.concurrency ?? 1;
  const observe = async (): Promise<void> => {
    const error = errors[0];
    if (error !== undefined) {
      await Promise.allSettled(flights.map((flight) => flight.promise));
      throw error;
    }
    for (let index = flights.length - 1; index >= 0; index -= 1) {
      if (flights[index]!.settled) flights.splice(index, 1);
    }
  };
  while (true) {
    cancellationSignal().throwIfCancelled();
    await observe();
    store.reapOrphanedExecutions(sessionId, "raise");
    const snapshots = store.executionSnapshots(sessionId);
    const status = store.readSessionStatus(sessionId);
    const sessionStatus = text(status.status);
    if (sessionStatus === "cancelled") {
      await Promise.allSettled(flights.map((flight) => flight.promise));
      return executeFinal(status, "cancelled", []);
    }
    const baselines = revisionBaselines(status);
    const resumes = blockResumes(workspace, sessionId);
    const schedulable = schedulableStageIds(
      workflow,
      snapshots,
      sessionStatus,
      baselines,
      attempts,
      resumes,
      verifyTried,
    );
    const running = runningStageIds(snapshots);
    const ceiling = maxDispatches === null ? Number.POSITIVE_INFINITY : maxDispatches;
    const room = ceiling - dispatched;
    if (room > 0) {
      // room limits new starts. The working set already contains whatever is running.
      const cap = Math.min(concurrency, running.length + room);
      const starting = runnableNow(workflow, schedulable, running, cap, snapshots);
      if (sessionStatus === "blocked" && starting.length > 0) {
        // The fold will not stay active for a failed latest, so a spent --attempts still ends blocked.
        // loadOrCreate refuses a blocked session, and this sibling is still under the command's cap.
        status.status = "active";
        delete status.blocked_by_execution_id;
        delete status.blocked_by_execution_ids;
        delete status.blocked_by_stage_id;
        delete status.blocker;
        delete status.terminal_execution_id;
        writeJsonAtomic(path.join(workspace, ".migent", "sessions", sessionId, "status.json"), status);
      }
      for (const stageId of starting) {
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
          })
          .catch((error: unknown) => {
            errors.push(error);
          })
          .finally(() => {
            flight.settled = true;
          });
        flights.push(flight);
        dispatched += 1;
      }
    }
    if (dispatched >= ceiling) {
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
        attempts,
        endResumes,
        verifyTried,
      );
      if (remaining.length > 0) return executeFinal(endStatus, "dispatch_limit", stages);
      const reason = version2IdleReason(workflow, endSnapshots, endSession, endBaselines, attempts, endResumes);
      if (reason === "no eligible stage") return executeFinal(endStatus, "dispatch_limit", stages);
      return executeFinal(endStatus, reason, stages);
    }
    if (flights.length === 0) {
      const reason = version2IdleReason(workflow, snapshots, sessionStatus, baselines, attempts, resumes);
      if (reason === "no eligible stage") throw new ConfigurationError("no eligible stage");
      return executeFinal(status, reason, stages);
    }
    await Promise.race(flights.map((flight) => flight.promise));
  }
}

function runningStageIds(snapshots: readonly ExecutionSnapshot[]): string[] {
  const ids: string[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.status === "running" && !ids.includes(snapshot.stageId)) ids.push(snapshot.stageId);
  }
  return ids;
}

function blockResumes(workspace: string, sessionId: string) {
  return readParsedEvents(path.join(workspace, ".migent", "sessions", sessionId, "events.jsonl")).map((event) => ({
    event: event.event,
    executionId: event.executionId,
    data: event.data,
  }));
}

async function dispatchExecuteStage(
  workspace: string,
  workflow: WorkflowDocument,
  workflowId: string,
  sessionId: string,
  stageId: string,
  status: Record<string, unknown>,
  snapshots: readonly ExecutionSnapshot[],
  runner: AgentToolRunner,
  onExecution?: (executionId: string) => void,
  reply: PendingStageReply | null = null,
): Promise<Record<string, unknown>> {
  const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
  const freeze = readWorkflowFreeze(sessionDirectory);
  const target = freeze ? frozenStageTarget(freeze, stageId) : resolveStageTarget(workspace, workflowId, stageId);
  const optionLabel =
    Object.entries(target.options)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ") || "default";
  log(`stage ${stageId} · ${target.provider}/${target.model} (${optionLabel}).`);
  const priorSessionId = storedPriorSessionId(status);
  const frozen = freezeSessionTask(workspace, sessionId);
  const exhausted = verifyExhaustedExecution(snapshots, stageId);
  const stageSpec = workflow.stages[stageId];
  if (stageSpec === undefined) throw new ConfigurationError(`Stage not found: ${stageId}`);
  const roleInstructions = freeze
    ? frozenRoleInstructions(freeze, stageSpec.role)
    : loadRoleInstructions(loadYamlMapping(path.join(workspace, ".migent", "config.yaml")), stageSpec.role);
  const promptInput = {
    workflow,
    stageId,
    taskFile: frozen.taskFile,
    sessionDirectory: frozen.sessionDirectory,
    snapshots,
    workspace,
    priorSessionId,
    priorOutputs: priorSessionOutputs(workspace, priorSessionId),
    roleInstructions,
  };
  const stageReply = takeStageReply(reply, stageId);
  const prompt =
    stageReply !== null
      ? buildStageReplyPrompt(stageReply)
      : exhausted?.verifyReport
        ? buildVerifyRepairPrompt(
            readFileSync(exhausted.verifyReport, "utf8"),
            stageSpec.maxVerify,
            stageSpec.maxVerify,
            null,
            frozen.taskFile,
            frozen.sessionDirectory,
          )
        : stagePromptAlreadyDelivered(workflow, snapshots, stageId)
          ? buildStageResumePrompt(promptInput)
          : buildStagePrompt(promptInput);
  const request: StageDispatchRequest = {
    workflowId,
    stageId,
    prompt,
    sessionId,
  };
  const result: StageDispatchResult = await dispatchNamedStage(
    workspace,
    request,
    runner,
    { workflow, target },
    onExecution,
  );
  const outcome = result.outcomeStatus || (result.failureReason ? "failed" : "finished");
  const decision = result.outcomeDecision ? ` decision=${result.outcomeDecision}` : "";
  log(`stage ${stageId} · ${outcome}${decision}.`);
  return result.toJson();
}

function takeStageReply(reply: PendingStageReply | null, stageId: string): string | null {
  if (reply === null || reply.stageId !== stageId || reply.text === null) return null;
  const text = reply.text;
  reply.text = null;
  return text;
}

function bindExecuteRun(
  workspace: string,
  sessionId: string,
  workflowId: string | null | undefined,
  priorSessionId: string | null | undefined,
): { workflowId: string; status: Record<string, unknown> } {
  const status = new SessionStore(workspace).readSessionStatus(sessionId);
  const storedWorkflow = status.workflow_id;
  if (Object.keys(status).length === 0 || typeof storedWorkflow !== "string" || storedWorkflow === "") {
    throw new ConfigurationError(`Session not found: ${sessionId}.`);
  }
  if (storedWorkflow === "agent") {
    throw new ConfigurationError(`Session ${sessionId} is not a named workflow session.`);
  }
  if (workflowId && workflowId !== storedWorkflow) {
    const resolved = loadNamedWorkflow(workspace, workflowId).id;
    if (resolved !== storedWorkflow) {
      throw new ConfigurationError(`Workflow ${resolved} does not match session ${storedWorkflow}.`);
    }
  }
  bindPriorSessionId(workspace, sessionId, priorSessionId);
  return { workflowId: storedWorkflow, status };
}

function refreshSessionWorkflow(workspace: string, sessionId: string, startPrepared: boolean): void {
  const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
  const freeze = readWorkflowFreeze(sessionDirectory);
  if (freeze === null) throw new ConfigurationError(`Session ${sessionId} has no frozen workflow.`);
  const status = new SessionStore(workspace).readSessionStatus(sessionId);
  const sessionStatus = typeof status.status === "string" ? status.status : "";
  if (sessionStatus === "completed" || sessionStatus === "cancelled") {
    throw new ConfigurationError(`Session ${sessionId} is ${sessionStatus}.`);
  }
  if (!startPrepared && sessionStatus === "prepared") {
    throw new ConfigurationError(`Session ${sessionId} is prepared. Run: ${preparedRunHint(sessionId, status)}`);
  }
  if (startPrepared && sessionStatus !== "prepared") {
    const hint =
      sessionStatus === "active"
        ? `Session ${sessionId} is active. Resume with: migent session continue ${sessionId}`
        : `Session ${sessionId} is ${sessionStatus || "unknown"}. migent session run --session --workflow only starts a prepared session.`;
    throw new ConfigurationError(hint);
  }
  const workflowPath = typeof status.workflow_path === "string" ? status.workflow_path : null;
  const workflowId = typeof status.workflow_id === "string" ? status.workflow_id : null;
  const live = requireLiveWorkflow(workspace, workflowPath, workflowId);
  const freezePath = path.join(sessionDirectory, WORKFLOW_FREEZE_FILE);
  const previousText = readFileSync(freezePath, "utf8");
  const previousHash = createHash("sha256").update(previousText).digest("hex");
  const written = writeWorkflowFreeze(sessionDirectory, workspace, live);
  try {
    appendLifecycleEvent(sessionDirectory, {
      event: "workflow.refreshed",
      timestamp: utcNow(),
      data: {
        hash: written.hash,
        previous_hash: previousHash,
        source_sha256: written.sourceSha256,
      },
    });
    commitFoldedStatus(workspace, sessionDirectory);
  } catch (error) {
    writeFileAtomic(freezePath, previousText);
    throw error;
  }
}

function preparedRunHint(sessionId: string, status: Record<string, unknown>): string {
  const workflowId = typeof status.workflow_id === "string" && status.workflow_id ? status.workflow_id : "<workflow>";
  return `migent session run --session ${sessionId} --workflow ${workflowId}`;
}

function storedPriorSessionId(status: Record<string, unknown>): string | null {
  const prior = status.prior_session_id;
  return typeof prior === "string" && prior ? prior : null;
}

function priorSessionOutputs(
  workspace: string,
  priorSessionId: string | null,
): Record<string, unknown> | null {
  if (!priorSessionId) return null;
  const outputs = new SessionStore(workspace).readSessionStatus(priorSessionId).outputs;
  return isRecord(outputs) ? outputs : {};
}

function revisionBaselines(status: Record<string, unknown>): Record<string, number> | null {
  const raw = status.revision_baselines;
  if (!isRecord(raw)) return null;
  const baselines: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number") baselines[key] = value;
  }
  return baselines;
}

function runResultJson(result: RunResult): Record<string, unknown> {
  return {
    agent_id: result.agent_id,
    options: { ...result.options },
    session_id: result.session_id,
    execution_id: result.execution_id,
    artifact_directory: result.artifact_directory,
    failure_reason: result.failure_reason,
    outcome_status: result.outcome_status,
    outcome_decision: result.outcome_decision,
    session_status: result.session_status,
    response: result.response,
  };
}

function executeFinal(
  status: Record<string, unknown>,
  stopReason: string,
  stages: Array<Record<string, unknown>>,
): ExecuteResult {
  return {
    code: EXECUTE_EXIT_CODES[stopReason] ?? 2,
    status: text(status.status),
    stopReason,
    sessionId: text(status.session_id),
    latestDecision: optionalText(status.latest_decision),
    latestExecutionId: optionalText(status.latest_execution_id),
    outputs: isRecord(status.outputs) ? status.outputs : {},
    stages,
  };
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function trackDispatch(
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

function startTracked<T>(
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

function hasErrorCode(error: Error): boolean {
  return "code" in error && typeof (error as { code?: unknown }).code === "string";
}
