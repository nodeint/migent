import { createHash } from "node:crypto";
import { AgentToolRunner, type RunResult } from "./agent-runner.js";
import { writeFileAtomic, writeJsonAtomic } from "./atomic-file.js";
import {
  CancellationRequested,
  cancellationSignal,
  raiseCancellation,
  resetCancellation,
  waitUntil,
  type WaitHooks,
} from "./command-executor.js";
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
import { isRoleStage, isWorkflowV2, loadNamedWorkflow, type WorkflowDocument } from "./workflow.js";
import { runVerifyOnlyStage } from "./verify-only.js";
import type { ExecutionSnapshot } from "./outputs.js";

export const DEFAULT_MAX_DISPATCHES = 20;

const EXECUTE_EXIT_CODES: Record<string, number> = {
  completed: 0,
  blocked: 1,
  cancelled: 130,
  stage_failed: 3,
  revisions_exhausted: 4,
  dispatch_limit: 5,
  verify_exhausted: 6,
  verify_failed: 7,
  quota: 8,
  stage: 0,
};

const TERMINAL_SESSION_STATUSES = new Set(["completed", "blocked", "cancelled"]);

export interface ExecuteRequest {
  workflowId?: string | null;
  task?: string | null;
  sessionId?: string | null;
  stageId?: string | null;
  priorSessionId?: string | null;
  maxDispatches?: number | null;
  once?: boolean;
  resetRevisions?: boolean;
  /** `session continue` writes `from: failed` before dispatch. A plain run leaves this false. */
  continueFailed?: boolean;
  waitHooks?: WaitHooks;
  startPrepared?: boolean;
  refreshWorkflow?: boolean;
  /** Reply for one blocked stage. The new execution's prompt body is this text. */
  reply?: string | null;
}

interface PendingStageReply {
  stageId: string;
  text: string | null;
}

interface QuotaWait {
  stageId: string;
  provider: string;
  resetAt: string;
  executionId: string;
  response: string;
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
  const tasks = new Map<string, Promise<unknown>>();
  try {
    const activeRunner = runner ?? new AgentToolRunner();
    const stageJsons: Array<Record<string, unknown>> = [];
    const seedWaits: QuotaWait[] = [];
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
                    adapters: activeRunner.adapters,
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
        seedWaits.push(...waitsFromRuns(reopened, continued));
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
            maxDispatches,
            activeRunner,
            tasks,
            stageReply,
            stageReply !== null && stageReply.text === null ? 1 : 0,
            stageJsons[0]?.failure_reason === VERIFY_EXHAUSTED && stageReply !== null ? [stageReply.stageId] : [],
            reopened
              .filter((item, index) => continued[index]?.failure_reason === VERIFY_FAILED)
              .map((item) => item.stageId),
            seedWaits,
            request.waitHooks,
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
      if (stopReason === "stage" && stageJsons.some((item) => item.outcome_status !== "complete")) result.code = 1;
      return result;
    }
    if (replySent && replyResult !== undefined && stageReply !== null) {
      const replyWait = waitFromStage(stageReply.stageId, replyResult);
      if (replyWait) seedWaits.push(replyWait);
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
          seedWaits,
          request.waitHooks,
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
  if (stopReason === "stage" && stage.outcome_status !== "complete") result.code = 1;
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
  waits: readonly QuotaWait[] = [],
  waitHooks?: WaitHooks,
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
      waits,
      waitHooks,
    );
  }
  const stages: Array<Record<string, unknown>> = [];
  let dispatched = alreadyDispatched;
  const acted = new Map<string, string>();
  const pending = [...waits];
  let forced: string | null = null;
  const accept = async (stage: Record<string, unknown>, stageId: string): Promise<ExecuteResult | null> => {
    stages.push(stage);
    if (stage.failure_reason === VERIFY_FAILED) {
      return executeFinal(store.readSessionStatus(sessionId), VERIFY_FAILED, stages);
    }
    if (stage.failure_reason === VERIFY_EXHAUSTED) {
      return executeFinal(store.readSessionStatus(sessionId), VERIFY_EXHAUSTED, stages);
    }
    const step = quotaStep(stage, acted, dispatched, maxDispatches, waitHooks);
    if (step === "limit") return executeFinal(store.readSessionStatus(sessionId), "dispatch_limit", stages);
    const wait = step === "wait" || step === "dispatch" ? waitFromStage(stageId, stage) : null;
    if (wait && step === "wait") {
      emitQuota(workspace, store, sessionId, wait);
      await waitUntil(wait.resetAt, waitHooks).promise;
    }
    if (wait) forced = stageId;
    return null;
  };
  while (true) {
    cancellationSignal().throwIfCancelled();
    if (forced !== null) {
      if (maxDispatches !== null && dispatched >= maxDispatches) {
        return executeFinal(store.readSessionStatus(sessionId), "dispatch_limit", stages);
      }
      const stageId = forced;
      forced = null;
      const status = store.readSessionStatus(sessionId);
      const snapshots = store.executionSnapshots(sessionId);
      dispatched += 1;
      const dispatchedStage = await trackDispatch(sessionId, tasks, (note) =>
        dispatchExecuteStage(workspace, workflow, workflowId, sessionId, stageId, status, snapshots, runner, note, reply),
      );
      const stopped = await accept(dispatchedStage, stageId);
      if (stopped) return stopped;
      continue;
    }
    if (pending.length > 0) {
      const item = pending.shift()!;
      const previous = acted.get(item.provider);
      if (previous !== undefined && !laterInstant(item.resetAt, previous)) {
        // The unmarked failure stops the loop on the next selection.
      } else if (maxDispatches !== null && dispatched >= maxDispatches) {
        return executeFinal(store.readSessionStatus(sessionId), "dispatch_limit", stages);
      } else {
        acted.set(item.provider, item.resetAt);
        if (!instantReached(item.resetAt, waitHooks)) {
          emitQuota(workspace, store, sessionId, item);
          await waitUntil(item.resetAt, waitHooks).promise;
        }
        forced = item.stageId;
        continue;
      }
    }
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
    const stopped = await accept(dispatchedStage, selected.stageId);
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
  waits: readonly QuotaWait[] = [],
  waitHooks?: WaitHooks,
): Promise<ExecuteResult> {
  const stages: Array<Record<string, unknown>> = [];
  let dispatched = alreadyDispatched;
  const verifyTried = new Set<string>(verifyTriedSeed);
  const verifyOnlyTried = new Set<string>(verifyOnlyTriedSeed);
  const flights: Array<{ kind: "provider" | "wait"; promise: Promise<void>; settled: boolean }> = [];
  const errors: unknown[] = [];
  const parked = new Map<string, ParkedWait>();
  const acted = new Map<string, string>();
  const directQueue: string[] = [];
  let quotaCeiling = false;
  let seeded = false;
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
  const providerOf = (stageId: string): string | null => {
    const stageSpec = workflow.stages[stageId];
    if (stageSpec === undefined || !isRoleStage(stageSpec)) return null;
    const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
    const freeze = readWorkflowFreeze(sessionDirectory);
    const target = freeze
      ? frozenStageTarget(freeze, stageId)
      : resolveStageTarget(workspace, workflowId, stageId);
    return target.provider;
  };
  const attachWait = (park: ParkedWait): void => {
    const handle = waitUntil(park.resetAt, waitHooks);
    park.handle = handle;
    const flight = { kind: "wait" as const, promise: Promise.resolve(), settled: false };
    flight.promise = handle.promise
      .then((outcome) => {
        if (park.abandon || park.suppress) return;
        if (outcome === "replaced") {
          attachWait(park);
          return;
        }
        directQueue.push(park.stageId);
      })
      .catch((error: unknown) => {
        errors.push(error);
      })
      .finally(() => {
        flight.settled = true;
      });
    flights.push(flight);
  };
  const arm = (wait: QuotaWait): void => {
    emitQuota(workspace, store, sessionId, wait);
    const park: ParkedWait = { ...wait, handle: null, abandon: false, suppress: false };
    parked.set(wait.provider, park);
    acted.set(wait.provider, wait.resetAt);
    attachWait(park);
  };
  const noteQuota = (stage: Record<string, unknown>, stageId: string): void => {
    if (stage.failure_kind !== "quota") return;
    const resetAt = typeof stage.reset_at === "string" ? stage.reset_at : "";
    const provider = typeof stage.provider === "string" ? stage.provider : "";
    if (resetAt === "") return;
    if (maxDispatches !== null && dispatched >= maxDispatches) {
      quotaCeiling = true;
      return;
    }
    const park = parked.get(provider);
    if (park?.handle && !park.abandon) {
      if (laterInstant(resetAt, park.resetAt)) {
        park.resetAt = resetAt;
        park.stageId = stageId;
        park.executionId = typeof stage.execution_id === "string" ? stage.execution_id : park.executionId;
        park.response = typeof stage.response === "string" ? stage.response : park.response;
        acted.set(provider, resetAt);
        park.handle.replace(resetAt);
      } else {
        park.suppress = true;
        park.handle.replace(park.resetAt);
      }
      return;
    }
    const previous = acted.get(provider);
    if (previous !== undefined && !laterInstant(resetAt, previous)) return;
    const wait = waitFromStage(stageId, stage);
    if (wait === null) return;
    if (instantReached(resetAt, waitHooks)) {
      acted.set(provider, resetAt);
      directQueue.push(stageId);
      return;
    }
    arm(wait);
  };
  const startProvider = (
    stageId: string,
    status: Record<string, unknown>,
    snapshots: readonly ExecutionSnapshot[],
  ): void => {
    const provider = providerOf(stageId);
    if (provider) parked.delete(provider);
    const flight = { kind: "provider" as const, promise: Promise.resolve(), settled: false };
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
        noteQuota(stage, stageId);
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
    const hadWaits = [...parked.values()].some((park) => park.handle !== null && !park.abandon);
    for (const park of parked.values()) {
      if (park.handle === null || park.abandon) continue;
      park.abandon = true;
      park.handle.replace(park.resetAt);
    }
    directQueue.length = 0;
    await Promise.allSettled(flights.filter((flight) => flight.kind === "provider").map((flight) => flight.promise));
    await observe();
    const endStatus = store.readSessionStatus(sessionId);
    if (hadWaits || quotaCeiling) return executeFinal(endStatus, "dispatch_limit", stages);
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
    if (!seeded) {
      seeded = true;
      const roomAtStart = maxDispatches === null || dispatched < maxDispatches;
      if (!roomAtStart) quotaCeiling = waits.length > 0;
      else {
        for (const item of waits) {
          const existing = parked.get(item.provider);
          if (existing?.handle && !laterInstant(item.resetAt, existing.resetAt)) continue;
          if (existing?.handle) {
            existing.resetAt = item.resetAt;
            existing.stageId = item.stageId;
            existing.executionId = item.executionId;
            existing.response = item.response;
            acted.set(item.provider, item.resetAt);
            existing.handle.replace(item.resetAt);
            continue;
          }
          if (instantReached(item.resetAt, waitHooks)) {
            acted.set(item.provider, item.resetAt);
            directQueue.push(item.stageId);
          } else {
            arm(item);
          }
        }
      }
    }
    store.reapOrphanedExecutions(sessionId, "raise");
    const snapshots = store.executionSnapshots(sessionId);
    const status = store.readSessionStatus(sessionId);
    const sessionStatus = text(status.status);
    if (sessionStatus === "cancelled") {
      await Promise.allSettled(flights.map((flight) => flight.promise));
      return executeFinal(status, "cancelled", []);
    }
    while (directQueue.length > 0) {
      if (maxDispatches !== null && dispatched >= maxDispatches) {
        quotaCeiling = true;
        directQueue.length = 0;
        break;
      }
      startProvider(directQueue.shift()!, status, snapshots);
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
    ).filter((stageId) => {
      const provider = providerOf(stageId);
      return provider === null || !parked.has(provider);
    });
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
      for (const stageId of starting) startProvider(stageId, status, snapshots);
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

interface ParkedWait extends QuotaWait {
  handle: { promise: Promise<"reached" | "replaced">; replace(retryAt: string): void } | null;
  abandon: boolean;
  suppress: boolean;
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
  provider: string,
  model: string,
  optionLabel: string,
  description: string | null,
  attempt: number | null,
): string {
  const parts = [`stage ${stageId}`];
  if (attempt !== null) parts.push(`attempt ${attempt}`);
  parts.push(formatClock(), `${provider}/${model} (${optionLabel})`);
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
  if (!isRoleStage(stageSpec)) {
    const result = await runVerifyOnlyStage({
      workspace,
      sessionId,
      stage: stageSpec,
      verifyRunner: runner.verifyRunner,
      adapters: runner.adapters,
      onExecution,
    });
    const outcome = result.failure_reason === VERIFY_FAILED ? "verify_failed" : "complete";
    log(stageFinishLine(workspace, sessionId, stageId, result.execution_id, outcome, ""));
    return { ...result };
  }
  const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
  const freeze = readWorkflowFreeze(sessionDirectory);
  const target = freeze ? frozenStageTarget(freeze, stageId) : resolveStageTarget(workspace, workflowId, stageId);
  const optionLabel =
    Object.entries(target.options)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ") || "default";
  const priorSessionId = storedPriorSessionId(status);
  const frozen = freezeSessionTask(workspace, sessionId);
  const exhausted = verifyExhaustedExecution(snapshots, stageId);
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
          target.provider,
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
    failure_kind: result.failure_kind,
    reset_at: result.reset_at,
    provider: result.provider,
    outcome_status: result.outcome_status,
    outcome_decision: result.outcome_decision,
    session_status: result.session_status,
    response: result.response,
  };
}

function waitsFromRuns(
  rows: readonly { stageId: string }[],
  results: readonly RunResult[],
): QuotaWait[] {
  const waits: QuotaWait[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const result = results[index];
    const row = rows[index];
    if (!result || !row || result.failure_kind !== "quota" || result.reset_at === "") continue;
    waits.push({
      stageId: row.stageId,
      provider: result.provider,
      resetAt: result.reset_at,
      executionId: result.execution_id,
      response: result.response,
    });
  }
  return waits;
}

function waitFromStage(stageId: string, stage: Record<string, unknown>): QuotaWait | null {
  if (stage.failure_kind !== "quota" || typeof stage.reset_at !== "string" || stage.reset_at === "") return null;
  return {
    stageId,
    provider: typeof stage.provider === "string" ? stage.provider : "",
    resetAt: stage.reset_at,
    executionId: typeof stage.execution_id === "string" ? stage.execution_id : "",
    response: typeof stage.response === "string" ? stage.response : "",
  };
}

function quotaStep(
  stage: Record<string, unknown>,
  acted: Map<string, string>,
  dispatched: number,
  maxDispatches: number | null,
  hooks: WaitHooks | undefined,
): "none" | "limit" | "stop" | "wait" | "dispatch" {
  if (stage.failure_kind !== "quota") return "none";
  const resetAt = typeof stage.reset_at === "string" ? stage.reset_at : "";
  const provider = typeof stage.provider === "string" ? stage.provider : "";
  if (resetAt === "") return "stop";
  if (maxDispatches !== null && dispatched >= maxDispatches) return "limit";
  const previous = acted.get(provider);
  if (previous !== undefined && !laterInstant(resetAt, previous)) return "stop";
  acted.set(provider, resetAt);
  return instantReached(resetAt, hooks) ? "dispatch" : "wait";
}

function instantReached(resetAt: string, hooks: WaitHooks | undefined): boolean {
  const now = hooks?.now ?? Date.now;
  const target = Date.parse(resetAt);
  return !Number.isFinite(target) || now() >= target;
}

function laterInstant(next: string, previous: string): boolean {
  const left = Date.parse(next);
  const right = Date.parse(previous);
  if (Number.isFinite(left) && Number.isFinite(right)) return left > right;
  return next > previous;
}

function emitQuota(workspace: string, store: SessionStore, sessionId: string, wait: QuotaWait): void {
  if (wait.executionId === "") return;
  const context = store.executionContext(sessionId, wait.executionId);
  if (context === null) return;
  let model = "";
  try {
    const metadata = JSON.parse(readFileSync(path.join(context.directory, "execution.json"), "utf8")) as unknown;
    if (isRecord(metadata) && typeof metadata.model === "string") model = metadata.model;
  } catch {
    model = "";
  }
  const summary = [wait.response, wait.resetAt].filter((item) => item !== "").join(" ");
  new ProviderEventReporter(store, context, wait.provider, model).emit("provider.quota", summary, {
    retry_at: wait.resetAt,
    provider: wait.provider,
  });
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
