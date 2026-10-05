import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConfigurationError } from "./errors.js";
import { pyRepr, isRecord } from "./record.js";
import { readStatusFile } from "./query.js";
import { isUnicodeAlnum, utcNow } from "./runtime.js";
import { SessionStore } from "./session-store.js";
import { loadNamedWorkflow, type WorkflowDocument } from "./workflow.js";

function sessionWorkflowPath(workspace: string, workflow: WorkflowDocument): string {
  const source = workflow.source;
  if (source === null) return `.migent/workflows/${workflow.id}.yaml`;
  const workspaceReal = realPath(workspace);
  const sourceReal = realPath(source);
  const relative = path.relative(workspaceReal, sourceReal);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return sourceReal.split(path.sep).join("/");
  }
  return relative.split(path.sep).join("/");
}

function realPath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export function allocateSessionId(sessionsDirectory: string, sessionIdBase: string): string {
  let sessionId = sessionIdBase;
  let suffix = 2;
  while (exists(path.join(sessionsDirectory, sessionId))) {
    sessionId = `${sessionIdBase}--${String(suffix).padStart(2, "0")}`;
    suffix += 1;
  }
  return sessionId;
}

export function sessionSlug(value: string, limit: number): string {
  let slug = "";
  for (const character of value) {
    slug += isUnicodeAlnum(character) ? character.toLowerCase() : "-";
  }
  slug = slug
    .split("-")
    .filter((part) => part !== "")
    .join("-");
  if (!slug) {
    throw new ConfigurationError("Workflow ID and task must contain a letter or number.");
  }
  return slug.slice(0, limit).replace(/-+$/u, "");
}

export function createWorkflowSession(
  workspace: string,
  workflowId: string,
  task: string,
  priorSessionId?: string | null,
): string {
  const workflow = loadNamedWorkflow(workspace, workflowId);
  const resolvedId = workflow.id;
  const resolvedPrior = resolvePriorSessionId(workspace, workflow, priorSessionId);
  const taskSummary = task.trim();
  if (!taskSummary) throw new ConfigurationError("Task summary must not be empty.");
  const timestamp = utcStamp();
  const sessionIdBase = `${timestamp}--${sessionSlug(resolvedId, 36)}--${sessionSlug(taskSummary, 48)}`;
  const sessionsDirectory = path.join(workspace, ".migent", "sessions");
  const sessionId = allocateSessionId(sessionsDirectory, sessionIdBase);
  const sessionDirectory = path.join(sessionsDirectory, sessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  const createdAt = utcNow();
  const workflowRelativePath = sessionWorkflowPath(workspace, workflow);
  const manifestLines = [
    `session_id: ${sessionId}`,
    `workflow_id: ${resolvedId}`,
    `workflow_path: ${workflowRelativePath}`,
    `task: ${JSON.stringify(taskSummary)}`,
    `created_at: ${createdAt}`,
    "status: running",
  ];
  if (resolvedPrior) manifestLines.splice(manifestLines.length - 1, 0, `prior_session_id: ${resolvedPrior}`);
  writeFileSync(path.join(sessionDirectory, "manifest.yaml"), `${manifestLines.join("\n")}\n`, "utf8");
  const statusPayload: Record<string, unknown> = {
    session_id: sessionId,
    workflow_id: resolvedId,
    workflow_path: workflowRelativePath,
    task: taskSummary,
    status: "active",
    created_at: createdAt,
    updated_at: createdAt,
  };
  if (resolvedPrior) statusPayload.prior_session_id = resolvedPrior;
  writeJson(path.join(sessionDirectory, "status.json"), statusPayload);
  return sessionId;
}

export function createAgentSession(workspace: string, role: string, task: string): string {
  const taskSummary = task.trim();
  if (!taskSummary) throw new ConfigurationError("Task summary must not be empty.");
  const timestamp = utcStamp();
  const sessionIdBase = `${timestamp}--agent--${sessionSlug(taskSummary, 48)}`;
  const sessionsDirectory = path.join(workspace, ".migent", "sessions");
  const sessionId = allocateSessionId(sessionsDirectory, sessionIdBase);
  const sessionDirectory = path.join(sessionsDirectory, sessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  const createdAt = utcNow();
  writeFileSync(
    path.join(sessionDirectory, "manifest.yaml"),
    `${[
      `session_id: ${sessionId}`,
      "workflow_id: agent",
      `role: ${role}`,
      `task: ${JSON.stringify(taskSummary)}`,
      `created_at: ${createdAt}`,
      "status: running",
    ].join("\n")}\n`,
    "utf8",
  );
  writeJson(path.join(sessionDirectory, "status.json"), {
    session_id: sessionId,
    workflow_id: "agent",
    role,
    task: taskSummary,
    status: "active",
    created_at: createdAt,
    updated_at: createdAt,
  });
  return sessionId;
}

export function requireAgentSession(workspace: string, sessionId: string): void {
  const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
  if (!exists(sessionDirectory) || !isDirectory(sessionDirectory)) {
    throw new ConfigurationError(`Session not found: ${sessionId}.`);
  }
  let status: unknown;
  try {
    status = JSON.parse(readFileSync(path.join(sessionDirectory, "status.json"), "utf8"));
  } catch {
    throw new ConfigurationError(`Session ${sessionId} was not created by agent.`);
  }
  if (!isRecord(status) || status.workflow_id !== "agent") {
    throw new ConfigurationError(`Session ${sessionId} was not created by agent.`);
  }
}

export function resolvePriorSessionId(
  workspace: string,
  workflow: WorkflowDocument,
  priorSessionId?: string | null,
): string | null {
  if (workflow.requires === null) {
    if (priorSessionId) throw new ConfigurationError("Workflow does not declare requires; omit --prior.");
    return null;
  }
  if (!priorSessionId) {
    throw new ConfigurationError(
      `Workflow ${workflow.id} requires completed ${workflow.requires.workflow} (${workflow.requires.decision}); pass --prior.`,
    );
  }
  const status = readStatusFile(
    path.join(workspace, ".migent", "sessions", priorSessionId, "status.json"),
  );
  if (Object.keys(status).length === 0) {
    throw new ConfigurationError(`Required session not found: ${priorSessionId}.`);
  }
  if (status.workflow_id !== workflow.requires.workflow) {
    throw new ConfigurationError(
      `--prior ${priorSessionId} is workflow ${pyLiteral(status.workflow_id)}, not ${pyRepr(workflow.requires.workflow)}.`,
    );
  }
  if (status.status !== "completed") {
    throw new ConfigurationError(`--prior ${priorSessionId} is ${String(status.status)}, not completed.`);
  }
  const decision = status.latest_decision;
  if (decision !== workflow.requires.decision) {
    throw new ConfigurationError(
      `--prior ${priorSessionId} decision is ${pyLiteral(decision)}, not ${pyRepr(workflow.requires.decision)}.`,
    );
  }
  return priorSessionId;
}

export function bindPriorSessionId(
  workspace: string,
  sessionId: string,
  priorSessionId?: string | null,
): void {
  if (!priorSessionId) return;
  const stored = new SessionStore(workspace).readSessionStatus(sessionId).prior_session_id;
  if (stored !== priorSessionId) {
    const shown = stored === undefined || stored === null ? "None" : String(stored);
    throw new ConfigurationError(`--prior ${priorSessionId} does not match session ${shown}.`);
  }
}

function pyLiteral(value: unknown): string {
  if (typeof value === "string") return pyRepr(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "None";
}

function utcStamp(): string {
  const iso = new Date().toISOString();
  const [date, time] = iso.split("T");
  const [hh, mm, ss] = (time ?? "").split(":");
  return `${(date ?? "").replaceAll("-", "")}-${hh ?? ""}${mm ?? ""}${(ss ?? "").slice(0, 2)}`;
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function exists(filePath: string): boolean {
  return existsSync(filePath);
}

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}
