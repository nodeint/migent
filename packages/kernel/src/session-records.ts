import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { ConfigurationError } from "./errors.js";
import { pyRepr } from "./record.js";
import { corruptStatusMessage, readStatusFileState } from "./query.js";
import { isUnicodeAlnum, utcNow } from "./runtime.js";
import { appendLifecycleEvent } from "./session-events.js";
import { writeWorkflowFreeze } from "./session-freeze.js";
import { commitFoldedStatus, readSessionManifest } from "./session-fold.js";
import { SessionLock, sessionLockHeldLocally } from "./session-lock.js";
import { SessionStore } from "./session-store.js";
import { assertManualSessionId, assertSingleLineTask, requireTaskBody, writeTaskFile, taskFilePath } from "./task-file.js";
import { isWorkflowV2, loadNamedWorkflow, type WorkflowDocument } from "./workflow.js";

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

/** Create a fresh session directory. The id gets a numeric suffix until a non-recursive mkdir wins. */
export function createSessionDirectory(sessionsDirectory: string, sessionIdBase: string): [string, string] {
  mkdirSync(sessionsDirectory, { recursive: true });
  for (let suffix = 1; ; suffix += 1) {
    const sessionId = suffix === 1 ? sessionIdBase : `${sessionIdBase}--${String(suffix).padStart(2, "0")}`;
    const sessionDirectory = path.join(sessionsDirectory, sessionId);
    try {
      mkdirSync(sessionDirectory);
      return [sessionId, sessionDirectory];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
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

/** The caller may already hold this lock. A second acquire fails as this process. */
function withSessionLock<T>(sessionDirectory: string, fn: () => T): T {
  if (sessionLockHeldLocally(sessionDirectory)) return fn();
  const lock = SessionLock.acquire(sessionDirectory);
  try {
    return fn();
  } finally {
    lock.release();
  }
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
  assertSingleLineTask(task);
  const taskSummary = task.trim();
  if (!taskSummary) throw new ConfigurationError("Task summary must not be empty.");
  const timestamp = utcStamp();
  const sessionIdBase = `${timestamp}--${sessionSlug(resolvedId, 36)}--${sessionSlug(taskSummary, 48)}`;
  const sessionsDirectory = path.join(workspace, ".migent", "sessions");
  const [sessionId, sessionDirectory] = createSessionDirectory(sessionsDirectory, sessionIdBase);
  const createdAt = utcNow();
  const workflowRelativePath = sessionWorkflowPath(workspace, workflow);
  const manifestLines = [
    `session_id: ${sessionId}`,
    `workflow_id: ${resolvedId}`,
    `workflow_path: ${workflowRelativePath}`,
    `task: ${JSON.stringify(taskSummary)}`,
    `created_at: ${createdAt}`,
  ];
  if (resolvedPrior) manifestLines.push(`prior_session_id: ${resolvedPrior}`);
  manifestLines.push("schema_version: 2");
  withSessionLock(sessionDirectory, () => {
    writeFileAtomic(path.join(sessionDirectory, "manifest.yaml"), `${manifestLines.join("\n")}\n`);
    writeTaskFile(taskFilePath(workspace, sessionId), taskSummary);
    const frozen = writeWorkflowFreeze(sessionDirectory, workspace, workflow);
    appendSessionCreated(sessionDirectory, createdAt, {
      workflow_id: resolvedId,
      workflow_path: workflowRelativePath,
      hash: frozen.hash,
      task: taskSummary,
      prior_session_id: resolvedPrior,
    });
    commitFoldedStatus(workspace, sessionDirectory);
  });
  return sessionId;
}

export function createPreparedSession(
  workspace: string,
  sessionId: string,
  workflowId: string,
  priorSessionId?: string | null,
): string {
  const id = sessionId.trim();
  assertManualSessionId(id);
  const workflow = loadNamedWorkflow(workspace, workflowId);
  const resolvedId = workflow.id;
  const resolvedPrior = resolvePriorSessionId(workspace, workflow, priorSessionId);
  const sessionDirectory = path.join(workspace, ".migent", "sessions", id);
  mkdirSync(path.dirname(sessionDirectory), { recursive: true });
  try {
    mkdirSync(sessionDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ConfigurationError(`Session already exists: ${id}.`);
    }
    throw error;
  }
  const createdAt = utcNow();
  const workflowRelativePath = sessionWorkflowPath(workspace, workflow);
  const manifestLines = [
    `session_id: ${id}`,
    `workflow_id: ${resolvedId}`,
    `workflow_path: ${workflowRelativePath}`,
    `task: ${JSON.stringify(id)}`,
    `created_at: ${createdAt}`,
  ];
  if (resolvedPrior) manifestLines.push(`prior_session_id: ${resolvedPrior}`);
  manifestLines.push("schema_version: 2");
  withSessionLock(sessionDirectory, () => {
    writeFileAtomic(path.join(sessionDirectory, "manifest.yaml"), `${manifestLines.join("\n")}\n`);
    const frozen = writeWorkflowFreeze(sessionDirectory, workspace, workflow);
    appendSessionCreated(sessionDirectory, createdAt, {
      workflow_id: resolvedId,
      workflow_path: workflowRelativePath,
      hash: frozen.hash,
      task: id,
      prior_session_id: resolvedPrior,
      prepared: true,
    });
    commitFoldedStatus(workspace, sessionDirectory);
  });
  return id;
}

export function activatePreparedSession(workspace: string, sessionId: string): void {
  requireTaskBody(workspace, sessionId);
  const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
  const statusPath = path.join(sessionDirectory, "status.json");
  const read = readStatusFileState(statusPath);
  if (read.state === "corrupt") throw new ConfigurationError(corruptStatusMessage(statusPath));
  if (read.state === "missing") throw new ConfigurationError(`Session not found: ${sessionId}.`);
  withSessionLock(sessionDirectory, () => {
    appendLifecycleEvent(sessionDirectory, {
      event: "session.activated",
      timestamp: utcNow(),
      data: { from: "prepared" },
    });
    commitFoldedStatus(workspace, sessionDirectory);
    replaceManifestStatus(sessionDirectory, "running");
  });
}

export function createAgentSession(workspace: string, role: string, task: string): string {
  const taskSummary = task.trim();
  if (!taskSummary) throw new ConfigurationError("Task summary must not be empty.");
  const timestamp = utcStamp();
  const sessionIdBase = `${timestamp}--agent--${sessionSlug(taskSummary, 48)}`;
  const sessionsDirectory = path.join(workspace, ".migent", "sessions");
  const [sessionId, sessionDirectory] = createSessionDirectory(sessionsDirectory, sessionIdBase);
  const createdAt = utcNow();
  withSessionLock(sessionDirectory, () => {
    writeFileAtomic(
      path.join(sessionDirectory, "manifest.yaml"),
      `${[
        `session_id: ${sessionId}`,
        "workflow_id: agent",
        `role: ${role}`,
        `task: ${JSON.stringify(taskSummary)}`,
        `created_at: ${createdAt}`,
        "schema_version: 2",
      ].join("\n")}\n`,
    );
    appendSessionCreated(sessionDirectory, createdAt, {
      workflow_id: "agent",
      role,
      task: taskSummary,
    });
    commitFoldedStatus(workspace, sessionDirectory);
  });
  return sessionId;
}

export function requireAgentSession(workspace: string, sessionId: string): void {
  const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
  if (!exists(sessionDirectory) || !isDirectory(sessionDirectory)) {
    throw new ConfigurationError(`Session not found: ${sessionId}.`);
  }
  const statusPath = path.join(sessionDirectory, "status.json");
  const manifest = readSessionManifest(sessionDirectory);
  const read = readStatusFileState(statusPath);
  if (read.state === "corrupt") {
    if (manifest.workflowId === "agent") return;
    throw new ConfigurationError(corruptStatusMessage(statusPath));
  }
  if (read.state === "ok" && read.status.workflow_id === "agent") return;
  if (manifest.workflowId === "agent" && read.state === "missing") return;
  throw new ConfigurationError(`Session ${sessionId} was not created by agent.`);
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
    const required = isWorkflowV2(workflow)
      ? `completed ${workflow.requires.workflow}`
      : `completed ${workflow.requires.workflow} (${workflow.requires.decision})`;
    throw new ConfigurationError(`Workflow ${workflow.id} requires ${required}; pass --prior.`);
  }
  const priorStatusPath = path.join(workspace, ".migent", "sessions", priorSessionId, "status.json");
  const priorRead = readStatusFileState(priorStatusPath);
  if (priorRead.state === "corrupt") throw new ConfigurationError(corruptStatusMessage(priorStatusPath));
  const status = priorRead.status;
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
  if (isWorkflowV2(workflow)) return priorSessionId;
  const decision = status.latest_decision;
  const requiredDecision = workflow.requires.decision;
  if (decision !== requiredDecision) {
    const expected = requiredDecision === null ? "None" : pyRepr(requiredDecision);
    throw new ConfigurationError(
      `--prior ${priorSessionId} decision is ${pyLiteral(decision)}, not ${expected}.`,
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

function appendSessionCreated(sessionDirectory: string, timestamp: string, data: Record<string, unknown>): void {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null && value !== "") body[key] = value;
  }
  appendLifecycleEvent(sessionDirectory, {
    event: "session.created",
    timestamp,
    data: body,
  });
}

function pyLiteral(value: unknown): string {
  if (typeof value === "string") return pyRepr(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "None";
}

function replaceManifestStatus(sessionDirectory: string, status: string): void {
  if (readSessionManifest(sessionDirectory).schemaVersion >= 2) return;
  const manifestPath = path.join(sessionDirectory, "manifest.yaml");
  try {
    if (!statSync(manifestPath).isFile()) return;
  } catch {
    return;
  }
  const text = readFileSync(manifestPath, "utf8");
  const pattern = /^status: \S+\s*$/m;
  if (!pattern.test(text)) return;
  writeFileAtomic(manifestPath, text.replace(pattern, `status: ${status}`));
}

function utcStamp(): string {
  const iso = new Date().toISOString();
  const [date, time] = iso.split("T");
  const [hh, mm, ss] = (time ?? "").split(":");
  return `${(date ?? "").replaceAll("-", "")}-${hh ?? ""}${mm ?? ""}${(ss ?? "").slice(0, 2)}`;
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
