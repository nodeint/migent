import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  AgentToolRunner,
  DEFAULT_MAX_DISPATCHES,
  executeNamedWorkflow,
  formatDuration,
  log,
  type ExecuteResult,
} from "@nodeint/migent-kernel";
import { printResumeCommand } from "../display.js";
import { cliHooks } from "../hooks.js";
import { requireCurrentSchema } from "../migrate.js";
import { providerMap } from "../provider.js";
import { text } from "../text.js";

export interface ExecuteWorkflowOptions {
  action: string;
  workflowId?: string | null;
  task?: string | null;
  sessionId?: string | null;
  priorSessionId?: string | null;
  maxDispatches?: number | null;
  continueFailed?: boolean;
  stageId?: string | null;
  runner?: AgentToolRunner | null;
  itemProgress?: boolean;
  startPrepared?: boolean;
  refreshWorkflow?: boolean;
  reply?: string | null;
}

export async function executeWorkflow(workspace: string, options: ExecuteWorkflowOptions): Promise<number> {
  requireCurrentSchema(workspace);
  const once = options.action === "stage";
  const startPrepared = options.startPrepared === true;
  const sessionId = text(options.sessionId);
  const creating = !startPrepared && (options.action === "start" || (once && sessionId === null));
  const maxDispatches = options.maxDispatches === undefined ? DEFAULT_MAX_DISPATCHES : options.maxDispatches;
  const runner = options.runner ?? cliHooks.runner ?? new AgentToolRunner(providerMap());
  runner.itemProgress = options.itemProgress === true;
  const result = await executeNamedWorkflow(
    workspace,
    {
      workflowId: creating || startPrepared ? (options.workflowId ?? null) : null,
      task: creating ? (options.task ?? null) : null,
      sessionId: creating ? null : sessionId,
      priorSessionId: options.priorSessionId ?? null,
      startPrepared,
      maxDispatches: once ? null : maxDispatches,
      continueFailed: options.continueFailed === true,
      stageId: options.stageId ?? null,
      once,
      resetRevisions: options.action === "continue",
      refreshWorkflow: options.refreshWorkflow === true,
      reply: options.reply ?? null,
    },
    runner,
  );
  printResult(workspace, result);
  printResumeHint(result);
  return result.code;
}

function printResumeHint(result: ExecuteResult): void {
  if (result.sessionId === "" || result.status === "completed" || result.stopReason === "completed") return;
  if (result.stopReason === "configuration") return;
  printResumeCommand(result.sessionId);
}

const INSPECT_EXIT_CODES = new Set([1, 3, 6, 8]);

function printResult(workspace: string, result: ExecuteResult): void {
  if (result.status === "completed" || result.stopReason === "completed") {
    const duration = sessionDurationLabel(workspace, result.sessionId);
    log(duration === null ? "completed" : `completed · ${duration}`);
    for (const filePath of artifactPaths(workspace, result.sessionId, result.outputs)) {
      log(`artifact: ${filePath}`);
    }
    return;
  }
  if (INSPECT_EXIT_CODES.has(result.code) && result.latestExecutionId) {
    log(`response: executions/${result.latestExecutionId}/response.md`);
  }
  if (result.code === 7 && result.latestExecutionId) {
    log(`verify: executions/${result.latestExecutionId}/turns/01/verify.md`);
  }
}

function artifactPaths(workspace: string, sessionId: string, outputs: Record<string, unknown>): string[] {
  if (sessionId === "") return [];
  const sessionDir = path.resolve(workspace, ".migent", "sessions", sessionId);
  const paths: string[] = [];
  for (const [name, value] of Object.entries(outputs)) {
    const record = isRecord(value) ? value : {};
    const relative = typeof record.path === "string" && record.path !== "" ? record.path : path.join("outputs", name);
    paths.push(absoluteFromRoot(path.resolve(sessionDir, relative)));
  }
  return paths;
}

function absoluteFromRoot(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function sessionDurationLabel(workspace: string, sessionId: string): string | null {
  if (sessionId === "") return null;
  const executions = path.join(workspace, ".migent", "sessions", sessionId, "executions");
  let names: string[];
  try {
    names = readdirSync(executions);
  } catch {
    return null;
  }
  let total = 0;
  let counted = false;
  for (const name of names) {
    const elapsed = executionElapsedMs(path.join(executions, name, "execution.json"));
    if (elapsed === null) continue;
    total += elapsed;
    counted = true;
  }
  return counted ? formatDuration(total) : null;
}

function executionElapsedMs(filePath: string): number | null {
  try {
    const metadata = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(metadata)) return null;
    const started = parsedTime(metadata.created_at);
    if (started === null) return null;
    return (parsedTime(metadata.completed_at) ?? Date.now()) - started;
  } catch {
    return null;
  }
}

function parsedTime(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


