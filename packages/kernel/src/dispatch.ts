import path from "node:path";
import { AgentToolRunner, type RunResult } from "./agent-runner.js";
import { resolveStageTarget, type StageTarget } from "./config.js";
import { ConfigurationError } from "./errors.js";
import { isRecord } from "./record.js";
import { frozenStageTarget, readWorkflowFreeze } from "./session-freeze.js";
import { bindPriorSessionId, createWorkflowSession } from "./session-records.js";
import {
  missingOutputProducers,
  revisionResumeExecution,
  stageAgentExecution,
  stageDispatchError,
  verifyExhaustedExecution,
} from "./selection.js";
import { stringOptions, SessionStore } from "./session-store.js";
import { loadNamedWorkflow, type WorkflowDocument } from "./workflow.js";

export interface StageDispatchRequest {
  workflowId: string;
  stageId: string;
  prompt: string;
  task?: string | null;
  sessionId?: string | null;
  priorSessionId?: string | null;
  provider?: string | null;
  model?: string | null;
  options?: Record<string, string> | null;
  stageAttempt?: number | null;
  executionOrder?: number | null;
}

export class StageDispatchResult {
  constructor(
    readonly sessionId: string,
    readonly executionId: string,
    readonly outcomeStatus: string,
    readonly outcomeDecision: string,
    readonly sessionStatus: string,
    readonly response: string,
    readonly agentId = "",
    readonly options: Record<string, string> = {},
    readonly artifactDirectory = "",
    readonly failureReason = "",
    readonly failureKind = "",
    readonly resetAt = "",
    readonly provider = "",
  ) {}

  toJson(): Record<string, unknown> {
    return {
      agent_id: this.agentId,
      options: { ...this.options },
      session_id: this.sessionId,
      execution_id: this.executionId,
      artifact_directory: this.artifactDirectory,
      failure_reason: this.failureReason,
      failure_kind: this.failureKind,
      reset_at: this.resetAt,
      provider: this.provider,
      outcome_status: this.outcomeStatus,
      outcome_decision: this.outcomeDecision,
      session_status: this.sessionStatus,
      response: this.response,
    };
  }
}

export async function dispatchNamedStage(
  workspace: string,
  request: StageDispatchRequest,
  runner?: AgentToolRunner,
  resolved?: { workflow: WorkflowDocument; target: StageTarget } | null,
  onExecution?: (executionId: string) => void,
): Promise<StageDispatchResult> {
  let loaded = resolved ?? loadDispatchTarget(workspace, request);
  let workflow = loaded.workflow;
  let target = loaded.target;
  let sessionId = request.sessionId ?? null;
  if (sessionId === null) {
    if (!request.task) throw new ConfigurationError("The first workflow stage requires --task.");
    sessionId = createWorkflowSession(workspace, workflow.id, request.task, request.priorSessionId);
    if (!resolved) {
      loaded = loadDispatchTarget(workspace, { ...request, sessionId });
      workflow = loaded.workflow;
      target = loaded.target;
    }
  } else {
    bindPriorSessionId(workspace, sessionId, request.priorSessionId);
  }
  assertStageDispatchable(workspace, workflow, sessionId, request.stageId);
  const snapshots = new SessionStore(workspace).executionSnapshots(sessionId);
  const stage = workflow.stages[request.stageId];
  const resumeExecutionId = stage?.resumeFrom
    ? (verifyExhaustedExecution(snapshots, request.stageId)?.executionId ??
      revisionResumeExecution(workflow, snapshots, request.stageId) ??
      resolveResumeExecution(workspace, workflow, sessionId, request.stageId))
    : stageAgentExecution(snapshots, request.stageId);
  const result = await (runner ?? new AgentToolRunner()).run({
    provider: target.provider,
    model: target.model,
    options: { ...target.options },
    prompt: request.prompt,
    workspace,
    sessionId,
    resumeExecutionId,
    stageId: request.stageId,
    stageAttempt: request.stageAttempt,
    executionOrder: request.executionOrder,
    onExecution,
  });
  return resultFromRun(result, sessionId);
}

export function assertStageDispatchable(
  workspace: string,
  workflow: WorkflowDocument,
  sessionId: string,
  stageId: string,
): void {
  const store = new SessionStore(workspace);
  const snapshots = store.executionSnapshots(sessionId);
  const status = store.readSessionStatus(sessionId);
  const sessionStatus = typeof status.status === "string" ? status.status : "active";
  // continue reruns a producer whose artifact is missing after the branch ended.
  if (missingOutputProducers(workflow, snapshots, sessionStatus).includes(stageId)) return;
  const error = stageDispatchError(workflow, stageId, snapshots);
  if (error) throw new ConfigurationError(error);
}

export function resolveResumeExecution(
  workspace: string,
  workflow: WorkflowDocument,
  sessionId: string,
  stageId: string,
): string | null {
  const stage = workflow.stages[stageId];
  if (stage === undefined || !stage.resumeFrom) return null;
  const snapshots = new SessionStore(workspace).executionSnapshots(sessionId);
  let latest: (typeof snapshots)[number] | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.stageId !== stage.resumeFrom) continue;
    if (snapshot.status !== "completed" || snapshot.outcomeStatus !== "complete") continue;
    if (latest === null || snapshot.executionOrder > latest.executionOrder) latest = snapshot;
  }
  if (latest === null) {
    throw new ConfigurationError(
      `Stage ${stageId} resumes ${stage.resumeFrom}, which has no completed execution.`,
    );
  }
  return latest.executionId;
}

function loadDispatchTarget(
  workspace: string,
  request: StageDispatchRequest,
): { workflow: WorkflowDocument; target: StageTarget } {
  const sessionId = request.sessionId ?? null;
  const override = { provider: request.provider, model: request.model, options: request.options };
  if (sessionId) {
    const freeze = readWorkflowFreeze(path.join(workspace, ".migent", "sessions", sessionId));
    if (freeze) {
      return { workflow: freeze.workflow, target: frozenStageTarget(freeze, request.stageId, override) };
    }
  }
  const workflow = loadNamedWorkflow(workspace, request.workflowId);
  return {
    workflow,
    target: resolveStageTarget(workspace, workflow.id, request.stageId, override),
  };
}

function resultFromRun(result: RunResult, sessionId: string): StageDispatchResult {
  return new StageDispatchResult(
    result.session_id || sessionId,
    result.execution_id || "",
    result.outcome_status || "",
    result.outcome_decision || "",
    result.session_status || "",
    result.response || "",
    result.agent_id || "",
    isRecord(result.options) ? stringOptions(result.options) : {},
    result.artifact_directory || "",
    result.failure_reason || "",
    result.failure_kind || "",
    result.reset_at || "",
    result.provider || "",
  );
}
