import { readRecordedDiagnostics } from "@nodeint/migent-kernel";
import type { Check } from "./check.js";

const STDERR_LINES = 5;

/**
 * Recorded provider diagnostics, latest per stage. They describe the past, so they are warnings:
 * the cause may already be fixed.
 */
export function sessionDiagnosticsCheck(workspace: string, sessionId: string): Check {
  const check: Check = { name: "Provider diagnostics", ok: true, items: [], problems: [], warnings: [] };
  for (const entry of readRecordedDiagnostics(workspace, sessionId)) {
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
