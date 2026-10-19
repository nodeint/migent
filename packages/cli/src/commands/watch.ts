import { openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import {
  CancellationRequested,
  ConfigurationError,
  corruptStatusMessage,
  SessionLock,
  SessionStore,
  log,
  readStatusFileState,
  readExecutionFile,
  watchSnapshot,
} from "@nodeint/migent-kernel";
import { printNotice, printWatchEvent, printWatchSnapshot } from "../display.js";
import { EXIT_BLOCKED, EXIT_CANCELLED, EXIT_OK } from "../exits.js";
import { isFile } from "../fs-utils.js";
import { bindCancellationSignals, delay, throwIfCliCancelled } from "../signals.js";

const SESSION_DONE_EXITS: Record<string, number> = {
  completed: EXIT_OK,
  blocked: EXIT_BLOCKED,
  cancelled: EXIT_CANCELLED,
};

const TERMINAL_EXECUTION_STATUSES = new Set(["completed", "failed", "cancelled"]);

export async function followSession(
  workspace: string,
  sessionId: string,
  options: {
    once?: boolean;
    executionId?: string | null;
    untilTerminal?: boolean;
    jsonLines?: boolean;
    cursor?: number | null;
    exitWhenDone?: boolean;
  } = {},
): Promise<number> {
  const once = options.once ?? false;
  const untilTerminal = options.untilTerminal ?? false;
  const jsonLines = options.jsonLines ?? false;
  const executionId = options.executionId ?? null;
  const cursor = options.cursor === undefined ? null : options.cursor;
  const exitWhenDone = options.exitWhenDone === true;
  const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
  const eventsPath = path.join(sessionDirectory, "events.jsonl");
  const statusPath = path.join(sessionDirectory, "status.json");
  if (readStatusFileState(statusPath).state === "corrupt") {
    throw new ConfigurationError(corruptStatusMessage(statusPath));
  }
  if (!isFile(eventsPath) && !(once && isFile(path.join(sessionDirectory, "status.json")))) {
    throw new ConfigurationError(`No events found for session: ${sessionId}`);
  }
  // Reaping writes, so it needs the session lock. A live holder keeps the session; follow then tails read-only.
  const reapLock = SessionLock.tryAcquire(sessionDirectory);
  if (reapLock !== null) {
    try {
      new SessionStore(workspace).reapOrphanedExecutions(sessionId, "ignore");
    } finally {
      reapLock.release();
    }
  }
  let executionPath: string | null = null;
  if (executionId !== null) {
    const resolved = path.join(sessionDirectory, "executions", executionId, "execution.json");
    executionPath = resolved;
    if (!isFile(resolved)) throw new ConfigurationError(`No execution found: ${executionId}`);
  }
  if (once) {
    printSnapshot(sessionDirectory, executionId, jsonLines);
    return 0;
  }
  let followCursor = cursor;
  if (followCursor === null) {
    const snapshot = printSnapshot(sessionDirectory, executionId, jsonLines);
    followCursor = Number(snapshot.events_cursor ?? 0);
  }
  printNotice(`Watching session ${sessionId}.`);
  const unbind = bindCancellationSignals();
  const fd = openSync(eventsPath, "r");
  try {
    let position = followCursor;
    let pending = "";
    for (;;) {
      throwIfCliCancelled();
      const read = readCompleteLines(fd, position, pending);
      position = read.position;
      pending = read.pending;
      for (const line of read.lines) emitWatchEvent(line, executionId, jsonLines);
      if (read.lines.length > 0) continue;
      if (untilTerminal) {
        if (executionPath === null) throw new ConfigurationError("--until requires --execution.");
        const record = readExecutionFile(executionPath);
        if (record !== null && TERMINAL_EXECUTION_STATUSES.has(String(record.status))) {
          const drained = readCompleteLines(fd, position, pending);
          for (const line of drained.lines) emitWatchEvent(line, executionId, jsonLines);
          return untilTerminalExitCode(record);
        }
      }
      if (exitWhenDone) {
        const status = String(watchSnapshot(sessionDirectory, null).status ?? "");
        const done = SESSION_DONE_EXITS[status];
        if (done !== undefined) {
          const drained = readCompleteLines(fd, position, pending);
          for (const line of drained.lines) emitWatchEvent(line, executionId, jsonLines);
          return done;
        }
      }
      await delay(250);
    }
  } catch (error) {
    if (error instanceof CancellationRequested) {
      log(error.message);
      return 130;
    }
    throw error;
  } finally {
    closeSync(fd);
    unbind();
  }
}

function printSnapshot(sessionDirectory: string, executionId: string | null, jsonLines: boolean): Record<string, unknown> {
  const snapshot = watchSnapshot(sessionDirectory, executionId);
  if (jsonLines) process.stdout.write(`${JSON.stringify(snapshotJson(snapshot))}\n`);
  else printWatchSnapshot(snapshot);
  return snapshot;
}

function snapshotJson(snapshot: Record<string, unknown>): Record<string, unknown> {
  const body = { ...snapshot };
  delete body.task;
  return body;
}

function emitWatchEvent(line: string, executionId: string | null, jsonLines: boolean): void {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(event)) return;
  if (executionId !== null && event.execution_id !== executionId) return;
  if (jsonLines) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  printWatchEvent(event);
}

function untilTerminalExitCode(record: Record<string, unknown>): number {
  if (record.status === "completed") {
    const outcome = record.outcome;
    if (isRecord(outcome) && outcome.status === "complete") return 0;
    return 1;
  }
  return 1;
}

function readCompleteLines(
  fd: number,
  position: number,
  pending: string,
): { lines: string[]; pending: string; position: number } {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let offset = position;
  for (;;) {
    const count = readSync(fd, buffer, 0, buffer.length, offset);
    if (count <= 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, count)));
    offset += count;
  }
  if (chunks.length === 0) return { lines: [], pending, position };
  pending += Buffer.concat(chunks).toString("utf8");
  const pieces = pending.split("\n");
  const rest = pieces.pop() ?? "";
  return { lines: pieces, pending: rest, position: offset };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
