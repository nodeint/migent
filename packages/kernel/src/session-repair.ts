import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-file.js";
import { ConfigurationError } from "./errors.js";
import { sessionStatusAfterExecution } from "./outputs.js";
import { sessionStatusFromExecutions } from "./session-ledger.js";
import { isRecord } from "./record.js";
import { utcNow } from "./runtime.js";
import {
  appendLifecycleEvent,
  eventRecord,
  parseableTornTail,
  sealSessionEventLogs,
  sessionChangeReason,
  type EventDraft,
  type ParsedEvent,
} from "./session-events.js";
import {
  foldStatus,
  loadFoldInputs,
  readSessionManifest,
  type FoldExecution,
  type FoldInputs,
} from "./session-fold.js";
import { SessionLock } from "./session-lock.js";
import { StageOutcome } from "./stage-outcome.js";

export interface RepairOptions {
  /** The only way past a v1 status.json that does not parse. `continue` never sets this. */
  acceptTask?: boolean;
}

/** Take the session lock and rebuild status.json. */
export function repairSession(
  workspace: string,
  sessionId: string,
  options: RepairOptions = {},
): Record<string, unknown> {
  const sessionDirectory = sessionDirectoryOf(workspace, sessionId);
  assertSessionDirectory(sessionDirectory, sessionId);
  const lock = SessionLock.acquire(sessionDirectory);
  try {
    return repairSessionUnlocked(workspace, sessionId, options);
  } finally {
    lock.release();
  }
}

/**
 * Rebuild status.json. The caller holds the session lock.
 * A normal save does not call this: refusal applies only to repair and continue.
 */
export function repairSessionUnlocked(
  workspace: string,
  sessionId: string,
  options: RepairOptions = {},
): Record<string, unknown> {
  const acceptTask = options.acceptTask === true;
  const sessionDirectory = sessionDirectoryOf(workspace, sessionId);
  assertSessionDirectory(sessionDirectory, sessionId);
  const manifest = readSessionManifest(sessionDirectory);
  const loaded = loadFoldInputs(workspace, sessionDirectory);
  const statusPath = path.join(sessionDirectory, "status.json");
  const before = loaded.previousStatus === null ? statusFileKind(statusPath) : "ok";
  const acceptDraft = acceptTask && before === "corrupt" ? acceptedTaskDraft(sessionDirectory, sessionId) : null;
  let inputs = loaded;
  let drafts: EventDraft[] = manifest.schemaVersion >= 2 ? reconcileDrafts(inputs) : [];
  if (acceptDraft) drafts.push(acceptDraft);
  // Appending seals a torn tail. Fold that line first, and leave the file untouched on refusal.
  const torn = drafts.length > 0 ? parseableTornTail(path.join(sessionDirectory, "events.jsonl")) : null;
  if (torn) {
    inputs = { ...loaded, events: [...loaded.events, torn] };
    drafts = manifest.schemaVersion >= 2 ? reconcileDrafts(inputs) : [];
    if (acceptDraft) drafts.push(acceptDraft);
  }
  const folded = foldStatus(withDrafts(inputs, drafts));
  if (acceptTask && before === "corrupt") {
    const hash = typeof folded.task_sha256 === "string" ? folded.task_sha256 : "";
    if (hash === "") {
      throw new ConfigurationError(
        `Session ${sessionId} cannot store a task hash. Write task.md, then run: migent session repair ${sessionId} --accept-task`,
      );
    }
  }
  const reasons = replacementRefusal(folded, inputs, before, acceptTask);
  if (reasons.length > 0) throw new ConfigurationError(repairRefusalMessage(sessionId, reasons));
  if (torn) sealSessionEventLogs(sessionDirectory);
  for (const draft of drafts) appendLifecycleEvent(sessionDirectory, draft);
  writeJsonAtomic(statusPath, folded);
  return folded;
}

function withDrafts(inputs: FoldInputs, drafts: readonly EventDraft[]): FoldInputs {
  if (drafts.length === 0) return inputs;
  return { ...inputs, events: [...inputs.events, ...drafts.map(parsedFromDraft)] };
}

function parsedFromDraft(draft: EventDraft): ParsedEvent {
  const raw = eventRecord(0, draft);
  return {
    raw,
    v: 2,
    seq: null,
    event: draft.event,
    timestamp: draft.timestamp,
    executionId: draft.executionId ?? null,
    stageId: draft.stageId ?? null,
    summary: draft.summary ?? null,
    data: draft.data ?? {},
  };
}

function reconcileDrafts(inputs: FoldInputs): EventDraft[] {
  const drafts: EventDraft[] = [];
  const executions = [...inputs.executions].sort(compareExecutions);
  const fromStatus = manifestSessionStatus(inputs.manifest.manifestStatus);
  const cursor: Record<string, unknown> = {
    workflow_id: inputs.manifest.workflowId,
    status: fromStatus,
  };
  const rows = executions.map((execution) => ({
    executionId: execution.executionId,
    stageId: execution.stageId,
    executionOrder: execution.executionOrder,
    status: execution.status,
    outcome: stageOutcome(execution),
    artifactDirectory: execution.artifactDirectory,
    failureReason: execution.failureReason,
  }));
  const finalStatus = sessionStatusFromExecutions(rows, cursor, inputs.workflow);
  const planned = (name: string, executionId: string) =>
    hasEvent(inputs.events, name, executionId) ||
    drafts.some((draft) => draft.event === name && draft.executionId === executionId);
  const sessionPlanned = (name: string) =>
    inputs.events.some((event) => event.event === name) || drafts.some((draft) => draft.event === name);
  let attachedSession = false;
  for (const execution of executions) {
    if (!planned("execution.started", execution.executionId)) {
      drafts.push({
        event: "execution.started",
        timestamp: execution.createdAt ?? utcNow(),
        executionId: execution.executionId,
        stageId: execution.stageId,
        data: {
          execution_order: execution.executionOrder,
          stage_attempt: execution.stageAttempt,
          provider: execution.provider,
          model: execution.model,
          resumes_execution_id: execution.resumesExecutionId,
        },
      });
    }
    if (!isTerminalExecution(execution.status)) continue;
    const outcome = stageOutcome(execution);
    const ownStatus = sessionStatusAfterExecution(
      execution.status,
      outcome,
      cursor,
      inputs.workflow,
      execution.stageId,
    );
    if (!planned(`execution.${execution.status}`, execution.executionId)) {
      drafts.push({
        event: `execution.${execution.status}`,
        timestamp: execution.completedAt ?? execution.createdAt ?? utcNow(),
        executionId: execution.executionId,
        stageId: execution.stageId,
        data: {
          outcome: outcome ? outcome.toJson() : null,
          failure_reason: execution.failureReason,
          error: execution.error,
          session_status: finalStatus,
        },
      });
    }
    // One session event for the whole reduction. A later sibling must not clear a blocked stage.
    if (
      finalStatus !== "active" &&
      ownStatus === finalStatus &&
      !attachedSession &&
      !sessionPlanned(`session.${finalStatus}`)
    ) {
      const reason = sessionChangeReason(finalStatus, outcome, execution.error);
      const data: Record<string, unknown> = { from: fromStatus || null };
      if (reason !== null) data.reason = reason;
      if (outcome !== null) data.outcome = outcome.toJson();
      drafts.push({
        event: `session.${finalStatus}`,
        timestamp: execution.completedAt ?? execution.createdAt ?? utcNow(),
        executionId: execution.executionId,
        stageId: execution.stageId,
        outcomeTopLevel: outcome ? outcome.toJson() : null,
        data,
      });
      attachedSession = true;
    }
  }
  return drafts;
}

function acceptedTaskDraft(sessionDirectory: string, sessionId: string): EventDraft {
  const filePath = path.join(sessionDirectory, "task.md");
  let text: string | null = null;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    text = null;
  }
  if (text === null || text.trim() === "") {
    throw new ConfigurationError(
      `Session ${sessionId} has no task.md. migent session repair ${sessionId} --accept-task cannot store a task hash.`,
    );
  }
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  return {
    event: "task.frozen",
    timestamp: utcNow(),
    data: { sha256: hash },
  };
}

function replacementRefusal(
  folded: Record<string, unknown>,
  inputs: FoldInputs,
  before: "ok" | "missing" | "corrupt",
  acceptTask: boolean,
): string[] {
  const reasons: string[] = [];
  if (typeof folded.workflow_id !== "string" || folded.workflow_id === "") {
    reasons.push("workflow_id is missing from manifest.yaml");
  }
  if (inputs.schemaVersion < 2 && before === "corrupt" && !acceptTask) {
    reasons.push("task_sha256 cannot be kept because status.json does not parse");
  }
  const previous = inputs.previousStatus;
  if (previous !== null) {
    const previousHash = typeof previous.task_sha256 === "string" ? previous.task_sha256 : "";
    const foldedHash = typeof folded.task_sha256 === "string" ? folded.task_sha256 : "";
    if (previousHash !== "" && foldedHash !== previousHash) reasons.push("task_sha256 would be dropped");
    reasons.push(...outputDrops(previous, folded));
  }
  return reasons;
}

function outputDrops(previous: Record<string, unknown>, folded: Record<string, unknown>): string[] {
  if (!isRecord(previous.outputs)) return [];
  const next = isRecord(folded.outputs) ? folded.outputs : {};
  const drops: string[] = [];
  for (const [name, value] of Object.entries(previous.outputs)) {
    if (!isRecord(value)) continue;
    const kept = next[name];
    if (!isRecord(kept)) {
      drops.push(`outputs.${name} would be dropped`);
      continue;
    }
    for (const field of ["source_execution_id", "published_by_execution_id"] as const) {
      const stored = value[field];
      if (typeof stored === "string" && stored !== "" && kept[field] !== stored) {
        drops.push(`outputs.${name}.${field} would be dropped`);
      }
    }
  }
  return drops;
}

export function repairRefusalMessage(sessionId: string, reasons: readonly string[]): string {
  const lead = `Session ${sessionId} cannot be repaired because ${reasons.join("; ")}.`;
  const unparseable = reasons.some((reason) => reason.includes("does not parse"));
  if (!unparseable) return lead;
  return (
    `${lead} When a v1 status.json is destroyed, the task hash and output provenance cannot be recovered. ` +
    `Run: migent session repair ${sessionId} --accept-task`
  );
}

function hasEvent(events: FoldInputs["events"], name: string, executionId: string): boolean {
  return events.some((event) => event.event === name && event.executionId === executionId);
}

function isTerminalExecution(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function stageOutcome(execution: FoldExecution): StageOutcome | null {
  const outcome = execution.outcome;
  if (!isRecord(outcome) || typeof outcome.status !== "string" || outcome.status === "") return null;
  const blocker = typeof outcome.blocker === "string" && outcome.blocker ? outcome.blocker : null;
  const decision = typeof outcome.decision === "string" && outcome.decision ? outcome.decision : null;
  return new StageOutcome(outcome.status, blocker, decision);
}

function compareExecutions(left: FoldExecution, right: FoldExecution): number {
  if (left.executionOrder !== right.executionOrder) return left.executionOrder - right.executionOrder;
  if (left.executionId < right.executionId) return -1;
  if (left.executionId > right.executionId) return 1;
  return 0;
}

function manifestSessionStatus(manifestStatus: string | null): string {
  if (manifestStatus === "prepared") return "prepared";
  if (manifestStatus === "completed" || manifestStatus === "blocked" || manifestStatus === "cancelled") {
    return manifestStatus;
  }
  return "active";
}

function statusFileKind(filePath: string): "ok" | "missing" | "corrupt" {
  try {
    if (!statSync(filePath).isFile()) return "missing";
  } catch {
    return "missing";
  }
  try {
    const payload = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return isRecord(payload) ? "ok" : "corrupt";
  } catch {
    return "corrupt";
  }
}

function sessionDirectoryOf(workspace: string, sessionId: string): string {
  return path.join(workspace, ".migent", "sessions", sessionId);
}

function assertSessionDirectory(sessionDirectory: string, sessionId: string): void {
  if (!existsSync(sessionDirectory)) throw new ConfigurationError(`Session not found: ${sessionId}.`);
  try {
    if (!statSync(sessionDirectory).isDirectory()) throw new ConfigurationError(`Session not found: ${sessionId}.`);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`Session not found: ${sessionId}.`);
  }
}
