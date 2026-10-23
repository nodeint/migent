import { createRequire } from "node:module";
import type { Check } from "@nodeint/migent-kernel";
import { sessionFields } from "./session-row.js";

const require = createRequire(import.meta.url);
const pc = require("picocolors") as {
  bold: (value: string) => string;
  cyan: (value: string) => string;
  red: (value: string) => string;
  green: (value: string) => string;
  dim: (value: string) => string;
};

export function printError(message: string): void {
  const tty = Boolean(process.stderr.isTTY);
  const prefix = tty ? pc.red(pc.bold("migent: ")) : "migent: ";
  process.stderr.write(`${prefix}${message}\n`);
}

export function printNotice(message: string): void {
  const tty = Boolean(process.stderr.isTTY);
  const prefix = tty ? pc.cyan(pc.bold("[migent] ")) : "[migent] ";
  process.stderr.write(`${prefix}${message}\n`);
}

export function printResumeCommand(sessionId: string): void {
  process.stderr.write(`Resume with:\nmigent session continue ${sessionId}\n`);
}

export function printCreated(paths: readonly string[], nextCommand: string): void {
  process.stdout.write("Created:\n");
  for (const filePath of paths) process.stdout.write(`  ${filePath}\n`);
  process.stdout.write("Next:\n");
  process.stdout.write(`  ${nextCommand}\n`);
}

export function printAlreadyInitialized(): void {
  process.stdout.write("Already initialized.\n");
}

export function printInitConflicts(paths: readonly string[]): void {
  printError("existing files block init.");
  for (const filePath of paths) process.stderr.write(`  ${filePath}\n`);
}

export function printDoctor(checks: readonly Check[]): void {
  const tty = Boolean(process.stdout.isTTY);
  for (const check of checks) {
    const status = check.ok ? (tty ? pc.green("ok") : "ok") : tty ? pc.red("failed") : "failed";
    process.stdout.write(`${check.name.padEnd(12)}${status}\n`);
    for (const item of check.items) {
      const line = `  ${item}`;
      process.stdout.write(`${tty ? pc.dim(line) : line}\n`);
    }
    for (const problem of check.problems) process.stdout.write(`  ${problem}\n`);
    for (const warning of check.warnings) process.stdout.write(`  warning: ${warning}\n`);
  }
}

export function printSessions(rows: readonly string[][]): void {
  if (rows.length === 0) {
    process.stdout.write("No sessions.\n");
    return;
  }
  for (const row of rows) {
    const fields = sessionFields(row);
    const identity =
      fields.title !== "" && fields.title !== fields.session ? `${fields.title}  ${fields.session}` : fields.session;
    process.stdout.write(
      `${identity}  ${fields.workflow}  ${fields.status}  ${fields.execution}  ${fields.decision}  ${fields.outputs}  ${fields.task}\n`,
    );
  }
}

export function printAgent(result: Record<string, unknown>, role: string, provider: string, model: string): void {
  const decision = String(result.outcome_decision ?? "");
  let outcome = String(result.outcome_status ?? "failed");
  if (decision) outcome = `${outcome} ${decision}`;
  const rows: Array<[string, string]> = [
    ["role", role],
    ["model", `${provider}/${model}`],
    ["outcome", outcome],
    ["session", String(result.session_id ?? "")],
    ["execution", String(result.execution_id ?? "")],
  ];
  for (const [label, value] of rows) process.stdout.write(`${label}  ${value}\n`);
}

export function printWatchSnapshot(snapshot: Record<string, unknown>): void {
  const lines: Array<[string, string]> = [
    ["session_id", String(snapshot.session_id ?? "--")],
    ["status", String(snapshot.status ?? "unknown")],
  ];
  const title = snapshot.title;
  if (typeof title === "string" && title !== "" && title !== lines[0]?.[1]) {
    lines.splice(1, 0, ["title", title]);
  }
  if (typeof snapshot.workflow_id === "string" && snapshot.workflow_id) {
    lines.push(["workflow", snapshot.workflow_id]);
  }
  if (typeof snapshot.task === "string" && snapshot.task) lines.push(["task", snapshot.task]);
  const running = Array.isArray(snapshot.running_stages) ? snapshot.running_stages.filter(isRecord) : [];
  if (running.length > 0) {
    for (const stage of running) {
      const stageId = typeof stage.stage_id === "string" && stage.stage_id ? stage.stage_id : "stage";
      const executionId = typeof stage.execution_id === "string" ? stage.execution_id : "";
      const summary = typeof stage.summary === "string" && stage.summary ? ` · ${stage.summary}` : "";
      lines.push(["running", `${stageId} · ${executionId}${summary}`]);
    }
  } else {
    const executionId = snapshot.execution_id;
    const executionStatus = snapshot.execution_status ?? snapshot.latest_execution_status;
    if (typeof executionId === "string" && executionId) {
      const value =
        typeof executionStatus === "string" && executionStatus
          ? `${executionId} · ${executionStatus}`
          : executionId;
      lines.push(["execution", value]);
    }
  }
  const outcome = snapshot.outcome;
  if (isRecord(outcome) && typeof outcome.status === "string") {
    lines.push(["outcome", outcome.status]);
    if (typeof outcome.decision === "string" && outcome.decision) lines.push(["decision", outcome.decision]);
  }
  lines.push(["updated_at", formatWatchTimestamp(snapshot.updated_at)]);
  const outputs = snapshot.outputs;
  if (isRecord(outputs) && Object.keys(outputs).length > 0) lines.push(["outputs", Object.keys(outputs).join(", ")]);
  else lines.push(["outputs", "none"]);
  lines.push(["events_cursor", String(snapshot.events_cursor ?? 0)]);
  for (const [label, value] of lines) process.stdout.write(`${label}  ${value}\n`);
}

export function printWatchEvent(event: Record<string, unknown>): void {
  const eventName = event.event;
  const stageId = event.stage_id;
  if (typeof eventName !== "string" || typeof stageId !== "string") return;
  const summary = typeof event.summary === "string" && event.summary ? ` · ${event.summary}` : "";
  const label = eventName.replace(/^provider\./, "").replaceAll("_", " ");
  process.stdout.write(`${formatWatchTimestamp(event.timestamp)} ${stageId} ${label}${summary}\n`);
}

export function formatWatchTimestamp(timestamp: unknown): string {
  if (typeof timestamp !== "string" || timestamp.trim() === "") return "--";
  let text = timestamp.trim();
  if (text.endsWith("Z")) text = `${text.slice(0, -1)}+00:00`;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return timestamp.trim();
  return parsed.toISOString().replace("T", " ").replace(/\.\d+Z$/, "+00:00").replace("Z", "+00:00");
}

export interface ProviderRow {
  name: string;
  command: string;
  path: string | null;
  available: boolean;
  models: string[];
  default_model: string | null;
  options: Array<{ name: string; prompt: boolean; allow_default: boolean; overridable: boolean }>;
  problems: string[];
}

export function printProviders(rows: readonly ProviderRow[]): void {
  const tty = Boolean(process.stdout.isTTY);
  for (const row of rows) {
    const ok = row.problems.length === 0 && row.models.length > 0;
    const status = ok ? (tty ? pc.green("ok") : "ok") : tty ? pc.red("failed") : "failed";
    process.stdout.write(`${row.name.padEnd(12)}${status}\n`);
    if (row.path !== null) {
      const line = `  path: ${row.path}`;
      process.stdout.write(`${tty ? pc.dim(line) : line}\n`);
    } else {
      const line = `  path: not found`;
      process.stdout.write(`${tty ? pc.dim(line) : line}\n`);
    }
    if (row.models.length > 0) {
      process.stdout.write(`  models:\n`);
      for (const model of row.models) {
        const marked = model === row.default_model ? `${model} (default)` : model;
        const line = `    ${marked}`;
        process.stdout.write(`${tty ? pc.dim(line) : line}\n`);
      }
    }
    if (row.options.length > 0) {
      process.stdout.write(`  options:\n`);
      for (const opt of row.options) {
        const line = `    ${opt.name}`;
        process.stdout.write(`${tty ? pc.dim(line) : line}\n`);
      }
    }
    for (const problem of row.problems) {
      process.stdout.write(`  ${problem}\n`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
