import path from "node:path";
import {
  publishOutputFiles,
  selectSourceExecution,
  sessionStatusAfterExecution,
  shouldPublishOutputs,
  type ExecutionSnapshot,
} from "./outputs.js";
import { sessionChangeReason } from "./session-events.js";
import { StageOutcome } from "./stage-outcome.js";
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

/** One execution, as the per-stage reduction sees it. */
export interface StatusExecution {
  executionId: string;
  stageId: string;
  executionOrder: number;
  status: string;
  outcome: StageOutcome | null;
}

/** Session status for one execution. The session status is the reduction over each stage's latest. */
export function sessionStatusForExecution(
  executionStatus: string,
  outcome: StageOutcome | null,
  previousStatus: Readonly<Record<string, unknown>>,
  workflow: WorkflowDocument | null,
  stageId: string,
): string {
  return sessionStatusAfterExecution(executionStatus, outcome, previousStatus, workflow, stageId);
}

/** Latest execution of each stage. A higher order wins; an equal order keeps the later id. */
export function latestPerStage(executions: readonly StatusExecution[]): StatusExecution[] {
  const byStage = new Map<string, StatusExecution>();
  for (const execution of executions) {
    const current = byStage.get(execution.stageId);
    if (current === undefined || laterStatusExecution(execution, current)) byStage.set(execution.stageId, execution);
  }
  return [...byStage.values()];
}

/**
 * Decision 8 for version 1. Older executions of a stage are ignored.
 * Any running latest execution wins, then blocked, cancelled, and completion.
 */
export function sessionStatusFromExecutions(
  executions: readonly StatusExecution[],
  previousStatus: Readonly<Record<string, unknown>>,
  workflow: WorkflowDocument | null,
): string {
  const latest = latestPerStage(executions);
  if (latest.some((execution) => execution.status === "running")) return "active";
  let cancelled = false;
  let completed = false;
  for (const execution of latest) {
    const status = sessionStatusForExecution(
      execution.status,
      execution.outcome,
      previousStatus,
      workflow,
      execution.stageId,
    );
    if (status === "blocked") return "blocked";
    if (status === "cancelled") cancelled = true;
    else if (status === "completed") completed = true;
  }
  if (cancelled) return "cancelled";
  if (completed) return "completed";
  return "active";
}

/** Latest blocked execution of each stage, lowest execution order first. */
export function blockedExecutions(
  executions: readonly StatusExecution[],
  previousStatus: Readonly<Record<string, unknown>>,
  workflow: WorkflowDocument | null,
): StatusExecution[] {
  return latestPerStage(executions)
    .filter((execution) => execution.status !== "running")
    .filter(
      (execution) =>
        sessionStatusForExecution(
          execution.status,
          execution.outcome,
          previousStatus,
          workflow,
          execution.stageId,
        ) === "blocked",
    )
    .sort(compareStatusExecutions);
}

export function statusExecutionsFromSnapshots(snapshots: readonly ExecutionSnapshot[]): StatusExecution[] {
  return snapshots.map((snapshot) => ({
    executionId: snapshot.executionId,
    stageId: snapshot.stageId,
    executionOrder: snapshot.executionOrder,
    status: snapshot.status,
    outcome:
      snapshot.outcomeStatus === null
        ? null
        : new StageOutcome(snapshot.outcomeStatus, null, snapshot.outcomeDecision),
  }));
}

/**
 * Publish, when this save publishes, and describe the events and manifest line.
 * The snapshot list includes this save. Output sources stay executions ordered strictly below it.
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
  const sessionStatus = sessionStatusFromExecutions(
    statusExecutionsFromSnapshots(input.snapshots),
    input.previousStatus,
    input.workflow,
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
  blocked: readonly { executionId: string; stageId: string; blocker: string | null }[] = [],
): void {
  delete status.terminal_execution_id;
  delete status.blocked_by_execution_id;
  delete status.blocked_by_execution_ids;
  delete status.blocked_by_stage_id;
  delete status.blocker;
  if (sessionStatus !== "blocked" && sessionStatus !== "completed" && sessionStatus !== "cancelled") return;
  const rows = blocked.length > 0 ? blocked : source ? [source] : [];
  if (rows.length === 0) {
    if (sessionStatus === "blocked" && reason) status.blocker = reason;
    return;
  }
  const first = rows[0]!;
  status.terminal_execution_id = source?.executionId ?? first.executionId;
  if (sessionStatus === "blocked") {
    status.blocked_by_execution_id = first.executionId;
    status.blocked_by_execution_ids = rows.map((row) => row.executionId);
    status.blocked_by_stage_id = first.stageId;
    const blocker = first.blocker || source?.blocker || reason;
    if (blocker) status.blocker = blocker;
  }
}

function laterStatusExecution(candidate: StatusExecution, current: StatusExecution): boolean {
  if (candidate.executionOrder !== current.executionOrder) return candidate.executionOrder > current.executionOrder;
  return candidate.executionId > current.executionId;
}

function compareStatusExecutions(left: StatusExecution, right: StatusExecution): number {
  if (left.executionOrder !== right.executionOrder) return left.executionOrder - right.executionOrder;
  if (left.executionId < right.executionId) return -1;
  if (left.executionId > right.executionId) return 1;
  return 0;
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
