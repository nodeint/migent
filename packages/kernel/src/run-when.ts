import { spawnSync } from "node:child_process";
import path from "node:path";
import { ConfigurationError } from "./errors.js";
import { utcNow } from "./runtime.js";
import { appendLifecycleEvent, readParsedEvents, reservedExecutionOrders } from "./session-events.js";
import type { StageSpec, WorkflowDocument } from "./workflow.js";

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const SKIP_REASON = "no changed path matches run_when.changed_paths";

export interface SkipDetails {
  reason: string;
  baseline: string;
  patterns: string[];
  changedPaths: number;
}

export interface SessionBaseline {
  commit: string | null;
  error: string | null;
}

export type RunWhenEvaluation = { matched: string } | { skip: SkipDetails };

/** Compile one `changed_paths` glob. The contract is in docs/workflows.md. */
export function compileChangedPathPattern(pattern: string): { ok: RegExp } | { error: string } {
  if (pattern.includes("\\")) return { error: "use /" };
  if (pattern.startsWith("/")) return { error: "patterns are relative to the repository root" };
  if (pattern.startsWith("!")) return { error: "negative patterns are not supported" };
  if (pattern.endsWith("/")) return { error: "use dir/**" };
  if (/[[\]{}]/.test(pattern)) return { error: "character classes and braces are not supported" };
  const segments = pattern.split("/");
  if (segments.some((segment) => segment === "")) return { error: "empty segment" };
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { error: ". and .. segments are not supported" };
  }
  if (segments.some((segment) => segment !== "**" && segment.includes("**"))) {
    return { error: "** must be a whole segment" };
  }
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment === "**" && parts[parts.length - 1] === "**") continue;
    parts.push(segment);
  }
  let source = "";
  let separator = false;
  parts.forEach((segment, index) => {
    const first = index === 0;
    const last = index === parts.length - 1;
    if (segment === "**") {
      if (first && last) source += ".+";
      else if (first) source += "(?:.+/)?";
      else if (last) source += "(?:/.+)?";
      else source += "/(?:.+/)?";
      separator = false;
      return;
    }
    if (separator) source += "/";
    source += segment
      .split("")
      .map((char) => (char === "*" ? "[^/]*" : char === "?" ? "[^/]" : char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")))
      .join("");
    separator = true;
  });
  return { ok: new RegExp(`^${source}$`, "s") };
}

/** True when `candidate` matches at least one pattern. Invalid patterns match nothing. */
export function matchesChangedPaths(patterns: readonly string[], candidate: string): boolean {
  return patterns.some((pattern) => {
    const compiled = compileChangedPathPattern(pattern);
    return "ok" in compiled && compiled.ok.test(candidate);
  });
}

function sessionDirectoryOf(workspace: string, sessionId: string): string {
  return path.join(workspace, ".migent", "sessions", sessionId);
}

export function readSessionBaseline(sessionDirectory: string): SessionBaseline | null {
  for (const event of readParsedEvents(path.join(sessionDirectory, "events.jsonl"))) {
    if (event.event !== "baseline.captured") continue;
    return {
      commit: typeof event.data.commit === "string" && event.data.commit !== "" ? event.data.commit : null,
      error: typeof event.data.error === "string" && event.data.error !== "" ? event.data.error : null,
    };
  }
  return null;
}

type GitResult = { ok: true; stdout: string } | { ok: false; error: string };

function runGit(args: readonly string[], cwd: string): GitResult {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, error: "git is not available" };
    if (code === "ETIMEDOUT") return { ok: false, error: "timed out" };
    if (code === "ENOBUFS") return { ok: false, error: "output exceeds 64 MiB" };
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    const first = (result.stderr ?? "").split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
    return { ok: false, error: first.trim() === "" ? `exit ${String(result.status)}` : first.trim() };
  }
  return { ok: true, stdout: result.stdout ?? "" };
}

function hasRunWhen(workflow: WorkflowDocument): boolean {
  return Object.values(workflow.stages).some((stage) => stage.runWhen != null);
}

/**
 * Record the Git commit the session started from, once, before its first execution.
 * A session that already has executions or a baseline is left alone. Returns true when it appended the event,
 * so the caller can refold status.json.
 */
export function ensureSessionBaseline(workspace: string, sessionId: string, workflow: WorkflowDocument): boolean {
  const sessionDirectory = sessionDirectoryOf(workspace, sessionId);
  if (readSessionBaseline(sessionDirectory) !== null) return false;
  if (reservedExecutionOrders(sessionDirectory).length > 0) return false;
  const captured = captureBaseline(workspace);
  if (captured.commit === null && hasRunWhen(workflow)) {
    throw new ConfigurationError(`Session ${sessionId} needs a Git commit for run_when: ${captured.error}.`);
  }
  appendLifecycleEvent(sessionDirectory, {
    event: "baseline.captured",
    timestamp: utcNow(),
    data: { commit: captured.commit, error: captured.error },
  });
  return true;
}

function captureBaseline(workspace: string): SessionBaseline {
  const top = runGit(["rev-parse", "--show-toplevel"], workspace);
  if (!top.ok) {
    const error = top.error === "git is not available" ? top.error : `not a Git work tree: ${top.error}`;
    return { commit: null, error };
  }
  const head = runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], workspace);
  const commit = head.ok ? head.stdout.trim() : "";
  if (!head.ok || commit === "") return { commit: null, error: "HEAD has no commit" };
  return { commit, error: null };
}

/**
 * Paths that differ from `commit` in the working tree, sorted. The result covers commits made since,
 * staged and unstaged edits, and untracked files that Git does not ignore. Migent session files are dropped.
 */
export function changedPathsSinceBaseline(workspace: string, commit: string, label: string): string[] {
  const fail = (message: string): never => {
    throw new ConfigurationError(`${label}: ${message}`);
  };
  const top = runGit(["rev-parse", "--show-toplevel"], workspace);
  if (!top.ok) {
    return fail(
      top.error === "git is not available"
        ? "git is not available."
        : `the workspace is not in a Git work tree (${top.error}).`,
    );
  }
  const toplevel = top.stdout.trim();
  const prefixResult = runGit(["rev-parse", "--show-prefix"], workspace);
  if (!prefixResult.ok) {
    return fail(`the workspace is not in a Git work tree (${prefixResult.error}).`);
  }
  const prefix = prefixResult.stdout.trim();
  const exists = runGit(["cat-file", "-e", `${commit}^{commit}`], toplevel);
  if (!exists.ok) {
    return fail(`baseline commit ${commit} is not in this repository (rewritten history or garbage collection).`);
  }
  const diff = runGit(
    ["--no-optional-locks", "diff", "--name-only", "--no-renames", "-z", "--ignore-submodules=dirty", commit, "--"],
    toplevel,
  );
  if (!diff.ok) return fail(`git diff failed: ${diff.error}.`);
  const untracked = runGit(["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"], toplevel);
  if (!untracked.ok) return fail(`git ls-files failed: ${untracked.error}.`);
  const own = `${prefix}.migent/sessions/`;
  const paths = new Set<string>();
  for (const text of [diff.stdout, untracked.stdout]) {
    for (const item of text.split("\0")) {
      if (item === "" || item.startsWith(own)) continue;
      paths.add(item);
    }
  }
  return [...paths].sort();
}

/** Decide whether a `run_when` stage runs. Git problems throw; they are never a skip. */
export function evaluateRunWhen(workspace: string, sessionId: string, stage: StageSpec): RunWhenEvaluation {
  const runWhen = stage.runWhen;
  if (runWhen == null) return { matched: "" };
  const label = `stages.${stage.id}.run_when`;
  const baseline = readSessionBaseline(sessionDirectoryOf(workspace, sessionId));
  if (baseline === null) {
    throw new ConfigurationError(
      `${label}: session ${sessionId} has no Git baseline. It started before Migent recorded one; start a new session.`,
    );
  }
  if (baseline.commit === null) {
    throw new ConfigurationError(
      `${label}: session ${sessionId} recorded no Git baseline (${baseline.error ?? "unknown"}).`,
    );
  }
  const changed = changedPathsSinceBaseline(workspace, baseline.commit, label);
  const matchers = runWhen.changedPaths.map((pattern) => compileChangedPathPattern(pattern));
  const regexes = matchers.flatMap((compiled) => ("ok" in compiled ? [compiled.ok] : []));
  const matched = changed.find((candidate) => regexes.some((regex) => regex.test(candidate)));
  if (matched !== undefined) return { matched };
  return {
    skip: {
      reason: SKIP_REASON,
      baseline: baseline.commit,
      patterns: [...runWhen.changedPaths],
      changedPaths: changed.length,
    },
  };
}
