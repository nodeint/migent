import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

import { SessionFollowRecord, SessionSnapshot, SessionSnapshotLine, type Static } from '@nodeint/migent-contracts';
import { BYTES_PER_KIB, CancellationRequested, ConfigurationError, exitFor, log, stageStopStatus } from '@nodeint/migent-kernel';
import { corruptStatusMessage, readExecutionFile, readStatusFileState, SessionLock, SessionStore, statusDriftMessage, watchSnapshot } from '@nodeint/migent-session';

import { printNotice, printWatchEvent, printWatchSnapshot } from '../display.js';
import { writeJson } from '../emit.js';
import { EXIT_CANCELLED, EXIT_QUESTION } from '../exits.js';
import {
  compareFollowLines,
  type FollowLine,
  includeStreamLine,
  listStreamFiles,
  streamFollowStart,
} from '../follow-log.js';
import { isFile } from '../fs-utils.js';
import { bindCancellationSignals, delay, throwIfCliCancelled } from '../signals.js';

/** Pause between log polls, in milliseconds. */
const POLL_MS = 250;
/** Bytes read from a log per call. */
const READ_CHUNK_KIB = 64;
const READ_CHUNK_BYTES = READ_CHUNK_KIB * BYTES_PER_KIB;

const TERMINAL_EXECUTION_STATUSES = new Set(['completed', 'failed', 'cancelled', 'skipped']);

interface FollowOptions {
  once?: boolean;
  executionId?: string | null;
  untilTerminal?: boolean;
  jsonLines?: boolean;
  cursor?: number | null;
  exitWhenDone?: boolean;
}

/** Where the tail starts: the events cursor and, when tailing only new lines, the stream offsets. */
interface FollowStart {
  cursor: number;
  tailOnly: boolean;
  streamOffsets: Map<string, number> | null;
}

/** What a follow prints and when it stops. */
interface WatchState {
  executionId: string | null;
  jsonLines: boolean;
  untilTerminal: boolean;
  executionPath: string | null;
  exitWhenDone: boolean;
}

export async function followSession(
  workspace: string,
  sessionId: string,
  options: FollowOptions = {},
): Promise<number> {
  const once = options.once ?? false;
  const jsonLines = options.jsonLines ?? false;
  const executionId = options.executionId ?? null;
  const sessionDirectory = path.join(workspace, '.migent', 'sessions', sessionId);
  const executionPath = prepareFollow(workspace, sessionId, { once, executionId });
  if (once) {
    const drift = statusDriftMessage(workspace, sessionId);
    if (drift) printNotice(drift);
    printSnapshot(sessionDirectory, { executionId, jsonLines });
    return 0;
  }
  const start = followStart(sessionDirectory, options.cursor ?? null, { executionId, jsonLines });
  printNotice(`Watching session ${sessionId}.`);
  return pollSession(sessionDirectory, start, {
    executionId,
    jsonLines,
    untilTerminal: options.untilTerminal ?? false,
    executionPath,
    exitWhenDone: options.exitWhenDone === true,
  });
}

function followStart(
  sessionDirectory: string,
  cursor: number | null,
  selection: { executionId: string | null; jsonLines: boolean },
): FollowStart {
  if (cursor !== null) return { cursor, tailOnly: false, streamOffsets: null };
  // Snapshot and the notice can block. Capture offsets first so lines written then are still tailed.
  const streamOffsets = new Map(listStreamFiles(sessionDirectory).map((stream) => [stream, fileSize(stream)]));
  const eventsCursor = fileSize(path.join(sessionDirectory, 'events.jsonl'));
  printSnapshot(sessionDirectory, selection, eventsCursor);
  return { cursor: eventsCursor, tailOnly: true, streamOffsets };
}

async function pollSession(
  sessionDirectory: string,
  start: FollowStart,
  watch: WatchState,
): Promise<number> {
  const unbind = bindCancellationSignals();
  const logs = openFollowLogs(sessionDirectory, path.join(sessionDirectory, 'events.jsonl'), start);
  try {
    for (;;) {
      const exit = pollOnce(sessionDirectory, logs, watch);
      if (exit === 'more') continue;
      if (exit !== null) return exit;
      await delay(POLL_MS);
    }
  } catch (error) {
    if (error instanceof CancellationRequested) {
      log(error.message);
      return EXIT_CANCELLED;
    }
    throw error;
  } finally {
    for (const log of logs) closeSync(log.fd);
    unbind();
  }
}

/** Emits new lines; 'more' when some were read, else the exit code once done, or null to wait. */
function pollOnce(
  sessionDirectory: string,
  logs: OpenLog[],
  watch: WatchState,
): number | 'more' | null {
  const emitBatch = (batch: readonly FollowLine[]): void => {
    for (const item of batch) emitWatchEvent(item.line, watch.executionId, watch.jsonLines);
  };
  throwIfCliCancelled();
  discoverStreams(sessionDirectory, logs);
  const batch = readBatch(logs);
  emitBatch(batch);
  if (batch.length > 0) return 'more';
  const exit = followExit(sessionDirectory, watch);
  if (exit !== null) emitBatch(readBatch(logs));
  return exit;
}

/** Checks the session can be followed and reaps orphans; returns the execution file to watch, if any. */
function prepareFollow(
  workspace: string,
  sessionId: string,
  options: { once: boolean; executionId: string | null },
): string | null {
  const sessionDirectory = path.join(workspace, '.migent', 'sessions', sessionId);
  const eventsPath = path.join(sessionDirectory, 'events.jsonl');
  const statusPath = path.join(sessionDirectory, 'status.json');
  if (readStatusFileState(statusPath).state === 'corrupt') {
    throw new ConfigurationError(corruptStatusMessage(statusPath));
  }
  if (!isFile(eventsPath) && !(options.once && isFile(path.join(sessionDirectory, 'status.json')))) {
    throw new ConfigurationError(`No events found for session: ${sessionId}`);
  }
  // Reaping writes, so it needs the session lock. A live holder keeps the session; follow then tails read-only.
  const reapLock = SessionLock.tryAcquire(sessionDirectory);
  if (reapLock !== null) {
    try {
      new SessionStore(workspace).reapOrphanedExecutions(sessionId, 'ignore');
    } finally {
      reapLock.release();
    }
  }
  if (options.executionId === null) return null;
  const resolved = path.join(sessionDirectory, 'executions', options.executionId, 'execution.json');
  if (!isFile(resolved)) throw new ConfigurationError(`No execution found: ${options.executionId}`);
  return resolved;
}

/** The exit code once an idle poll finds the followed execution or session done; null to keep polling. */
function followExit(
  sessionDirectory: string,
  stop: { untilTerminal: boolean; executionPath: string | null; exitWhenDone: boolean },
): number | null {
  if (stop.untilTerminal) {
    if (stop.executionPath === null) throw new ConfigurationError('--until requires --execution.');
    const record = readExecutionFile(stop.executionPath);
    if (record !== null && TERMINAL_EXECUTION_STATUSES.has(String(record.status))) {
      return untilTerminalExitCode(record);
    }
  }
  if (stop.exitWhenDone) {
    const status = String(watchSnapshot(sessionDirectory, null).status ?? '');
    const done = exitFor(status);
    if (done !== null) return done;
  }
  return null;
}

function printSnapshot(
  sessionDirectory: string,
  selection: { executionId: string | null; jsonLines: boolean },
  eventsCursor?: number,
): Record<string, unknown> {
  const { executionId, jsonLines } = selection;
  const snapshot = watchSnapshot(sessionDirectory, executionId);
  if (eventsCursor !== undefined) snapshot.events_cursor = eventsCursor;
  if (jsonLines) writeJson(eventsCursor === undefined ? SessionSnapshot : SessionSnapshotLine, snapshotJson(snapshot));
  else printWatchSnapshot(snapshot);
  return snapshot;
}

function snapshotJson(snapshot: Record<string, unknown>): Static<typeof SessionSnapshot> {
  const body = { ...snapshot };
  delete body.task;
  return body as Static<typeof SessionSnapshot>;
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
    writeJson(SessionFollowRecord, event);
    return;
  }
  printWatchEvent(event);
}

function untilTerminalExitCode(record: Record<string, unknown>): number {
  if (record.status === 'skipped') return 0;
  if (record.status === 'completed') {
    const {outcome} = record;
    if (isRecord(outcome) && outcome.status === 'complete') return 0;
    const stop = isRecord(outcome) ? stageStopStatus({ outcomeStatus: String(outcome.status) }) : null;
    if (stop === 'question') return exitFor(stop) ?? EXIT_QUESTION;
    return 1;
  }
  return 1;
}

interface OpenLog {
  path: string;
  fd: number;
  offset: number;
  pending: string;
  minTimestampMs: number | null;
  source: 'events' | 'stream';
}

function openFollowLogs(
  sessionDirectory: string,
  eventsPath: string,
  follow: { cursor: number; tailOnly: boolean; streamOffsets: ReadonlyMap<string, number> | null },
): OpenLog[] {
  const { cursor, tailOnly, streamOffsets } = follow;
  const eventsText = !tailOnly && cursor > 0 ? readText(eventsPath) : '';
  const logs: OpenLog[] = [openLog(eventsPath, { offset: cursor, minTimestampMs: null, source: 'events' })];
  for (const stream of listStreamFiles(sessionDirectory)) {
    const start = tailOnly
      ? { offset: tailOffset(stream, streamOffsets), minTimestampMs: null }
      : streamFollowStart(cursor, eventsText, fileSize(stream));
    logs.push(openLog(stream, { offset: start.offset, minTimestampMs: start.minTimestampMs, source: 'stream' }));
  }
  return logs;
}

function tailOffset(stream: string, streamOffsets: ReadonlyMap<string, number> | null): number {
  if (streamOffsets === null) return fileSize(stream);
  return streamOffsets.get(stream) ?? 0;
}

function discoverStreams(sessionDirectory: string, logs: OpenLog[]): void {
  const known = new Set(logs.map((log) => log.path));
  for (const stream of listStreamFiles(sessionDirectory)) {
    if (known.has(stream)) continue;
    logs.push(openLog(stream, { offset: 0, minTimestampMs: null, source: 'stream' }));
  }
}

function readBatch(logs: OpenLog[]): FollowLine[] {
  const batch: FollowLine[] = [];
  for (const log of logs) {
    const read = readCompleteLines(log.fd, log.offset, log.pending);
    log.offset = read.position;
    log.pending = read.pending;
    // A later poll can finish a torn line that is older than the cursor anchor.
    const lines = read.lines.filter((line) => includeStreamLine(line, log.minTimestampMs));
    for (const line of lines) batch.push({ line, source: log.source, path: log.path });
  }
  batch.sort(compareFollowLines);
  return batch;
}

function openLog(filePath: string, start: { offset: number; minTimestampMs: number | null; source: 'events' | 'stream' }): OpenLog {
  const { offset, minTimestampMs, source } = start;
  return { path: filePath, fd: openSync(filePath, 'r'), offset, pending: '', minTimestampMs, source };
}

function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function readText(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readCompleteLines(
  fd: number,
  position: number,
  carried: string,
): { lines: string[]; pending: string; position: number } {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  let offset = position;
  for (;;) {
    const count = readSync(fd, buffer, 0, buffer.length, offset);
    if (count <= 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, count)));
    offset += count;
  }
  if (chunks.length === 0) return { lines: [], pending: carried, position };
  const pieces = (carried + Buffer.concat(chunks).toString('utf8')).split('\n');
  const rest = pieces.pop() ?? '';
  return { lines: pieces, pending: rest, position: offset };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
