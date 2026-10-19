import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { ConfigurationError } from "./errors.js";
import { corruptStatusMessage, readStatusFileState } from "./query.js";
import { MIGENT_DIRNAME, SESSIONS_DIRNAME, utcNow } from "./runtime.js";
import { appendLifecycleEvent } from "./session-events.js";
import { commitFoldedStatus } from "./session-fold.js";

export const TASK_FILENAME = "task.md";

const MANUAL_SESSION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MANUAL_SESSION_ID_LIMIT = 64;

export function assertManualSessionId(sessionId: string): void {
  if (!MANUAL_SESSION_ID.test(sessionId) || sessionId.length > MANUAL_SESSION_ID_LIMIT) {
    throw new ConfigurationError(
      "Session id must be a lowercase slug such as wave-3: letters, digits, and single hyphens, at most 64 characters.",
    );
  }
}

export function assertSingleLineTask(task: string): void {
  if (task.includes("\n") || task.includes("\r")) {
    throw new ConfigurationError(
      "Task must be one line. For a longer task, run migent session prepare <some-id> --workflow <workflow> and write task.md.",
    );
  }
}

export function sessionTaskDirectory(workspace: string, sessionId: string): string {
  return path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME, sessionId);
}

export function taskFilePath(workspace: string, sessionId: string): string {
  return path.join(sessionTaskDirectory(workspace, sessionId), TASK_FILENAME);
}

export function relativeTaskPath(sessionId: string): string {
  return `.migent/sessions/${sessionId}/task.md`;
}

export function writeTaskFile(filePath: string, task: string): void {
  const body = task.endsWith("\n") ? task : `${task}\n`;
  writeFileAtomic(filePath, body);
}

/** Materialize a missing task.md, then reject a body that differs from the first dispatch. */
export function freezeSessionTask(
  workspace: string,
  sessionId: string,
): { taskFile: string; sessionDirectory: string } {
  const sessionDirectory = sessionTaskDirectory(workspace, sessionId);
  const statusPath = path.join(sessionDirectory, "status.json");
  const status = readStatus(statusPath);
  if (status.status === "prepared") {
    throw new ConfigurationError(
      `Session ${sessionId} is prepared. Run: ${preparedRunHint(sessionId, status)}`,
    );
  }
  const filePath = taskFilePath(workspace, sessionId);
  let text = readTask(filePath);
  const storedHash = typeof status.task_sha256 === "string" ? status.task_sha256 : "";
  if (text === null) {
    if (storedHash !== "") {
      throw new ConfigurationError(`Session ${sessionId} is missing task.md.`);
    }
    const fallback = typeof status.task === "string" ? status.task : "";
    // A prepared session stores its id as the task label. That label is not a body.
    if (fallback.trim() === "" || fallback === sessionId) {
      throw new ConfigurationError(
        `Session ${sessionId} has no task.md. Write ${relativeTaskPath(sessionId)} before starting.`,
      );
    }
    writeTaskFile(filePath, fallback);
    text = readTask(filePath);
  }
  if (text === null || (storedHash === "" && text.trim() === "")) {
    throw new ConfigurationError(
      `Session ${sessionId} has no task.md. Write ${relativeTaskPath(sessionId)} before starting.`,
    );
  }
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  if (storedHash === "") {
    appendLifecycleEvent(sessionDirectory, {
      event: "task.frozen",
      timestamp: utcNow(),
      data: { sha256: hash },
    });
    commitFoldedStatus(workspace, sessionDirectory);
  } else if (storedHash !== hash) {
    throw new ConfigurationError(`Session ${sessionId} task.md changed after the first stage was dispatched.`);
  }
  return { taskFile: filePath, sessionDirectory };
}

export function requireTaskBody(workspace: string, sessionId: string): void {
  const text = readTask(taskFilePath(workspace, sessionId));
  if (text === null || text.trim() === "") {
    throw new ConfigurationError(
      `Session ${sessionId} has no task.md. Write ${relativeTaskPath(sessionId)} before starting.`,
    );
  }
}

function readTask(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf8");
}

function preparedRunHint(sessionId: string, status: Record<string, unknown>): string {
  const workflowId = typeof status.workflow_id === "string" && status.workflow_id ? status.workflow_id : "<workflow>";
  return `migent session run --session ${sessionId} --workflow ${workflowId}`;
}

function readStatus(filePath: string): Record<string, unknown> {
  const read = readStatusFileState(filePath);
  if (read.state === "corrupt") throw new ConfigurationError(corruptStatusMessage(filePath));
  return read.status;
}
