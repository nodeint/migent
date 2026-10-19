import { readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface FollowLine {
  line: string;
  source: "events" | "stream";
  path: string;
}

export interface StreamFollowStart {
  offset: number;
  /** Skip stream lines whose timestamp parses earlier than this. The floor stays for later polls. */
  minTimestampMs: number | null;
}

/**
 * Where to start reading one execution stream.
 * `--cursor` is a byte offset into events.jsonl. Stream lines are selected by timestamp.
 * A stream created after follow starts is not passed here: the caller reads it from offset 0.
 */
export function streamFollowStart(cursor: number | null, eventsText: string, streamSize: number): StreamFollowStart {
  if (cursor === null) return { offset: streamSize, minTimestampMs: null };
  if (cursor === 0) return { offset: 0, minTimestampMs: null };
  const anchor = firstCompleteEvent(eventsText, cursor);
  if (anchor === null) return { offset: streamSize, minTimestampMs: null };
  const ms = Date.parse(anchor.timestamp);
  return { offset: 0, minTimestampMs: Number.isNaN(ms) ? null : ms };
}

export function includeStreamLine(line: string, minTimestampMs: number | null): boolean {
  if (minTimestampMs === null) return true;
  const timestamp = eventTimestamp(line);
  if (timestamp === null) return true;
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return true;
  return ms >= minTimestampMs;
}

export function compareFollowLines(left: FollowLine, right: FollowLine): number {
  const a = sortKey(left);
  const b = sortKey(right);
  if (a.time !== b.time) return a.time - b.time;
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.source !== b.source) return a.source - b.source;
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

/** Lines follow would emit for this cursor, including a stream that appeared after the start. */
export function replayFollowLines(input: {
  cursor: number | null;
  eventsText: string;
  streams: Array<{ path: string; text: string; appearedAfterStart?: boolean }>;
}): string[] {
  const eventsSize = Buffer.byteLength(input.eventsText);
  const eventOffset = input.cursor === null ? eventsSize : input.cursor;
  const lines: FollowLine[] = linesFromByte(input.eventsText, eventOffset).map((line) => ({
    line,
    source: "events",
    path: "events.jsonl",
  }));
  for (const stream of input.streams) {
    const size = Buffer.byteLength(stream.text);
    const start = stream.appearedAfterStart
      ? { offset: 0, minTimestampMs: null }
      : streamFollowStart(input.cursor, input.eventsText, size);
    for (const line of linesFromByte(stream.text, start.offset)) {
      if (!includeStreamLine(line, start.minTimestampMs)) continue;
      lines.push({ line, source: "stream", path: stream.path });
    }
  }
  lines.sort(compareFollowLines);
  return lines.map((item) => item.line);
}

export function listStreamFiles(sessionDirectory: string): string[] {
  const root = path.join(sessionDirectory, "executions");
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || (entry.name.startsWith(".") && entry.name.endsWith(".tmp"))) continue;
    const stream = path.join(root, entry.name, "stream.jsonl");
    try {
      if (statSync(stream).isFile()) files.push(stream);
    } catch {
      // This execution has no stream yet.
    }
  }
  files.sort();
  return files;
}

function firstCompleteEvent(eventsText: string, cursor: number): { timestamp: string } | null {
  for (const entry of lineSpans(eventsText)) {
    if (entry.start < cursor) continue;
    const timestamp = eventTimestamp(entry.line);
    if (timestamp === null && !isEventLine(entry.line)) continue;
    if (!isEventLine(entry.line)) continue;
    return { timestamp: timestamp ?? "" };
  }
  return null;
}

function isEventLine(line: string): boolean {
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) && typeof value.event === "string" && value.event !== "";
  } catch {
    return false;
  }
}

function eventTimestamp(line: string): string | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value) || typeof value.event !== "string") return null;
    return typeof value.timestamp === "string" ? value.timestamp : "";
  } catch {
    return null;
  }
}

function sortKey(item: FollowLine): { time: number; seq: number; source: number; path: string } {
  let time = Number.POSITIVE_INFINITY;
  let seq = Number.POSITIVE_INFINITY;
  try {
    const value = JSON.parse(item.line) as unknown;
    if (isRecord(value)) {
      if (typeof value.timestamp === "string") {
        const parsed = Date.parse(value.timestamp);
        if (!Number.isNaN(parsed)) time = parsed;
      }
      if (typeof value.seq === "number" && Number.isFinite(value.seq)) seq = value.seq;
    }
  } catch {
    // Unparseable lines sort after timed events and stay in source order.
  }
  return { time, seq, source: item.source === "events" ? 0 : 1, path: item.path };
}

function linesFromByte(text: string, offset: number): string[] {
  const buffer = Buffer.from(text);
  if (offset >= buffer.length || offset < 0) return offset < 0 ? linesFromByte(text, 0) : [];
  const slice = buffer.subarray(offset).toString("utf8");
  const parts = slice.split("\n");
  if (!slice.endsWith("\n")) parts.pop();
  return parts.filter((line) => line !== "");
}

function lineSpans(text: string): Array<{ start: number; line: string }> {
  const buffer = Buffer.from(text);
  const spans: Array<{ start: number; line: string }> = [];
  let lineStart = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    const line = buffer.subarray(lineStart, index).toString("utf8");
    if (line !== "") spans.push({ start: lineStart, line });
    lineStart = index + 1;
  }
  return spans;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
