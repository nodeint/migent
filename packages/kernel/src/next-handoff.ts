import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-file.js";
import { ConfigurationError } from "./errors.js";
import { atomicCopy, nonemptyArtifact } from "./outputs.js";
import { corruptStatusMessage, readStatusFileState } from "./query.js";
import { isRecord } from "./record.js";
import { log } from "./runtime.js";
import { loadFrozenWorkflow } from "./session-freeze.js";

export interface NextSuggestion {
  workflow: string;
  task: string;
  artifacts: Record<string, { output: string; path: string }>;
  argv: string[];
}

export interface ResolvedHandoff {
  source_session_id: string;
  task: string | null;
  artifacts: Record<string, { output: string; source_path: string }>;
}

export interface HandoffSnapshot {
  source_session_id: string;
  artifacts: Record<string, { output: string; source_path: string; path: string; sha256: string }>;
}

function sessionDirectory(workspace: string, sessionId: string): string {
  // IDs can come from the command line or historical manifests.
  if (!sessionId || sessionId === "." || sessionId === ".." || /[\\/]/.test(sessionId) || path.isAbsolute(sessionId)) {
    throw new ConfigurationError(`Invalid session id: ${sessionId}.`);
  }
  return path.resolve(workspace, ".migent", "sessions", sessionId);
}

export function completedPriorStatus(workspace: string, sessionId: string): Record<string, unknown> {
  const statusPath = path.join(sessionDirectory(workspace, sessionId), "status.json");
  const read = readStatusFileState(statusPath);
  if (read.state === "corrupt") throw new ConfigurationError(corruptStatusMessage(statusPath));
  if (read.state === "missing") throw new ConfigurationError(`Prior session not found: ${sessionId}.`);
  if (read.status.status !== "completed") throw new ConfigurationError(`--prior ${sessionId} is ${String(read.status.status)}, not completed.`);
  return read.status;
}

/** Derived from the completed source's frozen declaration, never from a mutable next.json. */
export function resolveNextSuggestions(workspace: string, sessionId: string): NextSuggestion[] {
  const directory = sessionDirectory(workspace, sessionId);
  const status = completedPriorStatus(workspace, sessionId);
  const workflow = loadFrozenWorkflow(directory);
  const outputs = isRecord(status.outputs) ? status.outputs : {};
  return (workflow?.downstream ?? []).map((entry) => {
    const artifacts: NextSuggestion["artifacts"] = {};
    for (const [name, output] of Object.entries(entry.artifacts)) {
      const record = outputs[output];
      if (!isRecord(record) || typeof record.path !== "string" || !record.path) {
        throw new ConfigurationError(`Prior session ${sessionId} has no published output ${output}.`);
      }
      artifacts[name] = { output, path: record.path };
    }
    return {
      workflow: entry.workflow,
      task: entry.task,
      artifacts,
      argv: ["migent", "session", "run", "--workflow", entry.workflow, "--prior", sessionId],
    };
  });
}

/** Publication failure cannot undo a successfully completed workflow. Safe to retry. */
export function publishNextSuggestions(workspace: string, sessionId: string): { path: string | null; next: NextSuggestion[] } {
  let next: NextSuggestion[] = [];
  try {
    next = resolveNextSuggestions(workspace, sessionId);
    if (next.length === 0) return { path: null, next };
    const filePath = path.join(sessionDirectory(workspace, sessionId), "next.json");
    writeJsonAtomic(filePath, { schema_version: 1, source_session_id: sessionId, next });
    return { path: filePath, next };
  } catch (error) {
    log(`next.json not written: ${error instanceof Error ? error.message : String(error)}`);
    return { path: null, next };
  }
}

export function resolveHandoff(workspace: string, workflowId: string, priorSessionId?: string | null): ResolvedHandoff | null {
  if (!priorSessionId) return null;
  const status = completedPriorStatus(workspace, priorSessionId);
  const suggestion = resolveNextSuggestions(workspace, priorSessionId).find((entry) => entry.workflow === workflowId);
  const outputs = isRecord(status.outputs) ? status.outputs : {};
  const mappings = suggestion?.artifacts ?? Object.fromEntries(Object.keys(outputs).map((name) => [name, { output: name }]));
  const artifacts: ResolvedHandoff["artifacts"] = {};
  for (const [name, mapping] of Object.entries(mappings)) {
    // Fallback output names historically allow punctuation. They are labels, never path components.
    const record = outputs[mapping.output];
    if (!isRecord(record) || typeof record.path !== "string" || !record.path) {
      throw new ConfigurationError(`Prior session ${priorSessionId} has no published output ${mapping.output}.`);
    }
    const sourcePath = path.resolve(sessionDirectory(workspace, priorSessionId), record.path);
    if (!nonemptyArtifact(sourcePath)) throw new ConfigurationError(`Prior output ${mapping.output} is missing or empty: ${sourcePath}.`);
    Object.defineProperty(artifacts, name, { value: { output: mapping.output, source_path: sourcePath }, enumerable: true });
  }
  return { source_session_id: priorSessionId, task: suggestion?.task ?? null, artifacts };
}

/** Bind actual bytes only at target start; names cannot escape the handoff directory. */
export function snapshotHandoff(directory: string, resolved: ResolvedHandoff | null): HandoffSnapshot | null {
  if (resolved === null) return null;
  const artifacts: HandoffSnapshot["artifacts"] = {};
  let index = 0;
  for (const [name, source] of Object.entries(resolved.artifacts)) {
    const relative = `handoff/${++index}/${path.basename(source.source_path)}`;
    const destination = path.join(directory, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    atomicCopy(source.source_path, destination);
    if (!nonemptyArtifact(destination)) throw new ConfigurationError(`Prior output ${source.output} is missing or empty.`);
    const sha256 = createHash("sha256").update(readFileSync(destination)).digest("hex");
    Object.defineProperty(artifacts, name, { value: { ...source, path: relative, sha256 }, enumerable: true });
  }
  return { source_session_id: resolved.source_session_id, artifacts };
}

/** Windows' default terminal shell is PowerShell; POSIX uses single-quoted shell words. */
export function formatNextCommand(argv: readonly string[], windows = process.platform === "win32"): string {
  return argv.map((word) => /^[A-Za-z0-9_./:=-]+$/.test(word) ? word : windows
    ? `'${word.replaceAll("'", "''")}'`
    : `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}
