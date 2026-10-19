import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { appendLineSynced, isAtomicTempName, sealTornTail } from "./atomic-file.js";
import { isRecord } from "./record.js";
import { EXECUTIONS_DIRNAME, utcNow } from "./runtime.js";
import { assertSessionLockHeld } from "./session-lock.js";

export const EVENT_VERSION = 2;

const ENVELOPE_KEYS = new Set(["v", "seq", "event", "timestamp", "data"]);

/** Item traces and provider heartbeats are per execution, not session lifecycle. */
export function isProviderStreamEvent(eventName: string): boolean {
  return eventName === "provider.heartbeat" || eventName.startsWith("provider.item_");
}

/** Heartbeats are appended and never folded into status.json. */
export function skipsStatusWrite(eventName: string): boolean {
  return eventName === "provider.heartbeat" || eventName === "verify.heartbeat";
}

export interface EventDraft {
  event: string;
  timestamp: string;
  executionId?: string | null;
  stageId?: string | null;
  summary?: string | null;
  outcomeTopLevel?: Record<string, unknown> | null;
  /** Extra top-level keys. Envelope keys win. */
  topLevel?: Record<string, unknown> | null;
  data?: Record<string, unknown>;
}

export interface ParsedEvent {
  raw: Record<string, unknown>;
  v: number;
  seq: number | null;
  event: string;
  timestamp: string;
  executionId: string | null;
  stageId: string | null;
  summary: string | null;
  data: Record<string, unknown>;
}

export function eventRecord(seq: number, draft: EventDraft): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  // Outcome keys go first so they cannot replace event or timestamp.
  if (draft.outcomeTopLevel) {
    for (const [key, value] of Object.entries(draft.outcomeTopLevel)) {
      if (value !== undefined) record[key] = value;
    }
  }
  record.v = EVENT_VERSION;
  record.seq = seq;
  record.event = draft.event;
  record.timestamp = draft.timestamp;
  if (draft.executionId) record.execution_id = draft.executionId;
  if (draft.stageId) record.stage_id = draft.stageId;
  if (draft.summary) record.summary = draft.summary;
  if (draft.topLevel) {
    for (const [key, value] of Object.entries(draft.topLevel)) {
      if (ENVELOPE_KEYS.has(key) || value === undefined || Object.hasOwn(record, key)) continue;
      record[key] = value;
    }
  }
  record.data = draft.data ?? {};
  return record;
}

/** One session-wide sequence. A parseable line counts, including v1. A trailing partial line does not. */
export function nextEventSequence(sessionDirectory: string): number {
  let count = countCompleteLines(path.join(sessionDirectory, "events.jsonl"));
  for (const stream of streamFiles(sessionDirectory)) count += countCompleteLines(stream);
  return count + 1;
}

export function appendLifecycleEvent(sessionDirectory: string, draft: EventDraft): void {
  assertSessionLockHeld(sessionDirectory);
  const record = eventRecord(assignEventSequence(sessionDirectory), draft);
  appendLineSynced(path.join(sessionDirectory, "events.jsonl"), JSON.stringify(record));
}

/** Keep the caller's top-level keys. Stream events go to that execution's stream.jsonl. */
export function appendRecordedEvent(sessionDirectory: string, event: Record<string, unknown>): void {
  const name = typeof event.event === "string" ? event.event : "";
  const executionId = typeof event.execution_id === "string" ? event.execution_id : null;
  assertSessionLockHeld(sessionDirectory);
  const record = eventRecord(assignEventSequence(sessionDirectory), {
    event: name,
    timestamp: typeof event.timestamp === "string" ? event.timestamp : utcNow(),
    executionId,
    stageId: typeof event.stage_id === "string" ? event.stage_id : null,
    summary: typeof event.summary === "string" ? event.summary : null,
    topLevel: event,
    data: {},
  });
  const destination =
    executionId && isProviderStreamEvent(name)
      ? path.join(sessionDirectory, EXECUTIONS_DIRNAME, executionId, "stream.jsonl")
      : path.join(sessionDirectory, "events.jsonl");
  appendLineSynced(destination, JSON.stringify(record));
}

export function readParsedEvents(filePath: string): ParsedEvent[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const events: ParsedEvent[] = [];
  for (const line of completeLines(text)) {
    const parsed = parseEventLine(line);
    if (parsed) events.push(parsed);
  }
  return events;
}

export function executionIdsStartedInLog(sessionDirectory: string): string[] {
  const ids: string[] = [];
  for (const event of readParsedEvents(path.join(sessionDirectory, "events.jsonl"))) {
    if (event.event === "execution.started" && event.executionId) ids.push(event.executionId);
  }
  return ids;
}

const EXECUTION_ID_PATTERN = /^(\d+)-(.+)--attempt-(\d+)$/;

/** Directory and event ids use `0003-stage--attempt-01`. The stage portion may contain hyphens. */
export function parseExecutionId(
  executionId: string,
): { order: number; stageId: string; attempt: number } | null {
  const match = EXECUTION_ID_PATTERN.exec(executionId);
  if (!match) return null;
  return { order: Number(match[1]), stageId: match[2] ?? "", attempt: Number(match[3]) };
}

export interface ReservedAttempt {
  stageId: string;
  attempt: number;
}

/** Orders from execution directories and from `execution.started`, including a started event whose file is gone. */
export function reservedExecutionOrders(sessionDirectory: string): number[] {
  const orders: number[] = [];
  for (const name of executionDirectoryNames(sessionDirectory)) {
    const parsed = parseExecutionId(name);
    if (parsed) orders.push(parsed.order);
  }
  for (const event of startedEvents(sessionDirectory)) {
    const parsed = event.executionId ? parseExecutionId(event.executionId) : null;
    if (parsed) orders.push(parsed.order);
    const fromData = asInt(event.data.execution_order);
    if (fromData > 0) orders.push(fromData);
  }
  return orders;
}

/** Attempts from directory names and from `execution.started`, keyed by the event stage and the id stage. */
export function reservedStageAttempts(sessionDirectory: string): ReservedAttempt[] {
  const attempts: ReservedAttempt[] = [];
  for (const name of executionDirectoryNames(sessionDirectory)) {
    const parsed = parseExecutionId(name);
    if (parsed) attempts.push({ stageId: parsed.stageId, attempt: parsed.attempt });
  }
  for (const event of startedEvents(sessionDirectory)) {
    const parsed = event.executionId ? parseExecutionId(event.executionId) : null;
    const attempt = Math.max(parsed?.attempt ?? 0, asInt(event.data.stage_attempt));
    if (event.stageId && attempt > 0) attempts.push({ stageId: event.stageId, attempt });
    if (parsed && parsed.stageId !== event.stageId) {
      attempts.push({ stageId: parsed.stageId, attempt: parsed.attempt });
    }
  }
  return attempts;
}

/** Why a session status change is recorded on `session.<status>`. */
export function sessionChangeReason(
  sessionStatus: string,
  outcome: { blocker?: string | null; decision?: string | null } | null,
  error: string | null,
): string | null {
  if (sessionStatus === "blocked") return outcome?.blocker || "blocked";
  if (sessionStatus === "cancelled") return "cancelled";
  if (sessionStatus === "completed") return outcome?.decision || "completed";
  if (error) return error;
  return null;
}

function startedEvents(sessionDirectory: string): ParsedEvent[] {
  return readParsedEvents(path.join(sessionDirectory, "events.jsonl")).filter(
    (event) => event.event === "execution.started",
  );
}

function executionDirectoryNames(sessionDirectory: string): string[] {
  const root = path.join(sessionDirectory, EXECUTIONS_DIRNAME);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || isAtomicTempName(entry.name)) continue;
    names.push(entry.name);
  }
  return names;
}

function asInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return 0;
}

export function streamFiles(sessionDirectory: string): string[] {
  const root = path.join(sessionDirectory, EXECUTIONS_DIRNAME);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || isAtomicTempName(entry.name)) continue;
    const stream = path.join(root, entry.name, "stream.jsonl");
    try {
      if (statSync(stream).isFile()) files.push(stream);
    } catch {
      // The execution has no stream yet.
    }
  }
  files.sort();
  return files;
}

/** A torn tail can already be valid JSON. Close every log before the sequence count. */
export function sealSessionEventLogs(sessionDirectory: string): void {
  sealTornTail(path.join(sessionDirectory, "events.jsonl"));
  for (const stream of streamFiles(sessionDirectory)) sealTornTail(stream);
}

/** A trailing object with no newline. The fold skips it until a writer closes the line. */
export function parseableTornTail(filePath: string): ParsedEvent | null {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  if (text.length === 0 || text.endsWith("\n")) return null;
  return parseEventLine(text.slice(text.lastIndexOf("\n") + 1));
}

function assignEventSequence(sessionDirectory: string): number {
  sealSessionEventLogs(sessionDirectory);
  return nextEventSequence(sessionDirectory);
}

function countCompleteLines(filePath: string): number {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return 0;
  }
  return completeLines(text).filter((line) => parseEventLine(line) !== null).length;
}

/** Drop a trailing fragment that has no newline. Blank lines are not events. */
export function completeLines(text: string): string[] {
  if (!text.includes("\n")) return [];
  const pieces = text.split("\n");
  if (!text.endsWith("\n")) pieces.pop();
  return pieces.filter((line) => line !== "");
}

function parseEventLine(line: string): ParsedEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.event !== "string" || value.event === "") return null;
  const version = value.v;
  const v = typeof version === "number" && Number.isInteger(version) ? version : 1;
  const seq = typeof value.seq === "number" && Number.isInteger(value.seq) ? value.seq : null;
  return {
    raw: value,
    v,
    seq,
    event: value.event,
    timestamp: typeof value.timestamp === "string" ? value.timestamp : "",
    executionId: typeof value.execution_id === "string" ? value.execution_id : null,
    stageId: typeof value.stage_id === "string" ? value.stage_id : null,
    summary: typeof value.summary === "string" ? value.summary : null,
    data: isRecord(value.data) ? value.data : {},
  };
}
