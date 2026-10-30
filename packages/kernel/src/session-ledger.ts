import path from "node:path";
import {
  missingWorkflowOutputNames,
  publishOutputFiles,
  selectSourceExecution,
  sessionStatusAfterExecution,
  shouldPublishOutputs,
  type ExecutionSnapshot,
} from "./outputs.js";
import { isRecord } from "./record.js";
import { sessionChangeReason } from "./session-events.js";
import { readyOutsideStoppedBranches, version2GraphQuiet } from "./selection.js";
import { StageOutcome } from "./stage-outcome.js";
import { isWorkflowV2, type WorkflowDocument } from "./workflow.js";

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
  /** Version 2 names that are missing when this save would otherwise complete the session. */
  outputsMissing: string[];
}

/** One execution, as the per-stage reduction sees it. */
export interface StatusExecution {
  executionId: string;
  stageId: string;
  executionOrder: number;
  status: string;
  outcome: StageOutcome | null;
  artifactDirectory?: string;
  failureReason?: string | null;
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

/** Version 1 reduces each stage; version 2 replaces that completion arm with quiescence. */
export function sessionStatusFromExecutions(
  executions: readonly StatusExecution[],
  previousStatus: Readonly<Record<string, unknown>>,
  workflow: WorkflowDocument | null,
): string {
  const latest = latestPerStage(executions);
  if (latest.some((execution) => execution.status === "running")) return "active";
  let cancelled = false;
  let stopped: "blocked" | "question" | null = null;
  let completed = false;
  for (const execution of latest) {
    const status = sessionStatusForExecution(
      execution.status,
      execution.outcome,
      previousStatus,
      workflow,
      execution.stageId,
    );
    if (status === "blocked" || status === "question") {
      if (workflow !== null && isWorkflowV2(workflow)) {
        const snapshots = snapshotsFromStatus(executions);
        const startable = readyOutsideStoppedBranches(
          workflow,
          snapshots,
          "active",
          revisionBaselinesFrom(previousStatus),
        ).filter((stageId) => {
          const row = latest.find((execution) => execution.stageId === stageId);
          // A failed stage stays stopped until continue writes `from: failed` for that execution.
          return row === undefined || (row.status !== "cancelled" && row.status !== "failed");
        });
        if (startable.length > 0) return "active";
      }
      if (status === "blocked" || stopped === null) stopped = status;
    }
    if (status === "cancelled") cancelled = true;
    else if (status === "completed") completed = true;
  }
  if (stopped !== null) return stopped;
  if (cancelled) return "cancelled";
  if (workflow !== null && isWorkflowV2(workflow)) {
    const snapshots = snapshotsFromStatus(executions);
    const sessionStatus = typeof previousStatus.status === "string" ? previousStatus.status : "active";
    // Quiescence, not one stage's decision. A missing output keeps the session active.
    if (!version2GraphQuiet(workflow, snapshots, sessionStatus)) return "active";
    if (missingWorkflowOutputNames(workflow, snapshots).length > 0) return "active";
    return "completed";
  }
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
    artifactDirectory: snapshot.artifactDirectory,
    failureReason: snapshot.failureReason ?? null,
  }));
}

/**
 * Publish, when this save publishes, and describe the events and manifest line.
 * The snapshot list includes this save. Version 1 output sources stay executions ordered strictly below it.
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
  const published = publishForSave(input);
  const previousSessionStatus = typeof input.previousStatus.status === "string" ? input.previousStatus.status : "";
  return {
    sessionStatus,
    outputs: published.outputs,
    outputsMissing: published.outputsMissing,
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
}): { outputs: LedgerOutput[]; outputsMissing: string[] } {
  if (input.executionStatus === "running" || input.workflow === null) return { outputs: [], outputsMissing: [] };
  if (isWorkflowV2(input.workflow)) return publishVersion2({ ...input, workflow: input.workflow });
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
    return { outputs: [], outputsMissing: [] };
  }
  const completion = input.workflow.completion;
  if (completion === null) return { outputs: [], outputsMissing: [] };
  const sources: Record<string, readonly [string, string]> = {};
  for (const output of completion.outputs) {
    const source = selectSourceExecution(input.snapshots, output.fromStage, input.executionOrder);
    if (source === null) continue;
    sources[output.name] = [path.join(source.artifactDirectory, output.artifact), source.executionId];
  }
  return { outputs: publishedOutputs(input.sessionDirectory, sources, input.executionId), outputsMissing: [] };
}

function publishVersion2(input: {
  executionStatus: string;
  outcome: StageOutcome | null;
  executionId: string;
  sessionDirectory: string;
  previousStatus: Record<string, unknown>;
  workflow: WorkflowDocument;
  snapshots: readonly ExecutionSnapshot[];
}): { outputs: LedgerOutput[]; outputsMissing: string[] } {
  const completedStage =
    input.executionStatus === "completed" && input.outcome !== null && input.outcome.status === "complete";
  if (!completedStage && input.executionStatus !== "skipped") {
    return { outputs: [], outputsMissing: [] };
  }
  const sessionStatus = typeof input.previousStatus.status === "string" ? input.previousStatus.status : "active";
  if (!version2GraphQuiet(input.workflow, input.snapshots, sessionStatus)) {
    return { outputs: [], outputsMissing: [] };
  }
  const missing = missingWorkflowOutputNames(input.workflow, input.snapshots);
  if (missing.length > 0) return { outputs: [], outputsMissing: missing };
  const sources: Record<string, readonly [string, string]> = {};
  for (const output of input.workflow.outputs ?? []) {
    const source = selectSourceExecution(input.snapshots, output.fromStage, Number.POSITIVE_INFINITY);
    if (source === null) continue;
    sources[output.name] = [path.join(source.artifactDirectory, output.artifact), source.executionId];
  }
  return {
    outputs: publishedOutputs(input.sessionDirectory, sources, input.executionId),
    outputsMissing: [],
  };
}

function publishedOutputs(
  sessionDirectory: string,
  sources: Readonly<Record<string, readonly [string, string]>>,
  executionId: string,
): LedgerOutput[] {
  return Object.entries(publishOutputFiles(sessionDirectory, sources, executionId)).map(([name, output]) => ({
    name,
    path: output.path,
    source_execution_id: output.sourceExecutionId,
    published_by_execution_id: output.publishedByExecutionId,
  }));
}

function revisionBaselinesFrom(previousStatus: Readonly<Record<string, unknown>>): Record<string, number> | null {
  const raw = previousStatus.revision_baselines;
  if (!isRecord(raw)) return null;
  const baselines: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number") baselines[key] = value;
  }
  return baselines;
}

function snapshotsFromStatus(executions: readonly StatusExecution[]): ExecutionSnapshot[] {
  return executions.map((execution) => ({
    executionId: execution.executionId,
    stageId: execution.stageId,
    executionOrder: execution.executionOrder,
    status: execution.status,
    outcomeStatus: execution.outcome?.status ?? null,
    artifactDirectory: execution.artifactDirectory ?? "",
    outcomeDecision: execution.outcome?.decision || null,
    failureReason: execution.failureReason ?? null,
  }));
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
    (sessionStatus === "completed" || sessionStatus === "blocked" || sessionStatus === "question" || sessionStatus === "cancelled")
  ) {
    desired = sessionStatus;
  }
  if (desired === null || desired === manifestStatus) return null;
  return desired;
}
