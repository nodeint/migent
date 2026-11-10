import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { ConfigurationError } from "@nodeint/migent-kernel";
import { isRecord } from "@nodeint/migent-workflow";
import { readStatusFileState } from "./query.js";
import { readFoldedStatus, readSessionManifest } from "./session-fold.js";
import { WORKFLOW_FREEZE_FILE, readWorkflowFreeze } from "./session-freeze.js";
import { relativeWorkflowPath } from "./session-records.js";
import { assertSessionId } from "./session-selection.js";
import { parseYamlDocument } from "@nodeint/migent-workflow";
import { readFileSync } from "node:fs";

/** The editable workflow draft a session owns, resolved and checked without writing anything. */
export interface SessionDraft {
  sessionId: string;
  sessionDirectory: string;
  /** Absolute path of `workflow.yaml`. */
  draftPath: string;
  /** Workspace-relative with forward slashes: `.migent/sessions/<id>/workflow.yaml`. */
  relativePath: string;
  /** The workflow id the session recorded. */
  workflowId: string;
  /** Persisted lifecycle status; only read for a save. */
  status: string | null;
}

function fail(code: string, message: string): never {
  throw new ConfigurationError(message, { code });
}

/** Statuses a save is refused for: the session can no longer adopt a draft. */
const TERMINAL_STATUSES = new Set(["completed", "cancelled"]);
/** Statuses of a started session that stopped and can adopt a draft through `--refresh-workflow`. */
const REFRESHABLE_STATUSES = new Set(["active", "blocked", "question"]);

function isDirectoryNoFollow(target: string): boolean {
  try {
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The session directory for `sessionId`, validated for identity and containment. The session must
 * already exist as a real directory directly under `.migent/sessions`; nothing is created.
 */
export function locateSessionDirectory(workspace: string, sessionId: string): string {
  try {
    assertSessionId(sessionId);
  } catch {
    fail("invalid-session-id", `Invalid session id: ${sessionId}.`);
  }
  const sessionsDirectory = path.join(workspace, ".migent", "sessions");
  const sessionDirectory = path.join(sessionsDirectory, sessionId);
  if (!isDirectoryNoFollow(sessionDirectory)) {
    // A symlinked session directory could point anywhere; treat it as not a session.
    fail("session-not-found", `Session not found: ${sessionId}.`);
  }
  // Every parent must stay inside the workspace: a symlinked `.migent` or `sessions` is an escape.
  const expectedSessions = path.join(realpathSync(workspace), ".migent", "sessions");
  const realSessions = realpathSync(sessionsDirectory);
  if (realSessions !== expectedSessions || realpathSync(sessionDirectory) !== path.join(realSessions, sessionId)) {
    fail("session-path-escape", `Session ${sessionId} does not resolve inside .migent/sessions.`);
  }
  return sessionDirectory;
}

/**
 * Resolve the session-owned draft. Only a workflow session whose recorded source is its own
 * `workflow.yaml` qualifies. With `forSave`, the session must also be able to adopt a saved draft:
 * prepared (the draft is read at start), or started, stopped, and holding a freeze (an explicit
 * `--refresh-workflow` adopts it). The caller holds the session lock for a save; liveness is the
 * lock's to decide, never the persisted status string alone.
 */
export function resolveSessionDraft(workspace: string, sessionId: string, options: { forSave?: boolean } = {}): SessionDraft {
  const sessionDirectory = locateSessionDirectory(workspace, sessionId);
  const manifestPath = path.join(sessionDirectory, "manifest.yaml");
  if (!existsSync(manifestPath)) fail("session-metadata-missing", `Session manifest is missing: .migent/sessions/${sessionId}/manifest.yaml.`);
  let manifest;
  try {
    manifest = readSessionManifest(sessionDirectory);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    fail("session-metadata-corrupt", error.message);
  }
  // The permissive reader fills a missing session_id from the directory name; a save needs a real one.
  let rawIdentity: unknown;
  try {
    const raw = parseYamlDocument(readFileSync(manifestPath, "utf8"));
    rawIdentity = isRecord(raw) ? raw.session_id : undefined;
  } catch {
    rawIdentity = undefined;
  }
  if (rawIdentity === undefined || rawIdentity === null) {
    fail("session-metadata-missing", `Session manifest names no session_id: .migent/sessions/${sessionId}/manifest.yaml.`);
  }
  if (String(rawIdentity) !== sessionId) {
    fail("session-metadata-corrupt", `Session manifest records session_id ${String(rawIdentity)}, not ${sessionId}.`);
  }
  if (manifest.workflowId === "agent" || manifest.role !== null) {
    fail("session-not-workflow", `Session ${sessionId} is a role session; it has no workflow draft.`);
  }
  if (manifest.workflowId === null) {
    fail("session-metadata-missing", `Session manifest names no workflow_id: .migent/sessions/${sessionId}/manifest.yaml.`);
  }
  const relativePath = relativeWorkflowPath(sessionId);
  if (manifest.workflowPath !== relativePath) {
    fail(
      "session-source-unsupported",
      manifest.workflowPath === null
        ? `Session ${sessionId} records no workflow source, so it has no editable draft.`
        : `Session ${sessionId} runs the project workflow ${manifest.workflowPath}, not a session draft. Edit the project workflow instead.`,
    );
  }
  const draftPath = path.join(sessionDirectory, "workflow.yaml");
  let draftStat;
  try {
    draftStat = lstatSync(draftPath);
  } catch {
    fail("session-draft-missing", `Session draft is missing: ${relativePath}.`);
  }
  if (!draftStat.isFile()) fail("session-draft-invalid", `Session draft is not a regular file: ${relativePath}.`);

  let status: string | null = null;
  if (options.forSave === true) {
    const read = readStatusFileState(path.join(sessionDirectory, "status.json"));
    if (read.state !== "ok") {
      fail("session-metadata-corrupt", `Session status file is ${read.state === "missing" ? "missing" : "corrupt"}: .migent/sessions/${sessionId}/status.json.`);
    }
    const value = read.state === "ok" ? read.status.status : undefined;
    status = typeof value === "string" ? value : null;
    if (status === null) fail("session-metadata-corrupt", `Session status names no status: .migent/sessions/${sessionId}/status.json.`);
    // The snapshot can lag the events (a crash between an append and the commit). Read the fold, which
    // writes nothing, and refuse a save the two disagree on: only a locked repair can settle which is true.
    let folded: unknown;
    try {
      folded = readFoldedStatus(workspace, sessionDirectory).status;
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      fail("session-metadata-corrupt", error.message);
    }
    if (typeof folded === "string" && TERMINAL_STATUSES.has(folded) && folded !== status) {
      fail("session-terminal", `Session ${sessionId} is ${folded} according to its events; it can no longer adopt a workflow draft.`);
    }
    if (folded !== status && !TERMINAL_STATUSES.has(status!)) {
      fail(
        "session-status-inconsistent",
        `Session ${sessionId} status.json says ${status}, but its events say ${String(folded)}. Run \`migent session continue ${sessionId}\` or repair the session first.`,
      );
    }
    if (TERMINAL_STATUSES.has(status!)) {
      fail("session-terminal", `Session ${sessionId} is ${status}; it can no longer adopt a workflow draft.`);
    }
    if (status !== "prepared") {
      if (!REFRESHABLE_STATUSES.has(status!)) {
        fail("session-not-savable", `Session ${sessionId} is ${status}; a draft can be saved only for a prepared or stopped session.`);
      }
      const freezePath = path.join(sessionDirectory, WORKFLOW_FREEZE_FILE);
      if (!existsSync(freezePath) || !statSync(freezePath).isFile()) {
        fail("session-not-savable", `Session ${sessionId} has no frozen workflow, so it cannot adopt a draft through --refresh-workflow.`);
      }
      // A freeze that does not load makes refresh fail, so the saved draft could never be adopted.
      try {
        readWorkflowFreeze(sessionDirectory);
      } catch (error) {
        if (!(error instanceof ConfigurationError)) throw error;
        fail("session-metadata-corrupt", error.message);
      }
    }
  }
  return { sessionId, sessionDirectory, draftPath, relativePath, workflowId: manifest.workflowId, status };
}
