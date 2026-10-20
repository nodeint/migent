import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isAtomicTempName, writeJsonAtomic } from "./atomic-file.js";
import { ConfigurationError } from "./errors.js";
import {
  applyTerminalFields,
  blockedExecutions,
  decisionOfOutcome,
  latestDecision,
  recordLatestDecision,
  sessionStatusFromExecutions,
  type StatusExecution,
} from "./session-ledger.js";
import { readStatusFileState, type StatusFileState } from "./query.js";
import { isRecord } from "./record.js";
import { EXECUTIONS_DIRNAME } from "./runtime.js";
import {
  parseExecutionId,
  readParsedEvents,
  skipsStatusWrite,
  type ParsedEvent,
} from "./session-events.js";
import { loadFrozenWorkflow } from "./session-freeze.js";
import { StageOutcome } from "./stage-outcome.js";
import { loadNamedWorkflow, loadWorkflowDocument, type WorkflowDocument } from "./workflow.js";
import { parseYamlDocument } from "./yaml.js";

export interface SessionManifest {
  sessionId: string;
  workflowId: string | null;
  workflowPath: string | null;
  role: string | null;
  task: string | null;
  createdAt: string | null;
  priorSessionId: string | null;
  manifestStatus: string | null;
  schemaVersion: number;
}

export interface FoldExecution {
  executionId: string;
  executionOrder: number;
  stageId: string;
  stageAttempt: number;
  provider: string;
  model: string;
  resumesExecutionId: string | null;
  status: string;
  outcome: Record<string, unknown> | null;
  error: string | null;
  failureReason: string | null;
  createdAt: string | null;
  completedAt: string | null;
}

export interface FoldInputs {
  schemaVersion: number;
  manifest: SessionManifest;
  events: readonly ParsedEvent[];
  executions: readonly FoldExecution[];
  /** Present execution ids. An `execution.started` whose file is absent is not in this set. */
  presentExecutionIds: ReadonlySet<string>;
  previousStatus: Record<string, unknown> | null;
  outputFiles: readonly string[];
  workflow: WorkflowDocument | null;
}

/** A missing schema_version is 1. This is not config documentVersion, which maps a missing version to 0. */
export function sessionSchemaVersion(document: Record<string, unknown> | null): number {
  if (document === null || !Object.hasOwn(document, "schema_version") || document.schema_version == null) return 1;
  const raw = document.schema_version;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) return raw;
  if (typeof raw === "string" && /^[1-9][0-9]*$/.test(raw)) return Number(raw);
  return 1;
}

export function foldStatus(inputs: FoldInputs): Record<string, unknown> {
  const status = inputs.schemaVersion >= 2 ? foldSchema2(inputs) : foldV1(inputs);
  addPathOnlyOutputs(status, inputs.outputFiles);
  return status;
}

export function readSessionManifest(sessionDirectory: string): SessionManifest {
  const manifestPath = path.join(sessionDirectory, "manifest.yaml");
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch {
    return emptyManifest(path.basename(sessionDirectory));
  }
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(text);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`Session manifest is corrupt: ${manifestPath}.`);
  }
  if (!isRecord(parsed)) throw new ConfigurationError(`Session manifest is corrupt: ${manifestPath}.`);
  return {
    sessionId: textOr(parsed.session_id) ?? path.basename(sessionDirectory),
    workflowId: textOr(parsed.workflow_id),
    workflowPath: textOr(parsed.workflow_path),
    role: textOr(parsed.role),
    task: textOr(parsed.task),
    createdAt: textOr(parsed.created_at),
    priorSessionId: textOr(parsed.prior_session_id),
    manifestStatus: textOr(parsed.status),
    schemaVersion: sessionSchemaVersion(parsed),
  };
}

export function readFoldedStatus(workspace: string, sessionDirectory: string): Record<string, unknown> {
  return foldStatus(loadFoldInputs(workspace, sessionDirectory));
}

export function commitFoldedStatus(workspace: string, sessionDirectory: string): Record<string, unknown> {
  const folded = readFoldedStatus(workspace, sessionDirectory);
  writeJsonAtomic(path.join(sessionDirectory, "status.json"), folded);
  return folded;
}

/** Schema 2 only. Show prints this on stderr and does not rewrite status.json. */
export function statusDriftMessage(workspace: string, sessionId: string): string | null {
  const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
  const manifest = readSessionManifest(sessionDirectory);
  if (manifest.schemaVersion < 2) return null;
  const read = readStatusFileState(path.join(sessionDirectory, "status.json"));
  if (read.state !== "ok") return null;
  let folded: Record<string, unknown>;
  try {
    folded = readFoldedStatus(workspace, sessionDirectory);
  } catch {
    return null;
  }
  const fields = differingKeys(read.status, folded);
  if (fields.length === 0) return null;
  return `status.json differs from the event fold: ${fields.join(", ")}.`;
}

export function loadFoldInputs(workspace: string, sessionDirectory: string): FoldInputs {
  const manifest = readSessionManifest(sessionDirectory);
  const previous = readStatusFileState(path.join(sessionDirectory, "status.json"));
  const previousStatus = previous.state === "ok" ? previous.status : null;
  const executions = readExecutions(sessionDirectory);
  const identity = statusIdentity(manifest, previousStatus);
  return {
    schemaVersion: manifest.schemaVersion,
    manifest,
    events: readParsedEvents(path.join(sessionDirectory, "events.jsonl")),
    executions,
    presentExecutionIds: new Set(executions.map((execution) => execution.executionId)),
    previousStatus,
    outputFiles: listOutputFiles(sessionDirectory),
    workflow: loadSessionWorkflow(workspace, sessionDirectory, identity),
  };
}

export function statusFileState(sessionDirectory: string): StatusFileState {
  return readStatusFileState(path.join(sessionDirectory, "status.json"));
}

function foldV1(inputs: FoldInputs): Record<string, unknown> {
  const status: Record<string, unknown> = inputs.previousStatus ? cloneRecord(inputs.previousStatus) : {};
  applyManifestIdentity(status, inputs.manifest);
  if (inputs.executions.length === 0) status.status = manifestStatusToSession(inputs.manifest.manifestStatus);
  const noted = new Map<string, RunningStage>();
  let updatedAt = textOr(status.updated_at) ?? inputs.manifest.createdAt;
  for (const event of inputs.events) {
    if (event.v < 2) continue;
    if (event.event === "workflow.refreshed") continue;
    if (applySharedEvent(status, event, noted)) updatedAt = later(updatedAt, event.timestamp);
  }
  updatedAt = publishExecutionStatus(status, inputs, updatedAt);
  publishRunningStages(status, noted, inputs.executions);
  if (updatedAt) status.updated_at = updatedAt;
  return status;
}

interface SeenExecution {
  order: number;
  stageId: string;
  status: string;
  outcome: Record<string, unknown> | null;
  sessionStatus: string | null;
}

function foldSchema2(inputs: FoldInputs): Record<string, unknown> {
  const status = initialStatus(inputs.manifest, inputs.schemaVersion);
  const seen = new Map<string, SeenExecution>();
  const noted = new Map<string, RunningStage>();
  let updatedAt = inputs.manifest.createdAt;
  for (const event of inputs.events) {
    if (event.event === "workflow.refreshed") continue;
    if (event.executionId && !inputs.presentExecutionIds.has(event.executionId) && isExecutionScoped(event.event)) {
      continue;
    }
    const applied = applySharedEvent(status, event, noted) || applySchema2Execution(status, event, seen);
    if (applied) updatedAt = later(updatedAt, event.timestamp);
  }
  // Reconcile appends missing events at the end of the file. Latest is the highest order, not the last line.
  publishLatestExecution(status, seen);
  updatedAt = publishExecutionStatus(status, inputs, updatedAt);
  publishRunningStages(status, noted, inputs.executions);
  if (updatedAt) status.updated_at = updatedAt;
  return status;
}

interface RunningStage {
  execution_id: string | null;
  stage_id: string | null;
  provider: unknown;
  event: string;
  summary: string | null;
  updated_at: string | null;
}

function applySharedEvent(
  status: Record<string, unknown>,
  event: ParsedEvent,
  noted: Map<string, RunningStage>,
): boolean {
  if (event.event === "workflow.refreshed") return false;
  if (event.event === "session.created") {
    if (event.data.prepared === true) {
      status.status = "prepared";
      return true;
    }
    return false;
  }
  if (event.event === "task.frozen") {
    const hash = textOr(event.data.sha256);
    if (hash) status.task_sha256 = hash;
    return true;
  }
  if (event.event === "revisions.reset") {
    if (isRecord(event.data.baselines)) status.revision_baselines = cloneRecord(event.data.baselines);
    return true;
  }
  if (event.event === "outputs.published") {
    mergePublished(status, event.data.outputs);
    return true;
  }
  if (event.event === "session.activated") {
    status.status = "active";
    return true;
  }
  if (event.event.startsWith("provider.") || event.event.startsWith("verify.")) {
    if (skipsStatusWrite(event.event)) return false;
    status.latest_provider_event = event.raw;
    if (event.executionId) {
      noted.set(event.executionId, {
        execution_id: event.executionId,
        stage_id: event.stageId,
        provider: event.raw.provider ?? null,
        event: event.event,
        summary: event.summary,
        updated_at: event.timestamp,
      });
    }
    return true;
  }
  return false;
}

function applySchema2Execution(
  status: Record<string, unknown>,
  event: ParsedEvent,
  seen: Map<string, SeenExecution>,
): boolean {
  if (event.event === "workflow.refreshed") return false;
  if (!event.executionId) {
    if (event.event.startsWith("session.") && event.event !== "session.created" && event.event !== "session.activated") {
      status.status = event.event.slice("session.".length);
      applyTerminalFields(status, event.event.slice("session.".length), null, textOr(event.data.reason));
      return true;
    }
    return false;
  }
  if (event.event === "execution.started") {
    const current = seen.get(event.executionId);
    const order = Math.max(current?.order ?? 0, eventExecutionOrder(event));
    if (current && current.status !== "running") {
      current.order = order;
      if (event.stageId) current.stageId = event.stageId;
      return true;
    }
    seen.set(event.executionId, {
      order,
      stageId: event.stageId ?? current?.stageId ?? "",
      status: "running",
      outcome: null,
      sessionStatus: current?.sessionStatus ?? null,
    });
    return true;
  }
  if (event.event.startsWith("execution.")) {
    const executionStatus = event.event.slice("execution.".length);
    const current = seen.get(event.executionId) ?? {
      order: 0,
      stageId: event.stageId ?? "",
      status: executionStatus,
      outcome: null,
      sessionStatus: null,
    };
    current.status = executionStatus;
    current.outcome = isRecord(event.data.outcome) ? event.data.outcome : null;
    current.order = Math.max(current.order, eventExecutionOrder(event));
    if (event.stageId) current.stageId = event.stageId;
    const sessionStatus = textOr(event.data.session_status);
    if (sessionStatus) current.sessionStatus = sessionStatus;
    seen.set(event.executionId, current);
    return true;
  }
  if (event.event.startsWith("stage.")) {
    const outcome = outcomeRecord(event);
    return decisionOf(outcome) !== null;
  }
  if (event.event.startsWith("session.") && event.event !== "session.created") {
    const sessionStatus = event.event.slice("session.".length);
    const current = seen.get(event.executionId);
    if (current) current.sessionStatus = sessionStatus;
    return true;
  }
  return false;
}

function publishLatestExecution(status: Record<string, unknown>, seen: ReadonlyMap<string, SeenExecution>): void {
  const latestId = latestSeenId(seen);
  if (latestId === null) return;
  const latest = seen.get(latestId);
  if (!latest) return;
  noteLatest(status, latestId, latest.status, latest.stageId);
  recordLatestDecision(
    status,
    latestDecision([...seen.values()].map((row) => ({ order: row.order, outcome: row.outcome }))),
  );
}

function publishRunningStages(
  status: Record<string, unknown>,
  noted: ReadonlyMap<string, RunningStage>,
  executions: readonly FoldExecution[],
): void {
  delete status.current_stage;
  delete status.running_stages;
  const rows = executions
    .filter((execution) => execution.status === "running" && noted.has(execution.executionId))
    .sort((left, right) => {
      if (left.executionOrder !== right.executionOrder) return left.executionOrder - right.executionOrder;
      if (left.executionId < right.executionId) return -1;
      if (left.executionId > right.executionId) return 1;
      return 0;
    })
    .map((execution) => noted.get(execution.executionId)!);
  if (rows.length > 0) status.running_stages = rows;
}

/** Session status is the latest execution of each stage, not the highest-order row's stored status. */
function publishExecutionStatus(
  status: Record<string, unknown>,
  inputs: FoldInputs,
  updatedAt: string | null,
): string | null {
  const latest = latestExecution(inputs.executions);
  if (latest === null) return updatedAt;
  const rows = statusExecutionsFromFolds(inputs.executions);
  const sessionStatus = sessionStatusFromExecutions(rows, status, inputs.workflow);
  status.status = sessionStatus;
  if (inputs.schemaVersion < 2) {
    noteLatest(status, latest.executionId, latest.status, latest.stageId);
    recordLatestDecision(status, decisionOfOutcome(latest.outcome));
  }
  const blocked = blockedExecutions(rows, status, inputs.workflow).map((row) => ({
    executionId: row.executionId,
    stageId: row.stageId,
    blocker: textOr(inputs.executions.find((execution) => execution.executionId === row.executionId)?.outcome?.blocker),
  }));
  applyTerminalFields(
    status,
    sessionStatus,
    {
      executionId: latest.executionId,
      stageId: latest.stageId,
      blocker: textOr(latest.outcome?.blocker),
    },
    null,
    blocked,
  );
  return applyBlockedResume(
    status,
    inputs.events,
    blocked.map((row) => row.executionId),
    later(updatedAt, latest.completedAt ?? latest.createdAt),
  );
}

function statusExecutionsFromFolds(executions: readonly FoldExecution[]): StatusExecution[] {
  return executions.map((execution) => ({
    executionId: execution.executionId,
    stageId: execution.stageId,
    executionOrder: execution.executionOrder,
    status: execution.status,
    outcome: toStageOutcome(execution.outcome),
  }));
}

function eventExecutionOrder(event: ParsedEvent): number {
  const fromId = event.executionId ? (parseExecutionId(event.executionId)?.order ?? 0) : 0;
  return Math.max(asInt(event.data.execution_order), fromId);
}

/**
 * `session.active` with `data.from: blocked` reopens the session.
 * Every stage whose latest execution is blocked needs that event. One blocked stage still resumes.
 */
function applyBlockedResume(
  status: Record<string, unknown>,
  events: readonly ParsedEvent[],
  blockedIds: readonly string[],
  updatedAt: string | null,
): string | null {
  if (status.status !== "blocked" || blockedIds.length === 0) return updatedAt;
  const resumes: ParsedEvent[] = [];
  for (const executionId of blockedIds) {
    let resume: ParsedEvent | null = null;
    for (const event of events) {
      if (event.event !== "session.active" || event.executionId !== executionId) continue;
      if (event.data.from !== "blocked") continue;
      resume = event;
    }
    if (resume === null) return updatedAt;
    resumes.push(resume);
  }
  status.status = "active";
  applyTerminalFields(status, "active", null, null);
  let next = updatedAt;
  for (const resume of resumes) next = later(next, resume.timestamp);
  return next;
}

function noteLatest(status: Record<string, unknown>, executionId: string, executionStatus: string, stageId: string): void {
  status.latest_execution_id = executionId;
  status.latest_execution_status = executionStatus;
  status.latest_stage_id = stageId;
}

function latestSeenId(seen: ReadonlyMap<string, SeenExecution>): string | null {
  let best: string | null = null;
  let bestOrder = -1;
  for (const [executionId, execution] of seen) {
    if (best === null || execution.order > bestOrder || (execution.order === bestOrder && executionId > best)) {
      best = executionId;
      bestOrder = execution.order;
    }
  }
  return best;
}

function isExecutionScoped(eventName: string): boolean {
  return (
    eventName.startsWith("execution.") ||
    eventName.startsWith("stage.") ||
    eventName.startsWith("provider.") ||
    eventName.startsWith("verify.") ||
    (eventName.startsWith("session.") && eventName !== "session.created" && eventName !== "session.activated")
  );
}

function mergePublished(status: Record<string, unknown>, raw: unknown): void {
  if (!Array.isArray(raw)) return;
  const outputs = isRecord(status.outputs) ? cloneRecord(status.outputs) : {};
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name === "") continue;
    const row: Record<string, unknown> = {};
    if (typeof entry.path === "string") row.path = entry.path;
    if (typeof entry.source_execution_id === "string") row.source_execution_id = entry.source_execution_id;
    if (typeof entry.published_by_execution_id === "string") {
      row.published_by_execution_id = entry.published_by_execution_id;
    }
    outputs[entry.name] = row;
  }
  if (Object.keys(outputs).length > 0) status.outputs = outputs;
}

function addPathOnlyOutputs(status: Record<string, unknown>, outputFiles: readonly string[]): void {
  if (outputFiles.length === 0) return;
  const outputs = isRecord(status.outputs) ? cloneRecord(status.outputs) : {};
  for (const name of outputFiles) {
    if (Object.hasOwn(outputs, name)) continue;
    outputs[name] = { path: `outputs/${name}` };
  }
  if (Object.keys(outputs).length > 0) status.outputs = outputs;
}

function initialStatus(manifest: SessionManifest, schemaVersion: number): Record<string, unknown> {
  const status: Record<string, unknown> = {
    session_id: manifest.sessionId,
    status: schemaVersion >= 2 ? "active" : manifestStatusToSession(manifest.manifestStatus),
  };
  applyManifestIdentity(status, manifest);
  if (manifest.createdAt) status.updated_at = manifest.createdAt;
  return status;
}

function applyManifestIdentity(status: Record<string, unknown>, manifest: SessionManifest): void {
  status.session_id = manifest.sessionId || status.session_id;
  if (manifest.workflowId) status.workflow_id = manifest.workflowId;
  if (manifest.workflowPath) status.workflow_path = manifest.workflowPath;
  if (manifest.role) status.role = manifest.role;
  if (manifest.task !== null) status.task = manifest.task;
  if (manifest.createdAt) status.created_at = manifest.createdAt;
  if (manifest.priorSessionId) status.prior_session_id = manifest.priorSessionId;
}

function manifestStatusToSession(manifestStatus: string | null): string {
  if (manifestStatus === "prepared") return "prepared";
  if (manifestStatus === "completed" || manifestStatus === "blocked" || manifestStatus === "cancelled") {
    return manifestStatus;
  }
  return "active";
}

function outcomeRecord(event: ParsedEvent): Record<string, unknown> | null {
  if (isRecord(event.data.outcome)) return event.data.outcome;
  const top: Record<string, unknown> = {};
  if (typeof event.raw.status === "string") top.status = event.raw.status;
  if (typeof event.raw.blocker === "string") top.blocker = event.raw.blocker;
  if (typeof event.raw.decision === "string") top.decision = event.raw.decision;
  return Object.keys(top).length > 0 ? top : null;
}

function decisionOf(outcome: Record<string, unknown> | null): string | null {
  if (outcome === null) return null;
  return textOr(outcome.decision);
}

function toStageOutcome(outcome: Record<string, unknown> | null): StageOutcome | null {
  if (outcome === null || typeof outcome.status !== "string") return null;
  return new StageOutcome(outcome.status, textOr(outcome.blocker), textOr(outcome.decision));
}

function latestExecution(executions: readonly FoldExecution[]): FoldExecution | null {
  let best: FoldExecution | null = null;
  for (const execution of executions) {
    if (best === null) {
      best = execution;
      continue;
    }
    if (execution.executionOrder > best.executionOrder) best = execution;
    else if (execution.executionOrder === best.executionOrder && execution.executionId > best.executionId) {
      best = execution;
    }
  }
  return best;
}

export function readExecutions(sessionDirectory: string): FoldExecution[] {
  const directory = path.join(sessionDirectory, EXECUTIONS_DIRNAME);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const executions: FoldExecution[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || isAtomicTempName(entry.name)) continue;
    const filePath = path.join(directory, entry.name, "execution.json");
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ConfigurationError(`Execution file is corrupt: ${filePath}.`);
    }
    if (!isRecord(parsed)) throw new ConfigurationError(`Execution file is corrupt: ${filePath}.`);
    executions.push(executionFromRecord(entry.name, parsed));
  }
  return executions;
}

function executionFromRecord(executionId: string, metadata: Record<string, unknown>): FoldExecution {
  const outcome = isRecord(metadata.outcome) ? metadata.outcome : null;
  return {
    executionId,
    executionOrder: asInt(metadata.execution_order),
    stageId: textOr(metadata.stage_id) ?? "",
    stageAttempt: asInt(metadata.stage_attempt),
    provider: textOr(metadata.provider) ?? "",
    model: textOr(metadata.model) ?? "",
    resumesExecutionId: textOr(metadata.resumes_execution_id),
    status: textOr(metadata.status) ?? "",
    outcome,
    error: textOr(metadata.error),
    failureReason: textOr(metadata.failure_reason),
    createdAt: textOr(metadata.created_at),
    completedAt: textOr(metadata.completed_at),
  };
}

/** Finder, Explorer, and editor backups are not published artifacts. */
function isIgnoredOutputName(name: string): boolean {
  if (name.startsWith(".") || name.endsWith("~")) return true;
  const lower = name.toLowerCase();
  return lower === "thumbs.db" || lower === "desktop.ini";
}

function listOutputFiles(sessionDirectory: string): string[] {
  const directory = path.join(sessionDirectory, "outputs");
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || isIgnoredOutputName(entry.name)) continue;
    names.push(entry.name);
  }
  names.sort();
  return names;
}

function loadSessionWorkflow(
  workspace: string,
  sessionDirectory: string,
  status: Record<string, unknown>,
): WorkflowDocument | null {
  if (status.workflow_id === "agent") return null;
  const frozen = loadFrozenWorkflow(sessionDirectory);
  if (frozen) return frozen;
  const workflowPath = status.workflow_path;
  if (typeof workflowPath === "string" && workflowPath) {
    const filePath = path.isAbsolute(workflowPath) ? workflowPath : path.join(workspace, workflowPath);
    if (isReadableFile(filePath)) {
      try {
        return loadWorkflowDocument(filePath);
      } catch (error) {
        if (!(error instanceof ConfigurationError)) throw error;
      }
    }
  }
  const workflowId = status.workflow_id;
  if (typeof workflowId !== "string" || workflowId === "") return null;
  try {
    return loadNamedWorkflow(workspace, workflowId);
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

function isReadableFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function statusIdentity(manifest: SessionManifest, previous: Record<string, unknown> | null): Record<string, unknown> {
  return {
    workflow_id: manifest.workflowId ?? previous?.workflow_id ?? null,
    workflow_path: manifest.workflowPath ?? previous?.workflow_path ?? null,
  };
}

function emptyManifest(sessionId: string): SessionManifest {
  return {
    sessionId,
    workflowId: null,
    workflowPath: null,
    role: null,
    task: null,
    createdAt: null,
    priorSessionId: null,
    manifestStatus: null,
    schemaVersion: 1,
  };
}

function differingKeys(left: Record<string, unknown>, right: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const different: string[] = [];
  for (const key of [...keys].sort()) {
    if (canonical(left[key]) !== canonical(right[key])) different.push(key);
  }
  return different;
}

function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key]);
  return sorted;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function later(current: string | null, next: string | null): string | null {
  if (!next) return current;
  if (!current) return next;
  const left = Date.parse(current);
  const right = Date.parse(next);
  if (Number.isNaN(left) || Number.isNaN(right)) return current >= next ? current : next;
  return left >= right ? current : next;
}

function textOr(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return 0;
}
