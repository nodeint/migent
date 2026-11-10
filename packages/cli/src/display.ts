import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Check } from "@nodeint/migent-doctor";
import { CORRECTION_FAILURE_REASONS } from "@nodeint/migent-kernel";
import { FAILURE_FILENAME } from "@nodeint/migent-session";
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

export function printReplyCommand(sessionId: string, stageId?: string, purpose: "answer" | "steer" = "answer"): void {
  const stage = stageId ? ` --stage ${stageId}` : "";
  process.stderr.write(`Reply with:\nmigent session continue ${sessionId}${stage} --reply "<answer>"\n`);
}

export function formatQuestion(question: Record<string, unknown>): string {
  const mode = question.selection === "multiple" ? "choose one or more" : "choose one";
  const stage = typeof question.stage_id === "string" ? `; stage ${question.stage_id}` : "";
  const number = String(question.id);
  const lines = [`${number}. ${String(question.question)} (${mode}${stage})`, String(question.context)];
  const recommended = Array.isArray(question.recommended) ? question.recommended : [];
  for (const option of Array.isArray(question.options) ? question.options.filter(isRecord) : []) {
    const note = recommended.includes(option.id) ? " (recommended)" : "";
    lines.push(`  ${String(option.id)}. ${String(option.label)}${note}${option.description ? ` — ${String(option.description)}` : ""}`);
  }
  lines.push("  A free-text answer is always allowed.");
  lines.push(`  Answer: ${number}${question.selection === "multiple" ? "A+B" : "A"} or ${number} <free text>.`);
  return lines.join("\n");
}

export function printCreated(paths: readonly string[], summary: string): void {
  process.stdout.write("Created:\n");
  for (const filePath of paths) process.stdout.write(`  ${filePath}\n`);
  process.stdout.write(`Using ${summary}\n`);
}

export function printInitNextSteps(): void {
  process.stdout.write("Install the Migent skill for this project's clients (optional):\n");
  process.stdout.write("  migent skill install --project\n");
  process.stdout.write("Start a workflow, replacing the task text with what you want done:\n");
  process.stdout.write('  migent session run --workflow implement --task "<what you want done>"\n');
}

export function printAlreadyInitialized(): void {
  process.stdout.write("Already initialized.\n");
}

export function printInitConflicts(paths: readonly string[]): void {
  printError("existing files block init.");
  for (const filePath of paths) process.stderr.write(`  ${filePath}\n`);
}

export function printDoctor(checks: readonly Check[], out: NodeJS.WriteStream = process.stdout): void {
  const tty = Boolean(out.isTTY);
  for (const check of checks) {
    const status = check.ok ? (tty ? pc.green("ok") : "ok") : tty ? pc.red("failed") : "failed";
    out.write(`${check.name.padEnd(12)}${status}\n`);
    for (const item of check.items) {
      const line = `  ${item}`;
      out.write(`${tty ? pc.dim(line) : line}\n`);
    }
    for (const problem of check.problems) out.write(`  ${problem.replaceAll("\n", "\n  ")}\n`);
    for (const warning of check.warnings) out.write(`  warning: ${warning.replaceAll("\n", "\n  ")}\n`);
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

export function printAgent(
  result: Record<string, unknown>,
  role: string,
  client: string,
  model: string,
  workspace: string | null = null,
): void {
  const decision = String(result.outcome_decision ?? "");
  let outcome = String(result.outcome_status ?? "failed");
  if (decision) outcome = `${outcome} ${decision}`;
  const rows: Array<[string, string]> = [
    ["role", role],
    ["model", `${client}/${model}`],
    ["outcome", outcome],
    ["session", String(result.session_id ?? "")],
    ["execution", String(result.execution_id ?? "")],
  ];
  for (const [label, value] of rows) process.stdout.write(`${label}  ${value}\n`);
  const failurePath = failureArtifactPath(workspace, result);
  if (failurePath !== null) process.stdout.write(`failure  ${failurePath}\n`);
  if (result.outcome_status === "question") {
    for (const question of Array.isArray(result.questions) ? result.questions.filter(isRecord) : []) {
      process.stdout.write(`${formatQuestion(question)}\n`);
    }
    if (typeof result.questions_file === "string") process.stdout.write(`questions  ${result.questions_file}\n`);
  }
  if (typeof result.failure_reason === "string" && CORRECTION_FAILURE_REASONS.includes(result.failure_reason) && typeof result.failure_detail === "string") {
    process.stdout.write(`error  ${result.failure_detail}\n`);
  }
}

function failureArtifactPath(workspace: string | null, result: Record<string, unknown>): string | null {
  if (workspace === null) return null;
  const failed =
    result.execution_status === "failed" ||
    (typeof result.failure_reason === "string" && result.failure_reason !== "");
  if (!failed) return null;
  const sessionId = typeof result.session_id === "string" ? result.session_id : "";
  const executionId = typeof result.execution_id === "string" ? result.execution_id : "";
  if (sessionId === "" || executionId === "") return null;
  const relative = `executions/${executionId}/${FAILURE_FILENAME}`;
  const absolute = path.join(workspace, ".migent", "sessions", sessionId, relative);
  return existsSync(absolute) ? relative : null;
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
  const exitAnomalies = Array.isArray(snapshot.exit_anomalies) ? snapshot.exit_anomalies.filter(isRecord) : [];
  for (const anomaly of exitAnomalies) lines.push(["exit_anomaly", formatExitAnomaly(anomaly)]);
  if (typeof snapshot.blocker === "string" && snapshot.blocker) lines.push(["blocked", snapshot.blocker]);
  const questions = Array.isArray(snapshot.questions) ? snapshot.questions.filter(isRecord) : [];
  for (const item of questions) lines.push(["question", formatQuestion(item)]);
  const skippedStages = Array.isArray(snapshot.skipped_stages) ? snapshot.skipped_stages.filter(isRecord) : [];
  if (skippedStages.length > 0) {
    lines.push(["skipped", skippedStages.map((stage) => String(stage.stage_id ?? "")).join(", ")]);
  }
  const outcome = snapshot.outcome;
  if (isRecord(outcome) && typeof outcome.status === "string") {
    lines.push(["outcome", outcome.status]);
    if (typeof outcome.decision === "string" && outcome.decision) lines.push(["decision", outcome.decision]);
  }
  const quotaFailures = Array.isArray(snapshot.quota_failures) ? snapshot.quota_failures.filter(isRecord) : [];
  for (const quota of quotaFailures) {
    const parts = [
      typeof quota.stage_id === "string" ? quota.stage_id : "",
      typeof quota.message === "string" ? quota.message : "",
      typeof quota.reset_at === "string" ? `resets at ${quota.reset_at}` : "",
      typeof quota.window === "string" ? `window ${quota.window}` : "",
    ].filter((item) => item !== "");
    lines.push(["quota", parts.join(" · ") || "reported"]);
  }
  if (typeof snapshot.diagnostics === "string" && snapshot.diagnostics) lines.push(["diagnostics", snapshot.diagnostics]);
  lines.push(["updated_at", formatWatchTimestamp(snapshot.updated_at)]);
  const outputs = snapshot.outputs;
  const missing = Array.isArray(snapshot.outputs_not_produced) ? snapshot.outputs_not_produced.map(String) : [];
  const published = isRecord(outputs) ? Object.keys(outputs) : [];
  if (published.length > 0 || missing.length > 0) {
    lines.push(["outputs", [...published, ...missing.map((name) => `${name} (not produced)`)].join(", ")]);
  } else lines.push(["outputs", "none"]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatExitAnomaly(anomaly: Record<string, unknown>): string {
  const parts = [String(anomaly.stage_id ?? ""), String(anomaly.execution_id ?? "")];
  if (typeof anomaly.turn === "number") parts.push(`turn ${anomaly.turn}`);
  if (typeof anomaly.exit_code === "number") parts.push(`exit ${anomaly.exit_code}`);
  parts.push(anomaly.accepted === true ? "accepted" : "rejected");
  if (typeof anomaly.count === "number" && anomaly.count > 1) parts.push(`×${anomaly.count}`);
  if (typeof anomaly.diagnostics === "string" && anomaly.diagnostics) parts.push(anomaly.diagnostics);
  return parts.join(" · ");
}
