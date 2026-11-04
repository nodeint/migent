import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Check } from "./doctor.js";
import { EXECUTIONS_DIRNAME, SESSIONS_DIRNAME, MIGENT_DIRNAME } from "./runtime.js";

const DIAGNOSTICS_FILE = "diagnostics.json";
const STDERR_LINES = 5;

function readObject(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Path of the latest recorded diagnostics of a session, relative to the session directory. */
export function latestDiagnosticsPath(workspace: string, sessionId: string): string | null {
  return latestDiagnosticsPathIn(path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME, sessionId));
}

/** Same, from a session directory. */
export function latestDiagnosticsPathIn(sessionDirectory: string): string | null {
  const last = latestPerStageIn(sessionDirectory).sort((a, b) => b.order - a.order)[0];
  return last ? last.relative : null;
}

function latestPerStage(workspace: string, sessionId: string) {
  return latestPerStageIn(path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME, sessionId));
}

function latestPerStageIn(sessionDirectory: string) {
  const root = path.join(sessionDirectory, EXECUTIONS_DIRNAME);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const byStage = new Map<string, { order: number; file: string; relative: string; data: Record<string, unknown> }>();
  for (const name of names) {
    const file = path.join(root, name, DIAGNOSTICS_FILE);
    if (!existsSync(file)) continue;
    const data = readObject(file);
    if (data === null) continue;
    const metadata = readObject(path.join(root, name, "execution.json")) ?? {};
    const stage = typeof metadata.stage_id === "string" ? metadata.stage_id : name;
    const order = typeof metadata.execution_order === "number" ? metadata.execution_order : 0;
    const current = byStage.get(stage);
    if (current && current.order > order) continue;
    byStage.set(stage, {
      order,
      file,
      relative: path.posix.join(EXECUTIONS_DIRNAME, name, DIAGNOSTICS_FILE),
      data,
    });
  }
  return [...byStage.values()];
}

/**
 * Recorded provider diagnostics, latest per stage. They describe the past, so they are warnings:
 * the cause may already be fixed.
 */
export function sessionDiagnosticsCheck(workspace: string, sessionId: string): Check {
  const check: Check = { name: "Provider diagnostics", ok: true, items: [], problems: [], warnings: [] };
  for (const entry of latestPerStage(workspace, sessionId)) {
    const failure = (entry.data.failure ?? {}) as Record<string, unknown>;
    const parts = ["kind", "phase", "code"].flatMap((key) => (typeof failure[key] === "string" ? [`${key}=${String(failure[key])}`] : []));
    const stderr = typeof entry.data.stderr_tail === "string" ? entry.data.stderr_tail : "";
    const lines = stderr.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-STDERR_LINES);
    const message = typeof failure.message === "string" ? failure.message : "provider failure recorded";
    const detail = [message, parts.join(" "), ...lines.map((line) => `stderr: ${line}`), `file: ${entry.relative}`]
      .filter((text) => text.length > 0)
      .join("\n  ");
    check.warnings.push(detail);
  }
  if (check.warnings.length === 0) check.items.push("No recorded provider diagnostics.");
  return check;
}
