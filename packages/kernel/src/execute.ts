import { AgentToolRunner, type RunResult } from "./agent-runner.js";
import { CancellationRequested, raiseCancellation } from "./command-executor.js";
import { loadRoleInstructions, loadYamlMapping, resolveStageTarget } from "./config.js";
import { ConfigurationError } from "./errors.js";
import {
  assertStageDispatchable,
  dispatchNamedStage,
  type StageDispatchRequest,
  type StageDispatchResult,
} from "./dispatch.js";
import { isRecord } from "./record.js";
import { buildStagePrompt, buildVerifyRepairPrompt } from "./prompt.js";
import { log } from "./runtime.js";
import {
  VERIFY_EXHAUSTED,
  failedStageCount,
  nextStage,
  revisionStop,
  verifyExhaustedExecution,
  NextStage,
  NextStageError,
  Stop,
} from "./selection.js";
import { repairSessionUnlocked } from "./session-repair.js";
import { activatePreparedSession, bindPriorSessionId, createWorkflowSession, resolvePriorSessionId } from "./session-records.js";
import { freezeSessionTask } from "./task-file.js";
import { isSessionLockLost, SessionLock, SessionLockHeldError } from "./session-lock.js";
import { SessionStore } from "./session-store.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadNamedWorkflow, type WorkflowDocument } from "./workflow.js";
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
  const held: { lock: SessionLock | null } = { lock: null };
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
    held.lock?.release();
  }
}

async function executeLocked(
  workspace: string,
  request: ExecuteRequest,
  held: { lock: SessionLock | null },
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
  if (sessionId) {
    held.lock = SessionLock.acquire(path.join(workspace, ".migent", "sessions", sessionId));
    repairSessionUnlocked(workspace, sessionId);
    const bound = bindExecuteRun(workspace, sessionId, request.workflowId, request.priorSessionId);
    workflowId = bound.workflowId;
    let sessionStatus = typeof bound.status.status === "string" ? bound.status.status : "";
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
      const resumed = store.resumeBlockedSession(sessionId);
      sessionStatus = "active";
      const stageLabel = resumed.stageId || "its stage";
      log(`session ${sessionId} was blocked by ${resumed.executionId}. Resuming ${stageLabel}.`);
    }
    if (sessionStatus === "cancelled") {
      resumeCancelled = true;
    } else if (TERMINAL_SESSION_STATUSES.has(sessionStatus)) {
      return executeFinal(bound.status, sessionStatus, []);
    }
  } else {
    if (!request.workflowId) throw new ConfigurationError("Creating a session requires a workflow.");
    if (!request.task) throw new ConfigurationError("Creating a session requires --task.");
    workflow = loadNamedWorkflow(workspace, request.workflowId);
    workflowId = workflow.id;
    resolvePriorSessionId(workspace, workflow, request.priorSessionId);
    if (stageId !== null) requireEligibleStage(workflow, [], "active", stageId);
    sessionId = createWorkflowSession(workspace, workflowId, request.task, request.priorSessionId);
    held.lock = SessionLock.acquire(path.join(workspace, ".migent", "sessions", sessionId));
    log(`session_id: ${sessionId}`);
  }
  if (workflow === null) workflow = loadNamedWorkflow(workspace, workflowId);
  if (request.resetRevisions) {
    store.reapOrphanedExecutions(sessionId, "raise");
    const snapshots = store.executionSnapshots(sessionId);
    const status = store.readSessionStatus(sessionId);
    const current = text(status.status);
    if (current === "cancelled") {
      store.resetRevisionCounts(sessionId, snapshots);
    } else {
      const selected = selectedStage(workflow, snapshots, current);
      if (selected instanceof NextStage) store.resetRevisionCounts(sessionId, snapshots);
    }
  }
  const onSigint = () => {
    try {
      raiseCancellation(2);
    } catch {
      // The pending flag is what the command loop observes.
    }
  };
  const onSigterm = () => {
    try {
      raiseCancellation(15);
    } catch {
      // The pending flag is what the command loop observes.
    }
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    const activeRunner = runner ?? new AgentToolRunner();
    if (resumeCancelled) {
      const reopened = store.reopenCancelledExecution(sessionId);
      log(`session ${sessionId} was cancelled during ${reopened.executionId}. Resuming that execution.`);
      const continued = await activeRunner.continueCancelled(workspace, sessionId, reopened.executionId);
      const outcome = continued.outcome_status || (continued.failure_reason ? "failed" : "finished");
      const decision = continued.outcome_decision ? ` decision=${continued.outcome_decision}` : "";
      log(`stage ${reopened.stageId || "stage"} · ${outcome}${decision}.`);
      const stageJson = runResultJson(continued);
      const status = store.readSessionStatus(sessionId);
      const after = text(status.status);
      if (continued.failure_reason === VERIFY_EXHAUSTED) {
        return executeFinal(status, VERIFY_EXHAUSTED, [stageJson]);
      }
      if (once || stageId !== null || TERMINAL_SESSION_STATUSES.has(after)) {
        const stopReason = TERMINAL_SESSION_STATUSES.has(after) ? after : "stage";
        const result = executeFinal(status, stopReason, [stageJson]);
        if (stopReason === "stage" && continued.outcome_status !== "complete") result.code = 1;
        return result;
      }
      const rest = await runExecuteLoop(
        workspace,
        store,
        workflow,
        workflowId,
        sessionId,
        maxAttempts,
        maxDispatches,
        activeRunner,
      );
      rest.stages = [stageJson, ...rest.stages];
      return rest;
    }
    if (once || stageId !== null) {
      return await runExecuteOnce(workspace, store, workflow, workflowId, sessionId, stageId, activeRunner);
    }
    return await runExecuteLoop(
      workspace,
      store,
      workflow,
      workflowId,
      sessionId,
      maxAttempts,
      maxDispatches,
      activeRunner,
    );
  } catch (error) {
    if (error instanceof CancellationRequested) {
      log(error.message);
      return executeFinal(store.readSessionStatus(sessionId), "cancelled", []);
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
): Promise<ExecuteResult> {
  store.reapOrphanedExecutions(sessionId, "raise");
  const snapshots = store.executionSnapshots(sessionId);
  let status = store.readSessionStatus(sessionId);
  const sessionStatus = text(status.status);
  if (TERMINAL_SESSION_STATUSES.has(sessionStatus)) return executeFinal(status, sessionStatus, []);
  const selected = selectedStage(workflow, snapshots, sessionStatus);
  if (selected instanceof Stop) return executeFinal(status, selected.reason, []);
  if (stageId !== null && selected.stageId !== stageId) {
    throw new ConfigurationError(`Stage ${stageId} is not the eligible stage ${selected.stageId}.`);
  }
  if (revisionStop(workflow, snapshots, selected.stageId, revisionBaselines(status))) {
    return executeFinal(status, "revisions_exhausted", []);
  }
  assertStageDispatchable(workspace, workflow, sessionId, selected.stageId);
  const stage = await dispatchExecuteStage(
    workspace,
    workflow,
    workflowId,
    sessionId,
    selected.stageId,
    status,
    snapshots,
    runner,
  );
  status = store.readSessionStatus(sessionId);
  const after = text(status.status);
  if (stage.failure_reason === VERIFY_EXHAUSTED) return executeFinal(status, VERIFY_EXHAUSTED, [stage]);
  const stopReason = TERMINAL_SESSION_STATUSES.has(after) ? after : "stage";
  const result = executeFinal(status, stopReason, [stage]);
  if (stopReason === "stage" && stage.outcome_status !== "complete") result.code = 1;
  return result;
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
): Promise<ExecuteResult> {
  const stages: Array<Record<string, unknown>> = [];
  let dispatched = 0;
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
    const dispatchedStage = await dispatchExecuteStage(
      workspace,
      workflow,
      workflowId,
      sessionId,
      selected.stageId,
      status,
      snapshots,
      runner,
    );
    stages.push(dispatchedStage);
    if (dispatchedStage.failure_reason === VERIFY_EXHAUSTED) {
      return executeFinal(store.readSessionStatus(sessionId), VERIFY_EXHAUSTED, stages);
    }
  }
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
): Promise<Record<string, unknown>> {
  const target = resolveStageTarget(workspace, workflowId, stageId);
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
  const roleInstructions = loadRoleInstructions(
    loadYamlMapping(path.join(workspace, ".migent", "config.yaml")),
    stageSpec.role,
  );
  const prompt =
    exhausted?.verifyReport
      ? buildVerifyRepairPrompt(
          readFileSync(exhausted.verifyReport, "utf8"),
          stageSpec.maxVerify,
          stageSpec.maxVerify,
          null,
          frozen.taskFile,
          frozen.sessionDirectory,
        )
      : buildStagePrompt({
          workflow,
          stageId,
          taskFile: frozen.taskFile,
          sessionDirectory: frozen.sessionDirectory,
          snapshots,
          workspace,
          priorSessionId,
          priorOutputs: priorSessionOutputs(workspace, priorSessionId),
          roleInstructions,
        });
  const request: StageDispatchRequest = {
    workflowId,
    stageId,
    prompt,
    sessionId,
  };
  const result: StageDispatchResult = await dispatchNamedStage(workspace, request, runner);
  const outcome = result.outcomeStatus || (result.failureReason ? "failed" : "finished");
  const decision = result.outcomeDecision ? ` decision=${result.outcomeDecision}` : "";
  log(`stage ${stageId} · ${outcome}${decision}.`);
  return result.toJson();
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

function hasErrorCode(error: Error): boolean {
  return "code" in error && typeof (error as { code?: unknown }).code === "string";
}
