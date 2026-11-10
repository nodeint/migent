import { isRecord } from "@nodeint/migent-workflow";
import type { ParsedEvent } from "./session-events.js";

export function detailsOf(event: ParsedEvent | undefined): Record<string, unknown> {
  if (event === undefined) return {};
  return isRecord(event.raw.details) ? event.raw.details : {};
}

export function coerceNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return value;
}

export function parseTime(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function elapsedMs(start: string | null, end: string | null): number | null {
  const started = parseTime(start);
  const finished = parseTime(end);
  if (started === null || finished === null) return null;
  return finished - started;
}

export function wallSeconds(start: string | null, end: string | null): number | null {
  const elapsed = elapsedMs(start, end);
  return elapsed === null ? null : roundSeconds(elapsed);
}

export function roundSeconds(milliseconds: number): number {
  return Math.round((milliseconds / 1000) * 10) / 10;
}
