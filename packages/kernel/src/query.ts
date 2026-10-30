import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { isRecord } from "./record.js";
import { MIGENT_DIRNAME, SESSIONS_DIRNAME } from "./runtime.js";

export function readStatusFile(filePath: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return {};
  }
  try {
    const payload = JSON.parse(text) as unknown;
    return isRecord(payload) ? payload : {};
  } catch {
    return {};
  }
}

export type StatusFileState =
  | { state: "missing"; status: Record<string, never> }
  | { state: "corrupt"; status: Record<string, never> }
  | { state: "ok"; status: Record<string, unknown> };

/** Like readStatusFile, but tells a missing file from one that exists and does not parse. */
export function readStatusFileState(filePath: string): StatusFileState {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", status: {} };
    return { state: "corrupt", status: {} };
  }
  try {
    const payload = JSON.parse(text) as unknown;
    return isRecord(payload) ? { state: "ok", status: payload } : { state: "corrupt", status: {} };
  } catch {
    return { state: "corrupt", status: {} };
  }
}

export function corruptStatusMessage(filePath: string): string {
  return `Session status file is corrupt: ${filePath}.`;
}

export function readExecutionFile(filePath: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(text) as unknown;
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function watchSnapshot(
  sessionDirectory: string,
  executionId?: string | null,
): Record<string, unknown> {
  const status = readStatusFile(path.join(sessionDirectory, "status.json"));
  const eventsPath = path.join(sessionDirectory, "events.jsonl");
  let cursor = 0;
  try {
    cursor = statSync(eventsPath).size;
  } catch {
    cursor = 0;
  }
  const latest = status.latest_execution_id;
  const selectedId = executionId || (typeof latest === "string" ? latest : "");
  let execution: Record<string, unknown> | null = null;
  if (selectedId) {
    execution = readExecutionFile(
      path.join(sessionDirectory, "executions", selectedId, "execution.json"),
    );
  }
  let outcome: unknown = null;
  if (execution && isRecord(execution.outcome)) outcome = execution.outcome;
  const outputs = isRecord(status.outputs) ? status.outputs : {};
  const snapshot: Record<string, unknown> = {
    session_id: status.session_id || path.basename(sessionDirectory),
    status: status.status || "unknown",
    workflow_id: status.workflow_id ?? null,
    task: status.task ?? null,
    latest_execution_id: status.latest_execution_id ?? null,
    latest_execution_status: status.latest_execution_status ?? null,
    execution_id: selectedId || null,
    execution_status: execution ? (execution.status ?? null) : null,
    outcome,
    questions: Array.isArray(status.questions) ? status.questions.filter(isRecord) : [],
    blocked_by_execution_ids: status.blocked_by_execution_ids ?? [],
    blocker: status.blocker ?? null,
    updated_at: status.updated_at ?? null,
    outputs,
    running_stages: Array.isArray(status.running_stages) ? status.running_stages.filter(isRecord) : [],
    events_cursor: cursor,
  };
  snapshot.baseline = isRecord(status.baseline) ? status.baseline : null;
  snapshot.skipped_stages = Array.isArray(status.skipped_stages) ? status.skipped_stages.filter(isRecord) : [];
  if (execution && isRecord(execution.skip)) snapshot.skip = execution.skip;
  if (typeof status.title === "string" && status.title !== "") snapshot.title = status.title;
  return snapshot;
}

export function listSessionRows(workspace: string): string[][] {
  const sessionsDirectory = path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME);
  let entries;
  try {
    if (!statSync(sessionsDirectory).isDirectory()) return [];
    entries = readdirSync(sessionsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows: string[][] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statusPath = path.join(sessionsDirectory, entry.name, "status.json");
    try {
      if (!statSync(statusPath).isFile()) continue;
    } catch {
      continue;
    }
    const read = readStatusFileState(statusPath);
    if (read.state === "corrupt") {
      rows.push(["", entry.name, "legacy/unknown", "corrupt", "not started", "--", "none", "", entry.name]);
      continue;
    }
    const status = read.status;
    if (Object.keys(status).length === 0) continue;
    const outputs = status.outputs;
    const outputLabel =
      isRecord(outputs) && Object.keys(outputs).length > 0 ? Object.keys(outputs).join(",") : "none";
    rows.push([
      text(status.updated_at, ""),
      entry.name,
      text(status.workflow_id, "legacy/unknown"),
      text(status.status, "unknown"),
      text(status.latest_execution_id, "not started"),
      status.latest_decision ? text(status.latest_decision) : "--",
      outputLabel,
      text(status.task, ""),
      text(status.title, entry.name),
    ]);
  }
  rows.sort((left, right) => {
    for (let index = 0; index < left.length; index += 1) {
      const a = left[index] ?? "";
      const b = right[index] ?? "";
      if (a < b) return 1;
      if (a > b) return -1;
    }
    return 0;
  });
  return rows;
}

function text(value: unknown, fallback = ""): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}
