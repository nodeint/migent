import path from "node:path";
import {
  publishOutputFiles,
  selectSourceExecution,
  sessionStatusAfterExecution,
  shouldPublishOutputs,
  type ExecutionSnapshot,
} from "./outputs.js";
import { sessionChangeReason } from "./session-events.js";
import type { StageOutcome } from "./stage-outcome.js";
import type { WorkflowDocument } from "./workflow.js";

export interface LedgerOutput {
  name: string;
  path: string;
  source_execution_id: string;
  published_by_execution_id: string;
}

export interface LedgerSessionEvent {
  data: Record<string, unknown>;
  outcomeTopLevel: Record<string, unknown> | null;
}

export interface PlannedExecutionSave {
  sessionStatus: string;
  outputs: LedgerOutput[];
  sessionEvent: LedgerSessionEvent | null;
  /** v1 manifest line to write. Null leaves the file untouched. */
  manifestStatus: string | null;
}

/** Session status for one save. Schema 2 stores this on the execution event and trusts it. */
export function sessionStatusForExecution(
  executionStatus: string,
  outcome: StageOutcome | null,
  previousStatus: Readonly<Record<string, unknown>>,
  workflow: WorkflowDocument | null,
  stageId: string,
): string {
  return sessionStatusAfterExecution(executionStatus, outcome, previousStatus, workflow, stageId);
}

/**
 * Publish, when this save publishes, and describe the events and manifest line.
 * Call before `execution.json` is written. Sources are executions ordered strictly below this one.
 */
export function planExecutionSave(input: {
  executionStatus: string;
  outcome: StageOutcome | null;
  storedError: string | null;
  stageId: string;
  executionOrder: number;
  executionId: string;
  sessionDirectory: string;
  previousStatus: Record<string, unknown>;
  workflow: WorkflowDocument | null;
  schemaVersion: number;
  manifestStatus: string | null;
  snapshots: readonly ExecutionSnapshot[];
}): PlannedExecutionSave {
  const sessionStatus = sessionStatusForExecution(
    input.executionStatus,
    input.outcome,
    input.previousStatus,
    input.workflow,
    input.stageId,
  );
  const outputs = publishForSave(input);
  const previousSessionStatus = typeof input.previousStatus.status === "string" ? input.previousStatus.status : "";
  return {
    sessionStatus,
    outputs,
    sessionEvent:
      sessionStatus === previousSessionStatus
        ? null
        : sessionEventFor(sessionStatus, previousSessionStatus, input.outcome, input.storedError),
    manifestStatus: manifestLine(
      input.schemaVersion,
      input.manifestStatus,
      input.executionStatus,
      previousSessionStatus,
      sessionStatus,
    ),
  };
}

/** Highest-order decision among seen executions. A tie keeps the later row. */
export function latestDecision(
  rows: readonly { order: number; outcome: Record<string, unknown> | null }[],
): string | null {
  let bestOrder = -1;
  let decision: string | null = null;
  for (const row of rows) {
    const found = decisionOfOutcome(row.outcome);
    if (found === null || row.order < bestOrder) continue;
    bestOrder = row.order;
    decision = found;
  }
  return decision;
}

export function decisionOfOutcome(outcome: Record<string, unknown> | null): string | null {
  if (outcome === null) return null;
  const decision = outcome.decision;
  return typeof decision === "string" && decision !== "" ? decision : null;
}

export function recordLatestDecision(status: Record<string, unknown>, decision: string | null): void {
  if (decision) status.latest_decision = decision;
}

export function applyTerminalFields(
  status: Record<string, unknown>,
  sessionStatus: string,
  source: { executionId: string; stageId: string; blocker: string | null } | null,
  reason: string | null,
): void {
  delete status.terminal_execution_id;
  delete status.blocked_by_execution_id;
  delete status.blocked_by_stage_id;
  delete status.blocker;
  if (sessionStatus !== "blocked" && sessionStatus !== "completed" && sessionStatus !== "cancelled") return;
  if (source === null) {
    if (sessionStatus === "blocked" && reason) status.blocker = reason;
    return;
  }
  status.terminal_execution_id = source.executionId;
  if (sessionStatus === "blocked") {
    status.blocked_by_execution_id = source.executionId;
    status.blocked_by_stage_id = source.stageId;
    if (source.blocker) status.blocker = source.blocker;
    else if (reason) status.blocker = reason;
  }
}

function publishForSave(input: {
  executionStatus: string;
  outcome: StageOutcome | null;
  stageId: string;
  executionOrder: number;
  executionId: string;
  sessionDirectory: string;
  previousStatus: Record<string, unknown>;
  workflow: WorkflowDocument | null;
  snapshots: readonly ExecutionSnapshot[];
}): LedgerOutput[] {
  if (input.executionStatus === "running" || input.workflow === null) return [];
  const workflowId = input.previousStatus.workflow_id;
  if (
    !shouldPublishOutputs({
      workflowId: typeof workflowId === "string" ? workflowId : null,
      executionStatus: input.executionStatus,
      outcome: input.outcome,
      workflow: input.workflow,
      stageId: input.stageId,
    })
  ) {
    return [];
  }
  const completion = input.workflow.completion;
  if (completion === null) return [];
  const sources: Record<string, readonly [string, string]> = {};
  for (const output of completion.outputs) {
    const source = selectSourceExecution(input.snapshots, output.fromStage, input.executionOrder);
    if (source === null) continue;
    sources[output.name] = [path.join(source.artifactDirectory, output.artifact), source.executionId];
  }
  return Object.entries(publishOutputFiles(input.sessionDirectory, sources, input.executionId)).map(
    ([name, output]) => ({
      name,
      path: output.path,
      source_execution_id: output.sourceExecutionId,
      published_by_execution_id: output.publishedByExecutionId,
    }),
  );
}

function sessionEventFor(
  sessionStatus: string,
  previousSessionStatus: string,
  outcome: StageOutcome | null,
  storedError: string | null,
): LedgerSessionEvent {
  const reason = sessionChangeReason(sessionStatus, outcome, storedError);
  const data: Record<string, unknown> = { from: previousSessionStatus || null };
  if (reason !== null) data.reason = reason;
  if (outcome !== null) data.outcome = outcome.toJson();
  return { data, outcomeTopLevel: outcome ? outcome.toJson() : null };
}

function manifestLine(
  schemaVersion: number,
  manifestStatus: string | null,
  executionStatus: string,
  previousSessionStatus: string,
  sessionStatus: string,
): string | null {
  if (schemaVersion >= 2 || manifestStatus === null) return null;
  let desired: string | null = null;
  if (executionStatus === "running" && previousSessionStatus === "completed") desired = "running";
  if (
    sessionStatus !== previousSessionStatus &&
    (sessionStatus === "completed" || sessionStatus === "blocked" || sessionStatus === "cancelled")
  ) {
    desired = sessionStatus;
  }
  if (desired === null || desired === manifestStatus) return null;
  return desired;
}
