import { AgentToolRunner, type RunResult } from "./agent-runner.js";
import { resolveStageTarget } from "./config.js";
import { ConfigurationError } from "./errors.js";
import { isRecord } from "./record.js";
import { bindPriorSessionId, createWorkflowSession } from "./session-records.js";
import { stageDispatchError } from "./selection.js";
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
  ) {}

  toJson(): Record<string, unknown> {
    return {
      agent_id: this.agentId,
      options: { ...this.options },
      session_id: this.sessionId,
      execution_id: this.executionId,
      artifact_directory: this.artifactDirectory,
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
): Promise<StageDispatchResult> {
  const workflow = loadNamedWorkflow(workspace, request.workflowId);
  const workflowId = workflow.id;
  const target = resolveStageTarget(workspace, workflowId, request.stageId, {
    provider: request.provider,
    model: request.model,
    options: request.options,
  });
  let sessionId = request.sessionId ?? null;
  if (sessionId === null) {
    if (!request.task) throw new ConfigurationError("The first workflow stage requires --task.");
    sessionId = createWorkflowSession(workspace, workflowId, request.task, request.priorSessionId);
  } else {
    bindPriorSessionId(workspace, sessionId, request.priorSessionId);
  }
  assertStageDispatchable(workspace, workflow, sessionId, request.stageId);
  const resumeExecutionId = resolveResumeExecution(workspace, workflow, sessionId, request.stageId);
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
  });
  return resultFromRun(result, sessionId);
}

export function assertStageDispatchable(
  workspace: string,
  workflow: WorkflowDocument,
  sessionId: string,
  stageId: string,
): void {
  const snapshots = new SessionStore(workspace).executionSnapshots(sessionId);
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
  );
}
