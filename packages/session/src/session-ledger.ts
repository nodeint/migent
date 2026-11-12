import path from 'node:path';

import type { SessionStatusInput } from '@nodeint/migent-kernel';
import {
  type ExecutionSnapshot,
  isArtifactSchema,
  publishOutputFiles,
  resolveArtifactSources,
  selectSourceExecution,
  sessionStatusAfterExecution,
  shouldPublishOutputs,
} from '@nodeint/migent-kernel';
import { currentCompleteByStage, missingOutputNames, readyOutsideStoppedBranches, version2GraphQuiet } from '@nodeint/migent-kernel';
import { StageOutcome } from '@nodeint/migent-kernel';
import { foldStoppedStatus, hasTerminalFields, isManifestMirrored, isSessionStop } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';
import { isWorkflowV2, type WorkflowDocument } from '@nodeint/migent-workflow';

import { MANIFEST_SCHEMA_EVENT_LOG } from './constants.js';
import { sessionChangeReason } from './session-events.js';

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
export function sessionStatusForExecution(input: SessionStatusInput): string {
  return sessionStatusAfterExecution(input);
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
  if (latest.some((execution) => execution.status === 'running')) return 'active';
  const statuses = latest.map((execution) => sessionStatusForExecution({
    executionStatus: execution.status,
    outcome: execution.outcome,
    previousStatus,
    workflow,
    stageId: execution.stageId,
  }));
  const stopped = foldStoppedStatus(statuses);
  if (stopped !== null) {
    return hasStartableOutsideStops({ executions, latest }, previousStatus, workflow) ? 'active' : stopped;
  }
  const sessionStop = sessionStopStatus(statuses);
  if (sessionStop !== null) return sessionStop;
  if (workflow !== null && isWorkflowV2(workflow)) {
    return version2CompletionStatus(executions, previousStatus, workflow);
  }
  return statuses.includes('completed') ? 'completed' : 'active';
}

/** The session-stop status among `statuses`, or null. */
function sessionStopStatus(statuses: readonly string[]): string | null {
  return statuses.find(isSessionStop) ?? null;
}

/** Version 2: a stop does not hold the session while another branch can still start. */
function hasStartableOutsideStops(
  rows: { executions: readonly StatusExecution[]; latest: readonly StatusExecution[] },
  previousStatus: Readonly<Record<string, unknown>>,
  workflow: WorkflowDocument | null,
): boolean {
  const { executions, latest } = rows;
  if (workflow === null || !isWorkflowV2(workflow)) return false;
  const snapshots = snapshotsFromStatus(executions);
  return readyOutsideStoppedBranches(workflow, snapshots, {
    sessionStatus: 'active',
    revisionBaselines: revisionBaselinesFrom(previousStatus),
  }).some((stageId) => stageCanStart(latest, stageId));
}

/** A failed stage stays stopped until continue writes `from: failed` for that execution. */
function stageCanStart(latest: readonly StatusExecution[], stageId: string): boolean {
  const row = latest.find((execution) => execution.stageId === stageId);
  return row === undefined || (row.status !== 'cancelled' && row.status !== 'failed');
}

function version2CompletionStatus(
  executions: readonly StatusExecution[],
  previousStatus: Readonly<Record<string, unknown>>,
  workflow: WorkflowDocument,
): string {
  const snapshots = snapshotsFromStatus(executions);
  const sessionStatus = typeof previousStatus.status === 'string' ? previousStatus.status : 'active';
  // Quiescence, not one stage's decision. A missing output keeps the session active.
  if (!version2GraphQuiet(workflow, snapshots, sessionStatus)) return 'active';
  if (missingOutputNames(workflow, snapshots).length > 0) return 'active';
  return 'completed';
}

/** Latest blocked execution of each stage, lowest execution order first. */
export function blockedExecutions(
  executions: readonly StatusExecution[],
  previousStatus: Readonly<Record<string, unknown>>,
  workflow: WorkflowDocument | null,
): StatusExecution[] {
  return latestPerStage(executions)
    .filter((execution) => execution.status !== 'running')
    .filter(
      (execution) =>
        sessionStatusForExecution({
          executionStatus: execution.status,
          outcome: execution.outcome,
          previousStatus,
          workflow,
          stageId: execution.stageId,
        }) === 'blocked',
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
        : new StageOutcome(snapshot.outcomeStatus, { decision: snapshot.outcomeDecision }),
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
  const previousSessionStatus = typeof input.previousStatus.status === 'string' ? input.previousStatus.status : '';
  return {
    sessionStatus,
    outputs: published.outputs,
    outputsMissing: published.outputsMissing,
    sessionEvent:
      sessionStatus === previousSessionStatus
        ? null
        : sessionEventFor(
          { sessionStatus, previousSessionStatus },
          { outcome: input.outcome, storedError: input.storedError },
        ),
    manifestStatus: manifestLine(
      { schemaVersion: input.schemaVersion, manifestStatus: input.manifestStatus },
      { executionStatus: input.executionStatus, previousSessionStatus, sessionStatus },
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
  const {decision} = outcome;
  return typeof decision === 'string' && decision !== '' ? decision : null;
}

/** A stopped execution that names the terminal state of the session. */
export interface TerminalSource {
  executionId: string;
  stageId: string;
  blocker: string | null;
}

/** What the terminal keys are derived from: the deciding execution, the reason, and every blocked execution. */
export interface TerminalContext {
  readonly source: TerminalSource | null;
  readonly reason: string | null;
  readonly blocked?: readonly TerminalSource[];
}

/**
 * The terminal keys a session status calls for, in the order they are written to `status.json`.
 * Only blocked, completed, and cancelled sessions have any.
 */
export function terminalFields(
  sessionStatus: string,
  terminal: TerminalContext,
): Record<string, unknown> {
  const { source, reason, blocked = [] } = terminal;
  if (!hasTerminalFields(sessionStatus)) return {};
  const fallbackRows = source ? [source] : [];
  const rows = blocked.length > 0 ? blocked : fallbackRows;
  const [first] = rows;
  if (first === undefined) return sessionStatus === 'blocked' && reason ? { blocker: reason } : {};
  const fields: Record<string, unknown> = { terminal_execution_id: source?.executionId ?? first.executionId };
  if (sessionStatus === 'blocked') Object.assign(fields, blockedFields(rows, first, source?.blocker || reason));
  return fields;
}

function blockedFields(
  rows: readonly TerminalSource[],
  first: TerminalSource,
  fallbackBlocker: string | null | undefined,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    blocked_by_execution_id: first.executionId,
    blocked_by_execution_ids: rows.map((row) => row.executionId),
    blocked_by_stage_id: first.stageId,
  };
  const blocker = first.blocker || fallbackBlocker;
  if (blocker) fields.blocker = blocker;
  return fields;
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
  if (input.executionStatus === 'running' || input.workflow === null) return { outputs: [], outputsMissing: [] };
  if (isWorkflowV2(input.workflow)) return publishVersion2({ ...input, workflow: input.workflow });
  const workflowId = input.previousStatus.workflow_id;
  if (
    !shouldPublishOutputs({
      workflowId: typeof workflowId === 'string' ? workflowId : null,
      executionStatus: input.executionStatus,
      outcome: input.outcome,
      workflow: input.workflow,
      stageId: input.stageId,
    })
  ) {
    return { outputs: [], outputsMissing: [] };
  }
  const {completion} = input.workflow;
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
    input.executionStatus === 'completed' && input.outcome !== null && input.outcome.status === 'complete';
  if (!completedStage && input.executionStatus !== 'skipped') {
    return { outputs: [], outputsMissing: [] };
  }
  const sessionStatus = typeof input.previousStatus.status === 'string' ? input.previousStatus.status : 'active';
  if (!version2GraphQuiet(input.workflow, input.snapshots, sessionStatus)) {
    return { outputs: [], outputsMissing: [] };
  }
  const missing = missingOutputNames(input.workflow, input.snapshots);
  if (missing.length > 0) return { outputs: [], outputsMissing: missing };
  const sources: Record<string, readonly [string, string]> = {};
  if (isArtifactSchema(input.workflow)) {
    const current = currentCompleteByStage(input.workflow, input.snapshots);
    for (const item of resolveArtifactSources(input.workflow, current)) {
      if (item.source === null) continue;
      sources[item.name] = [path.join(item.source.artifactDirectory, item.file), item.source.executionId];
    }
    return { outputs: publishedOutputs(input.sessionDirectory, sources, input.executionId), outputsMissing: [] };
  }
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
    if (typeof value === 'number') baselines[key] = value;
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
    artifactDirectory: execution.artifactDirectory ?? '',
    outcomeDecision: execution.outcome?.decision || null,
    failureReason: execution.failureReason ?? null,
  }));
}

function sessionEventFor(
  change: { sessionStatus: string; previousSessionStatus: string },
  result: { outcome: StageOutcome | null; storedError: string | null },
): LedgerSessionEvent {
  const { sessionStatus } = change;
  const { outcome, storedError } = result;
  const reason = sessionChangeReason(sessionStatus, outcome, storedError);
  const data: Record<string, unknown> = { from: change.previousSessionStatus || null };
  if (reason !== null) data.reason = reason;
  if (outcome !== null) data.outcome = outcome.toJson();
  return { data, outcomeTopLevel: outcome ? outcome.toJson() : null };
}

function manifestLine(
  manifest: { schemaVersion: number; manifestStatus: string | null },
  change: { executionStatus: string; previousSessionStatus: string; sessionStatus: string },
): string | null {
  const { schemaVersion, manifestStatus } = manifest;
  const { executionStatus, previousSessionStatus, sessionStatus } = change;
  if (schemaVersion >= MANIFEST_SCHEMA_EVENT_LOG || manifestStatus === null) return null;
  let desired: string | null = null;
  if (executionStatus === 'running' && previousSessionStatus === 'completed') desired = 'running';
  if (sessionStatus !== previousSessionStatus && isManifestMirrored(sessionStatus)) desired = sessionStatus;
  if (desired === null || desired === manifestStatus) return null;
  return desired;
}
