import type { ProviderResolver } from "./provider-contract.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { stringify } from "yaml";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { ConfigurationError } from "./errors.js";
import { pyRepr } from "./record.js";
import { corruptStatusMessage, readStatusFileState } from "./query.js";
import { isUnicodeAlnum, utcNow } from "./runtime.js";
import { appendLifecycleEvent } from "./session-events.js";
import { requireLiveWorkflow, writeWorkflowFreeze } from "./session-freeze.js";
import { completedPriorStatus, resolveHandoff, snapshotHandoff } from "./next-handoff.js";
import { parseYamlDocument } from "./yaml.js";
import { commitFoldedStatus, readSessionManifest } from "./session-fold.js";
import { SessionLock, sessionLockHeldLocally } from "./session-lock.js";
import { SessionStore } from "./session-store.js";
import { assertSessionTitle, assertSingleLineTask, requireTaskBody, writeTaskFile, taskFilePath } from "./task-file.js";
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

/** A new session directory. The id is a UUID. A collision retries with another UUID. */
function createUuidSessionDirectory(sessionsDirectory: string): [string, string] {
  mkdirSync(sessionsDirectory, { recursive: true });
  for (;;) {
    const sessionId = randomUUID();
    const sessionDirectory = path.join(sessionsDirectory, sessionId);
    try {
      mkdirSync(sessionDirectory);
      return [sessionId, sessionDirectory];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
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
  task: string | null | undefined,
  priorSessionId?: string | null,
  resolveProvider?: ProviderResolver,
): string {
  const workflow = loadNamedWorkflow(workspace, workflowId);
  const resolvedId = workflow.id;
  const resolvedPrior = resolvePriorSessionId(workspace, workflow, priorSessionId);
  const handoff = resolveHandoff(workspace, workflow.id, resolvedPrior);
  const selectedTask = task ?? handoff?.task;
  if (!selectedTask) throw new ConfigurationError("Creating a session requires --task when the prior session has no matching downstream suggestion.");
  assertSingleLineTask(selectedTask);
  const taskSummary = selectedTask.trim();
  if (!taskSummary) throw new ConfigurationError("Task summary must not be empty.");
  const sessionsDirectory = path.join(workspace, ".migent", "sessions");
  const [sessionId, sessionDirectory] = createUuidSessionDirectory(sessionsDirectory);
  const createdAt = utcNow();
  const workflowRelativePath = sessionWorkflowPath(workspace, workflow);
  const manifestLines = [
    `session_id: ${sessionId}`,
    `title: ${JSON.stringify(taskSummary)}`,
    `workflow_id: ${resolvedId}`,
    `workflow_path: ${workflowRelativePath}`,
    `task: ${JSON.stringify(taskSummary)}`,
    `created_at: ${createdAt}`,
  ];
  if (resolvedPrior) manifestLines.push(`prior_session_id: ${resolvedPrior}`);
  manifestLines.push("schema_version: 2");
  try {
    withSessionLock(sessionDirectory, () => {
      const snapshot = snapshotHandoff(sessionDirectory, handoff);
      if (snapshot) manifestLines.push(`handoff: ${JSON.stringify(snapshot)}`);
      writeFileAtomic(path.join(sessionDirectory, "manifest.yaml"), `${manifestLines.join("\n")}\n`);
      writeTaskFile(taskFilePath(workspace, sessionId), taskSummary);
      const frozen = writeWorkflowFreeze(sessionDirectory, workspace, workflow, resolveProvider);
      appendSessionCreated(sessionDirectory, createdAt, {
        workflow_id: resolvedId,
        workflow_path: workflowRelativePath,
        hash: frozen.hash,
        title: taskSummary,
        task: taskSummary,
        prior_session_id: resolvedPrior,
        handoff: snapshot,
      });
      commitFoldedStatus(workspace, sessionDirectory);
    });
  } catch (error) {
    // This directory was allocated above with a fresh UUID and belongs to this failed creation.
    rmSync(sessionDirectory, { recursive: true, force: true });
    throw error;
  }
  return sessionId;
}

export function createPreparedSession(
  workspace: string,
  title: string,
  workflowId: string,
  priorSessionId?: string | null,
  resolveProvider?: ProviderResolver,
): string {
  const sessionTitle = title.trim();
  assertSessionTitle(sessionTitle);
  const workflow = loadNamedWorkflow(workspace, workflowId);
  const resolvedId = workflow.id;
  const resolvedPrior = resolvePriorSessionId(workspace, workflow, priorSessionId);
  const sessionsDirectory = path.join(workspace, ".migent", "sessions");
  const [sessionId, sessionDirectory] = createUuidSessionDirectory(sessionsDirectory);
  const createdAt = utcNow();
  const workflowRelativePath = sessionWorkflowPath(workspace, workflow);
  const manifestLines = [
    `session_id: ${sessionId}`,
    `title: ${JSON.stringify(sessionTitle)}`,
    `workflow_id: ${resolvedId}`,
    `workflow_path: ${workflowRelativePath}`,
    `created_at: ${createdAt}`,
  ];
  if (resolvedPrior) manifestLines.push(`prior_session_id: ${resolvedPrior}`);
  manifestLines.push("schema_version: 2");
  withSessionLock(sessionDirectory, () => {
    writeFileAtomic(path.join(sessionDirectory, "manifest.yaml"), `${manifestLines.join("\n")}\n`);
    appendSessionCreated(sessionDirectory, createdAt, {
      workflow_id: resolvedId,
      workflow_path: workflowRelativePath,
      title: sessionTitle,
      prior_session_id: resolvedPrior,
      prepared: true,
    });
    commitFoldedStatus(workspace, sessionDirectory);
  });
  return sessionId;
}

export function activatePreparedSession(workspace: string, sessionId: string, resolveProvider?: ProviderResolver): void {
  requireTaskBody(workspace, sessionId);
  const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
  const statusPath = path.join(sessionDirectory, "status.json");
  const read = readStatusFileState(statusPath);
  if (read.state === "corrupt") throw new ConfigurationError(corruptStatusMessage(statusPath));
  if (read.state === "missing") throw new ConfigurationError(`Session not found: ${sessionId}.`);
  const manifest = readSessionManifest(sessionDirectory);
  const workflow = requireLiveWorkflow(workspace, manifest.workflowPath, manifest.workflowId);
  const prior = resolvePriorSessionId(workspace, workflow, manifest.priorSessionId);
  const handoff = resolveHandoff(workspace, workflow.id, prior);
  withSessionLock(sessionDirectory, () => {
    const snapshot = snapshotHandoff(sessionDirectory, handoff);
    const frozen = writeWorkflowFreeze(sessionDirectory, workspace, workflow, resolveProvider);
    appendLifecycleEvent(sessionDirectory, {
      event: "handoff.bound", timestamp: utcNow(), data: { handoff: snapshot, hash: frozen.hash },
    });
    if (snapshot) {
      const manifestPath = path.join(sessionDirectory, "manifest.yaml");
      const body = parseYamlDocument(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      body.handoff = snapshot;
      writeFileAtomic(manifestPath, stringify(body));
    }
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
  const sessionsDirectory = path.join(workspace, ".migent", "sessions");
  const [sessionId, sessionDirectory] = createUuidSessionDirectory(sessionsDirectory);
  const createdAt = utcNow();
  withSessionLock(sessionDirectory, () => {
    writeFileAtomic(
      path.join(sessionDirectory, "manifest.yaml"),
      `${[
        `session_id: ${sessionId}`,
        `title: ${JSON.stringify(taskSummary)}`,
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
      title: taskSummary,
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
  if ((workflow.schemaVersion ?? 1) >= 4) {
    if (priorSessionId) completedPriorStatus(workspace, priorSessionId);
    return priorSessionId || null;
  }
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
