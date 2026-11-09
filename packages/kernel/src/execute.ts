import type { TurnKind } from "@nodeint/migent-prompts";
import type { ClientRegistry } from "./cli-client.js";
import { createHash } from "node:crypto";
import { AgentToolRunner, type RunResult } from "./agent-runner.js";
import { writeFileAtomic, writeJsonAtomic } from "./atomic-file.js";
import {
  CancellationRequested,
  cancellationSignal,
  raiseCancellation,
  resetCancellation,
} from "./command-executor.js";
import { loadRoleResponsibilities, loadWorkspaceConfig, resolveStageTarget } from "./config.js";
import { ConfigurationError, OutputsMissing } from "./errors.js";
import {
  assertStageDispatchable,
  dispatchNamedStage,
  type StageDispatchRequest,
  type StageDispatchResult,
} from "./dispatch.js";
import { isRecord } from "@nodeint/migent-workflow";
import { buildStagePrompt, buildStageReplyPrompt, buildStageResumePrompt, buildVerifyRepairPrompt } from "./prompt.js";
import { ProviderEventReporter } from "./provider-events.js";
import { formatClock, formatDuration, log, utcNow } from "./runtime.js";
import { appendLifecycleEvent, parseExecutionId, readParsedEvents } from "./session-events.js";
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
  VERIFY_FAILED,
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
import { assertSingleLineTask, freezeSessionTask, requireTaskBody } from "./task-file.js";
import { isSessionLockLost, SessionLock, SessionLockHeldError } from "./session-lock.js";
import {
  clearInFlightExecution,
  clearInFlightExecutions,
  noteInFlightExecution,
  SessionStore,
} from "./session-store.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { evaluateRunWhen, ensureSessionBaseline } from "./run-when.js";
import { isRoleStage, isWorkflowV2, loadNamedWorkflow, type StageSpec, type WorkflowDocument } from "@nodeint/migent-workflow";
import { runVerifyOnlyStage } from "./verify-only.js";
import type { ExecutionSnapshot } from "./outputs.js";

export const DEFAULT_MAX_DISPATCHES = 20;

export const EXECUTE_EXIT_CODES:Record<string, number> = {
  completed: 0,
  blocked: 1,
  question: 9,
  cancelled: 130,
  stage_failed: 3,
  revisions_exhausted: 4,
  dispatch_limit: 5,
  verify_exhausted: 6,
  verify_failed: 7,
  quota: 8,
  stage: 0,
};

const TERMINAL_SESSION_STATUSES = new Set(["completed", "blocked", "question", "cancelled"]);

export interface ExecuteRequest {
  workflowId?: string | null;
  task?: string | null;
  sessionId?: string | null;
  stageId?: string | null;
  /** Stage that receives `reply` when `stageId` is not set. It does not limit dispatch to one stage. */
  replyStageId?: string | null;
  priorSessionId?: string | null;
  maxDispatches?: number | null;
  once?: boolean;
  resetRevisions?: boolean;
  /** `session continue` writes `from: failed` before dispatch. A plain run leaves this false. */
  continueFailed?: boolean;
  startPrepared?: boolean;
  refreshWorkflow?: boolean;
  /**
   * Runs once the request is validated and before a new session is created or a prepared one is
   * frozen. Returning false stops the run with a configuration error and leaves nothing behind.
   */
  preflight?: (target: { workflowId: string | null; sessionId: string | null }) => Promise<boolean>;
  /** Reply for one blocked stage or pending question. */
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

function preflightFailed(sessionId: string): ExecuteResult {
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

async function executeLocked(
  workspace: string,
  request: ExecuteRequest,
  held: { lock: SessionLock | null; sessionId: string | null },
  runner?: AgentToolRunner,
): Promise<ExecuteResult> {
  const activeRunner = runner;
  if (activeRunner === undefined) {
    throw new ConfigurationError("A client registry is required to run a workflow.");
  }
  const registry = activeRunner.registry;
  const stageId = request.stageId ?? null;
  const replyStageId = stageId ?? request.replyStageId ?? null;
  const once = request.once ?? false;
  const maxDispatches =
    request.maxDispatches === undefined ? DEFAULT_MAX_DISPATCHES : request.maxDispatches;
  if (!once && maxDispatches !== null && maxDispatches < 1) {
    throw new ConfigurationError("--max-dispatches must be at least 1.");
  }
  const store = new SessionStore(workspace);
  let sessionId = request.sessionId ?? null;
  let workflow: WorkflowDocument | null = null;
  let workflowId: string;
  let resumeCancelled = false;
  let reopenLatestCancelled = false;
  // A cancelled-stage reply never resumes blocked siblings; they keep their blockers.
  let cancelledReplyStage = false;
  let stageReply: PendingStageReply | null = null;
  const replyText = typeof request.reply === "string" ? request.reply : null;
  if (sessionId) {
    if (!existsSync(path.join(workspace, ".migent", "sessions", sessionId))) {
      throw new ConfigurationError(`Session not found: ${sessionId}.`);
    }
    held.sessionId = sessionId;
    held.lock = SessionLock.acquire(path.join(workspace, ".migent", "sessions", sessionId));
    repairSessionUnlocked(workspace, sessionId);
    if (request.refreshWorkflow && !request.startPrepared) refreshSessionWorkflow(workspace, sessionId, false, registry);
    const bound = bindExecuteRun(workspace, sessionId, request.workflowId, request.priorSessionId);
    workflowId = bound.workflowId;
    if (!request.refreshWorkflow) {
      const workflowPath = typeof bound.status.workflow_path === "string" ? bound.status.workflow_path : null;
      const storedWorkflow = typeof bound.status.workflow_id === "string" ? bound.status.workflow_id : null;
      warnIfFrozenDrift(workspace, sessionId, workflowPath, storedWorkflow, registry);
    }
    let sessionStatus = typeof bound.status.status === "string" ? bound.status.status : "";
    if (replyText !== null && replyText.trim() === "") {
      throw new ConfigurationError("--reply is empty.");
    }
    if (replyText !== null) {
      const cancelled = store.cancelledStages(sessionId);
      const waiting = [...store.blockedStages(sessionId), ...store.questionStages(sessionId), ...cancelled];
      if (waiting.length === 0) throw new ConfigurationError("--reply requires a blocked, cancelled, or question stage.");
      if (waiting.length > 1 && replyStageId === null) throw new ConfigurationError(`--reply needs --stage when more than one stage is waiting: ${waiting.map((row) => row.stageId).join(", ")}.`);
      const target = replyStageId ?? waiting[0]!.stageId;
      if (!waiting.some((row) => row.stageId === target)) throw new ConfigurationError(`Stage ${target} is not waiting for a reply.`);
      stageReply = { stageId: target, text: replyText };
      const cancelledTarget = cancelled.find((row) => row.stageId === target);
      if (store.questionStages(sessionId).some((row) => row.stageId === target)) {
        stageReply.text = store.resumeQuestion(sessionId, target, replyText);
        sessionStatus = "active";
      } else if (cancelledTarget) {
        if (verifyOnlyExecution(workspace, sessionId, cancelledTarget.executionId)) {
          throw new ConfigurationError(`Stage ${target} has no agent to reply to. Omit --reply to run its verify list again.`);
        }
        store.supersedeCancelled(sessionId, target, replyText);
        sessionStatus = "active";
        cancelledReplyStage = true;
        resumeCancelled = true;
        reopenLatestCancelled = true;
      }
    } else {
      // Recover an answer recorded before a dispatch was interrupted or failed preflight.
      const answered = store.questionStages(sessionId).map((row) => ({
        ...row, reply: store.questionReply(sessionId!, row.executionId),
      })).find((row) => row.reply !== null && (replyStageId === null || replyStageId === row.stageId));
      if (answered) stageReply = { stageId: answered.stageId, text: answered.reply! };
      else {
        // Recover a reply to a cancelled stage that was recorded before its dispatch.
        const pending = store.pendingCancelledReply(sessionId, replyStageId);
        if (pending) {
          stageReply = { stageId: pending.stageId, text: pending.reply };
          sessionStatus = "active";
          cancelledReplyStage = true;
          resumeCancelled = true;
          reopenLatestCancelled = true;
        }
      }
    }
    if (!resumeCancelled && store.pendingCancelledReply(sessionId) !== null) {
      // A saved reply makes the session active while another cancelled stage still waits to be reopened.
      const superseded = store.supersededExecutionIds(sessionId);
      if (store.cancelledStages(sessionId).some((row) => !superseded.has(row.executionId))) {
        resumeCancelled = true;
        reopenLatestCancelled = true;
      }
    }
    if (request.startPrepared) {
      if (sessionStatus !== "prepared") {
        const hint =
          sessionStatus === "active"
            ? `Session ${sessionId} is active. Resume with: migent session continue ${sessionId}`
            : `Session ${sessionId} is ${sessionStatus || "unknown"}. migent session run --session only starts a prepared session.`;
        throw new ConfigurationError(hint);
      }
      if (request.preflight) {
        requireTaskBody(workspace, sessionId);
        if (!(await request.preflight({ workflowId: null, sessionId }))) return preflightFailed(sessionId);
      }
      activatePreparedSession(workspace, sessionId, registry);
      sessionStatus = "active";
    } else if (sessionStatus === "prepared") {
      throw new ConfigurationError(
        `Session ${sessionId} is prepared. Run: ${preparedRunHint(sessionId)}`,
      );
    }
    if (!cancelledReplyStage && (sessionStatus === "blocked" || (stageReply !== null && store.blockedStages(sessionId).some((row) => row.stageId === stageReply!.stageId)))) {
      const resumed = store.resumeBlockedSession(
        sessionId,
        stageReply?.stageId ?? stageId,
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
    workflow = loadNamedWorkflow(workspace, request.workflowId);
    workflowId = workflow.id;
    resolvePriorSessionId(workspace, workflow, request.priorSessionId);
    if (stageId !== null) requireEligibleStage(workflow, [], "active", stageId);
    if (request.preflight) {
      // Argument errors come before the doctor checks.
      if (request.task) assertSingleLineTask(request.task);
      if (!(await request.preflight({ workflowId: request.workflowId, sessionId: null }))) return preflightFailed("");
    }
    sessionId = createWorkflowSession(workspace, workflowId, request.task, request.priorSessionId, registry);
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
        blockResumes(workspace, sessionId),
        new Set(),
      );
      if (startable.length > 0) store.resetRevisionCounts(sessionId, snapshots);
    } else {
      const selected = selectedStage(workflow, snapshots, current, blockResumes(workspace, sessionId));
      if (selected instanceof NextStage) store.resetRevisionCounts(sessionId, snapshots);
    }
  }
  if (request.continueFailed) store.markFailedResumes(sessionId, stageId);
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
  held.lock?.onCancelRequest(onSigint);
  const tasks = new Map<string, Promise<unknown>>();
  try {
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
              verifyOnlyExecution(workspace, sessionId, item.executionId)
                ? runVerifyOnlyStage({
                    workspace,
                    sessionId,
                    stage: verifyOnlyStage(workflow, item.stageId),
                    verifyRunner: activeRunner.verifyRunner,
                    clients: activeRunner.registry,
                    executionId: item.executionId,
                  })
                : activeRunner.continueCancelled(workspace, sessionId, item.executionId),
            ),
          ),
        );
        const rejected = settled.find((item) => item.status === "rejected");
        if (rejected && rejected.status === "rejected") throw rejected.reason;
        const continued = settled.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []));
        for (let index = 0; index < reopened.length; index += 1) {
          const item = reopened[index]!;
          const result = continued[index]!;
          const outcome =
            result.failure_reason === VERIFY_FAILED
              ? "verify_failed"
              : result.outcome_status ||
                (result.failure_reason || result.failure_kind || result.execution_status === "failed"
                  ? "failed"
                  : "finished");
          log(
            stageFinishLine(
              workspace,
              sessionId,
              item.stageId || "stage",
              item.executionId,
              outcome,
              result.outcome_decision || "",
            ),
          );
          stageJsons.push(runResultJson(result));
        }
        const status = store.readSessionStatus(sessionId);
        const after = text(status.status);
        if (continued.some((item) => item.failure_reason === VERIFY_FAILED)) {
          return executeFinal(status, VERIFY_FAILED, stageJsons);
        }
        if (continued.some((item) => item.failure_reason === VERIFY_EXHAUSTED)) {
          return executeFinal(status, VERIFY_EXHAUSTED, stageJsons);
        }
        if (continued.some((item) => item.failure_kind === "quota") && (once || stageId !== null)) {
          return executeFinal(status, "quota", stageJsons);
        }
        // A cancelled session stops here for one stage. A blocked sibling still needs dispatch.
        if (!reopenLatestCancelled && (once || stageId !== null || TERMINAL_SESSION_STATUSES.has(after))) {
          const stopReason = TERMINAL_SESSION_STATUSES.has(after) ? after : "stage";
          const result = executeFinal(status, stopReason, stageJsons);
          if (stopReason === "stage" && continued.some((item) => item.outcome_status !== "complete" && item.execution_status !== "skipped")) result.code = continued.some((item) => item.outcome_status === "question") ? 9 : 1;
          return result;
        }
        if (!reopenLatestCancelled) {
          const rest = await runExecuteLoop(
            workspace,
            store,
            workflow,
            workflowId,
            sessionId,
            maxDispatches,
            activeRunner,
            tasks,
            stageReply,
            stageReply !== null && stageReply.text === null ? 1 : 0,
            stageJsons[0]?.failure_reason === VERIFY_EXHAUSTED && stageReply !== null ? [stageReply.stageId] : [],
            reopened
              .filter((item, index) => continued[index]?.failure_reason === VERIFY_FAILED)
              .map((item) => item.stageId),
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
      if (replyResult?.failure_kind === "quota") return executeFinal(status, "quota", stageJsons);
      const after = text(status.status);
      const stopReason = TERMINAL_SESSION_STATUSES.has(after) ? after : "stage";
      const result = executeFinal(status, stopReason, stageJsons);
      if (replyResult?.outcome_status === "question") {
        result.code = 9;
        result.stopReason = "question";
      }
      if (stopReason === "stage" && stageJsons.some((item) => item.outcome_status !== "complete" && item.execution_status !== "skipped")) result.code = stageJsons.some((item) => item.outcome_status === "question") ? 9 : 1;
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
          maxDispatches,
          activeRunner,
          tasks,
          stageReply,
          replyDispatches,
          replyVerifyTried,
          [],
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
  resumes: ReturnType<typeof blockResumes> = [],
): NextStage | Stop {
  const selected = nextStage(workflow, snapshots, sessionStatus, resumes);
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
    : version1OnceStage(workspace, workflow, sessionId, snapshots, status, stageId);
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
  if (stage.failure_reason === VERIFY_FAILED) return executeFinal(status, VERIFY_FAILED, [stage]);
  if (stage.failure_reason === VERIFY_EXHAUSTED) return executeFinal(status, VERIFY_EXHAUSTED, [stage]);
  if (stage.failure_kind === "quota") return executeFinal(status, "quota", [stage]);
  const stopReason = TERMINAL_SESSION_STATUSES.has(after) ? after : "stage";
  const result = executeFinal(status, stopReason, [stage]);
  if (stage.outcome_status === "question") {
    result.code = 9;
    result.stopReason = "question";
  }
  if (stopReason === "stage" && stage.outcome_status !== "complete" && stage.execution_status !== "skipped") {
    result.code = stage.outcome_status === "question" ? 9 : 1;
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
  const ready = readyStages(workflow, snapshots, sessionStatus, baselines, resumes);
  const schedulable = schedulableStageIds(workflow, snapshots, sessionStatus, baselines, resumes, new Set());
  const running = runningStageIds(snapshots);
  if (stageId !== null) {
    const latest = latestSnapshotForStage(snapshots, stageId);
    if (
      latest?.status === "failed" &&
      latest.failureReason !== VERIFY_EXHAUSTED &&
      latest.failureReason !== VERIFY_FAILED &&
      !resumes.some(
        (event) =>
          event.event === "session.active" &&
          event.executionId === latest.executionId &&
          event.data?.from === "failed",
      )
    ) {
      return executeFinal(status, "stage_failed", []);
    }
    if (!schedulable.includes(stageId)) {
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
    const reason = version2IdleReason(workflow, snapshots, sessionStatus, baselines, resumes);
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
  const stages: Array<Record<string, unknown>> = [];
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
    store.reapOrphanedExecutions(sessionId, "raise");
    const snapshots = store.executionSnapshots(sessionId);
    const status = store.readSessionStatus(sessionId);
    const selected = selectedStage(workflow, snapshots, text(status.status), blockResumes(workspace, sessionId));
    if (selected instanceof Stop) return executeFinal(status, selected.reason, stages);
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
  const stages: Array<Record<string, unknown>> = [];
  let dispatched = alreadyDispatched;
  const verifyTried = new Set<string>(verifyTriedSeed);
  const verifyOnlyTried = new Set<string>(verifyOnlyTriedSeed);
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
    if (remaining.length > 0) return executeFinal(endStatus, "dispatch_limit", stages);
    const reason = version2IdleReason(workflow, endSnapshots, endSession, endBaselines, endResumes);
    if (reason === "no eligible stage") return executeFinal(endStatus, "dispatch_limit", stages);
    return executeFinal(endStatus, reason, stages);
  };
  while (true) {
    cancellationSignal().throwIfCancelled();
    await observe();
    store.reapOrphanedExecutions(sessionId, "raise");
    let snapshots = store.executionSnapshots(sessionId);
    let status = store.readSessionStatus(sessionId);
    let sessionStatus = text(status.status);
    if (sessionStatus === "cancelled") {
      await Promise.allSettled(flights.map((flight) => flight.promise));
      return executeFinal(status, "cancelled", []);
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
      if (sessionStatus === "blocked" && starting.length > 0) {
        status.status = "active";
        delete status.blocked_by_execution_id;
        delete status.blocked_by_execution_ids;
        delete status.blocked_by_stage_id;
        delete status.blocker;
        delete status.terminal_execution_id;
        writeJsonAtomic(path.join(workspace, ".migent", "sessions", sessionId, "status.json"), status);
      }
      for (const stageId of starting) startStage(stageId, status, snapshots);
    }
    const cappedAfterStart = await settleCeiling();
    if (cappedAfterStart) return cappedAfterStart;
    if (flights.length === 0) {
      const reason = version2IdleReason(workflow, snapshots, sessionStatus, baselines, resumes);
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

function verifyOnlyExecution(workspace: string, sessionId: string, executionId: string): boolean {
  const context = new SessionStore(workspace).executionContext(sessionId, executionId);
  if (context === null) return false;
  const metadata = JSON.parse(readFileSync(path.join(context.directory, "execution.json"), "utf8")) as unknown;
  return isRecord(metadata) && metadata.kind === "verify";
}

function verifyOnlyStage(workflow: WorkflowDocument, stageId: string) {
  const stage = workflow.stages[stageId];
  if (stage === undefined || isRoleStage(stage)) {
    throw new ConfigurationError(`Stage ${stageId} has no verify-only runner.`);
  }
  return stage;
}

function roleStartLine(
  stageId: string,
  client: string,
  model: string,
  optionLabel: string,
  description: string | null,
  attempt: number | null,
): string {
  const parts = [`stage ${stageId}`];
  if (attempt !== null) parts.push(`attempt ${attempt}`);
  parts.push(formatClock(), `${client}/${model} (${optionLabel})`);
  const base = parts.join(" · ");
  if (description === null) return `${base}.`;
  return `${base} — ${description}.`;
}

function stageFinishLine(
  workspace: string,
  sessionId: string,
  stageId: string,
  executionId: string,
  outcome: string,
  decision: string,
): string {
  const parts = [`stage ${stageId}`];
  const attempt = parseExecutionId(executionId)?.attempt;
  if (attempt !== undefined) parts.push(`attempt ${attempt}`);
  const duration = stageDurationLabel(workspace, sessionId, executionId);
  if (duration !== null) parts.push(duration);
  const tail = decision ? `${outcome} decision=${decision}` : outcome;
  return `${parts.join(" · ")} · ${tail}.`;
}

function stageDurationLabel(workspace: string, sessionId: string, executionId: string): string | null {
  if (executionId === "") return null;
  const filePath = path.join(
    workspace,
    ".migent",
    "sessions",
    sessionId,
    "executions",
    executionId,
    "execution.json",
  );
  const elapsed = elapsedMs(readExecutionTimes(filePath));
  return elapsed === null ? null : formatDuration(elapsed);
}

function readExecutionTimes(filePath: string): { started: number | null; finished: number | null } {
  try {
    const metadata = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(metadata)) return { started: null, finished: null };
    return {
      started: parsedTime(metadata.created_at),
      finished: parsedTime(metadata.completed_at),
    };
  } catch {
    return { started: null, finished: null };
  }
}

function elapsedMs(times: { started: number | null; finished: number | null }): number | null {
  if (times.started === null) return null;
  return (times.finished ?? Date.now()) - times.started;
}

function parsedTime(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
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
  const stageSpec = workflow.stages[stageId];
  if (stageSpec === undefined) throw new ConfigurationError(`Stage not found: ${stageId}`);
  // Runs before the first await so two starts in one pool turn cannot both capture the baseline.
  if (ensureSessionBaseline(workspace, sessionId, workflow)) {
    commitFoldedStatus(workspace, path.join(workspace, ".migent", "sessions", sessionId));
  }
  const skipped = skipUnlessRunWhenMatches(workspace, sessionId, stageSpec, snapshots, runner);
  if (skipped !== null) return skipped;
  if (!isRoleStage(stageSpec)) {
    const result = await runVerifyOnlyStage({
      workspace,
      sessionId,
      stage: stageSpec,
      verifyRunner: runner.verifyRunner,
      clients: runner.registry,
      onExecution,
    });
    const outcome = result.failure_reason === VERIFY_FAILED ? "verify_failed" : "complete";
    log(stageFinishLine(workspace, sessionId, stageId, result.execution_id, outcome, ""));
    return { ...result };
  }
  const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
  const freeze = readWorkflowFreeze(sessionDirectory);
  const target = freeze
    ? frozenStageTarget(freeze, stageId)
    : resolveStageTarget(workspace, workflowId, stageId, undefined, runner.registry);
  const optionLabel =
    Object.entries(target.options)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ") || "default";
  const priorSessionId = storedPriorSessionId(status);
  const frozen = freezeSessionTask(workspace, sessionId);
  const exhausted = verifyExhaustedExecution(snapshots, stageId);
  const roleInstructions = freeze
    ? frozenRoleInstructions(freeze, stageSpec.role)
    : loadRoleResponsibilities(loadWorkspaceConfig(workspace), stageSpec.role);
  const promptInput = {
    workflow,
    stageId,
    taskFile: frozen.taskFile,
    sessionDirectory: frozen.sessionDirectory,
    snapshots,
    workspace,
    priorSessionId,
    priorOutputs: priorSessionOutputs(workspace, priorSessionId, sessionId),
    roleInstructions,
  };
  const stageReply = takeStageReply(reply, stageId);
  const answers = stageReply !== null
    && new SessionStore(workspace).questionStages(sessionId).some((row) => row.stageId === stageId);
  const interrupted = stageReply !== null && interruptedExecutionId(snapshots, stageId) !== undefined;
  const turn: TurnKind = stageReply !== null
    ? (answers && !interrupted ? "answers" : "reply")
    : exhausted?.verifyReport ? "repair"
      : stagePromptAlreadyDelivered(workflow, snapshots, stageId) ? "continue" : "start";
  const prompt =
    turn === "answers" || turn === "reply"
      ? buildStageReplyPrompt(stageReply!, { answers, interrupted })
      : turn === "repair"
        ? buildVerifyRepairPrompt(
            readFileSync(exhausted!.verifyReport!, "utf8"),
            stageSpec.maxVerify,
            stageSpec.maxVerify,
            null,
            frozen.taskFile,
            frozen.sessionDirectory,
          )
        : turn === "continue"
          ? buildStageResumePrompt(promptInput)
          : buildStagePrompt(promptInput);
  const request: StageDispatchRequest = {
    workflowId,
    stageId,
    prompt,
    turn,
    sessionId,
  };
  let loggedStart = false;
  const result: StageDispatchResult = await dispatchNamedStage(
    workspace,
    request,
    runner,
    { workflow, target },
    (executionId) => {
      onExecution?.(executionId);
      if (loggedStart) return;
      loggedStart = true;
      log(
        roleStartLine(
          stageId,
          target.client,
          target.model,
          optionLabel,
          stageSpec.description,
          parseExecutionId(executionId)?.attempt ?? null,
        ),
      );
    },
  );
  const outcome =
    result.outcomeStatus ||
    (result.failureReason || result.failureKind || result.executionStatus === "failed" ? "failed" : "finished");
  log(stageFinishLine(workspace, sessionId, stageId, result.executionId, outcome, result.outcomeDecision));
  return result.toJson();
}

/** A fresh visit of a run_when stage is evaluated. Retries and resumed blocks already passed the condition. */
function skipUnlessRunWhenMatches(
  workspace: string,
  sessionId: string,
  stage: StageSpec,
  snapshots: readonly ExecutionSnapshot[],
  runner: AgentToolRunner,
): Record<string, unknown> | null {
  if (stage.runWhen == null) return null;
  let latest: ExecutionSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.stageId !== stage.id) continue;
    if (latest === null || snapshot.executionOrder > latest.executionOrder) latest = snapshot;
  }
  const fresh =
    latest === null ||
    latest.status === "skipped" ||
    (latest.status === "completed" && latest.outcomeStatus !== "blocked" && latest.outcomeStatus !== "question");
  if (!fresh) return null;
  const evaluation = evaluateRunWhen(workspace, sessionId, stage);
  if ("matched" in evaluation) {
    log(`stage ${stage.id} · run_when matched ${evaluation.matched}.`);
    return null;
  }
  const store = new SessionStore(workspace, undefined, runner.registry);
  const context = store.recordSkippedExecution(sessionId, stage.id, evaluation.skip);
  const attempt = parseExecutionId(context.executionId)?.attempt ?? null;
  log(`stage ${stage.id} · attempt ${attempt ?? 1} · skipped (no changed path matches run_when).`);
  return {
    agent_id: null,
    options: {},
    session_id: sessionId,
    execution_id: context.executionId,
    artifact_directory: context.artifactDirectory,
    failure_reason: "",
    failure_kind: "",
    reset_at: "",
    client: "",
    outcome_status: "",
    outcome_decision: "",
    session_status: text(store.readSessionStatus(sessionId).status),
    response: "",
    execution_status: "skipped",
    skip: {
      reason: evaluation.skip.reason,
      baseline: evaluation.skip.baseline,
      patterns: evaluation.skip.patterns,
      changed_paths: evaluation.skip.changedPaths,
    },
  };
}

/** Execution id of the stage's latest attempt when the human stopped it before it finished. */
function interruptedExecutionId(snapshots: readonly ExecutionSnapshot[], stageId: string): string | undefined {
  let latest: ExecutionSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.stageId !== stageId || snapshot.status === "skipped") continue;
    if (latest === null || snapshot.executionOrder > latest.executionOrder) latest = snapshot;
  }
  return latest?.status === "cancelled" ? latest.executionId : undefined;
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

function refreshSessionWorkflow(
  workspace: string,
  sessionId: string,
  startPrepared: boolean,
  registry: ClientRegistry,
): void {
  const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
  const freeze = readWorkflowFreeze(sessionDirectory);
  const status = new SessionStore(workspace).readSessionStatus(sessionId);
  const sessionStatus = typeof status.status === "string" ? status.status : "";
  if (sessionStatus === "completed" || sessionStatus === "cancelled") {
    throw new ConfigurationError(`Session ${sessionId} is ${sessionStatus}.`);
  }
  if (!startPrepared && sessionStatus === "prepared") {
    throw new ConfigurationError(`Session ${sessionId} is prepared. Run: ${preparedRunHint(sessionId)}`);
  }
  if (freeze === null) throw new ConfigurationError(`Session ${sessionId} has no frozen workflow.`);
  if (startPrepared && sessionStatus !== "prepared") {
    const hint =
      sessionStatus === "active"
        ? `Session ${sessionId} is active. Resume with: migent session continue ${sessionId}`
        : `Session ${sessionId} is ${sessionStatus || "unknown"}. migent session run --session only starts a prepared session.`;
    throw new ConfigurationError(hint);
  }
  const workflowPath = typeof status.workflow_path === "string" ? status.workflow_path : null;
  const workflowId = typeof status.workflow_id === "string" ? status.workflow_id : null;
  const live = requireLiveWorkflow(workspace, workflowPath, workflowId);
  const freezePath = path.join(sessionDirectory, WORKFLOW_FREEZE_FILE);
  const previousText = readFileSync(freezePath, "utf8");
  const previousHash = createHash("sha256").update(previousText).digest("hex");
  const written = writeWorkflowFreeze(sessionDirectory, workspace, live, registry);
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

function preparedRunHint(sessionId: string): string {
  return `migent session run --session ${sessionId}`;
}

function storedPriorSessionId(status: Record<string, unknown>): string | null {
  const prior = status.prior_session_id;
  return typeof prior === "string" && prior ? prior : null;
}

function priorSessionOutputs(
  workspace: string,
  priorSessionId: string | null,
  sessionId?: string,
): Record<string, unknown> | null {
  if (!priorSessionId) return null;
  if (sessionId) {
    const handoff = new SessionStore(workspace).readSessionStatus(sessionId).handoff;
    if (isRecord(handoff) && isRecord(handoff.artifacts)) {
      return Object.fromEntries(Object.entries(handoff.artifacts).map(([name, value]) => {
        const record = isRecord(value) ? value : {};
        return [name, { ...record, path: path.resolve(workspace, ".migent", "sessions", sessionId, String(record.path)) }];
      }));
    }
  }
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
    failure_kind: result.failure_kind,
    reset_at: result.reset_at,
    client: result.client,
    outcome_status: result.outcome_status,
    outcome_decision: result.outcome_decision,
    session_status: result.session_status,
    response: result.response,
    execution_status: result.execution_status ?? "",
  };
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

/** The reply prompt names a lone question; several questions are spelled out in the formatted answers. */
