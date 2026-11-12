import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { BYTES_PER_MIB, ConfigurationError } from '@nodeint/migent-kernel';
import { utcNow } from '@nodeint/migent-kernel';
import type { SkipDetails } from '@nodeint/migent-session';
import { appendLifecycleEvent, readParsedEvents, reservedExecutionOrders } from '@nodeint/migent-session';
import type { StageSpec, WorkflowDocument } from '@nodeint/migent-workflow';
import { compileChangedPathPattern } from '@nodeint/migent-workflow';

const GIT_TIMEOUT_MS = 60_000;
/** Largest git output accepted, in MiB. */
const GIT_MAX_BUFFER_MIB = 64;
const GIT_MAX_BUFFER = GIT_MAX_BUFFER_MIB * BYTES_PER_MIB;
const SKIP_REASON = 'no changed path matches run_when.changed_paths';

export interface SessionBaseline {
  commit: string | null;
  error: string | null;
}

export type RunWhenEvaluation = { matched: string } | { skip: SkipDetails };

function sessionDirectoryOf(workspace: string, sessionId: string): string {
  return path.join(workspace, '.migent', 'sessions', sessionId);
}

export function readSessionBaseline(sessionDirectory: string): SessionBaseline | null {
  for (const event of readParsedEvents(path.join(sessionDirectory, 'events.jsonl'))) {
    if (event.event !== 'baseline.captured') continue;
    return {
      commit: typeof event.data.commit === 'string' && event.data.commit !== '' ? event.data.commit : null,
      error: typeof event.data.error === 'string' && event.data.error !== '' ? event.data.error : null,
    };
  }
  return null;
}

type GitResult = { ok: true; stdout: string } | { ok: false; error: string };

function runGit(args: readonly string[], cwd: string): GitResult {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (result.error !== undefined) {
    const {code} = (result.error as NodeJS.ErrnoException);
    if (code === 'ENOENT') return { ok: false, error: 'git is not available' };
    if (code === 'ETIMEDOUT') return { ok: false, error: 'timed out' };
    if (code === 'ENOBUFS') return { ok: false, error: 'output exceeds 64 MiB' };
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    const first = (result.stderr ?? '').split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
    return { ok: false, error: first.trim() === '' ? `exit ${String(result.status)}` : first.trim() };
  }
  return { ok: true, stdout: result.stdout ?? '' };
}

function hasRunWhen(workflow: WorkflowDocument): boolean {
  return Object.values(workflow.stages).some((stage) => (stage.runWhen !== null && stage.runWhen !== undefined));
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
    event: 'baseline.captured',
    timestamp: utcNow(),
    data: { commit: captured.commit, error: captured.error },
  });
  return true;
}

function captureBaseline(workspace: string): SessionBaseline {
  const top = runGit(['rev-parse', '--show-toplevel'], workspace);
  if (!top.ok) {
    const error = top.error === 'git is not available' ? top.error : `not a Git work tree: ${top.error}`;
    return { commit: null, error };
  }
  const head = runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], workspace);
  const commit = head.ok ? head.stdout.trim() : '';
  if (!head.ok || commit === '') return { commit: null, error: 'HEAD has no commit' };
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
  const { toplevel, prefix } = gitWorkTree(workspace, fail);
  const exists = runGit(['cat-file', '-e', `${commit}^{commit}`], toplevel);
  if (!exists.ok) {
    return fail(`baseline commit ${commit} is not in this repository (rewritten history or garbage collection).`);
  }
  const diff = runGit(
    ['--no-optional-locks', 'diff', '--name-only', '--no-renames', '-z', '--ignore-submodules=dirty', commit, '--'],
    toplevel,
  );
  if (!diff.ok) return fail(`git diff failed: ${diff.error}.`);
  const untracked = runGit(['--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z'], toplevel);
  if (!untracked.ok) return fail(`git ls-files failed: ${untracked.error}.`);
  return workspacePaths([diff.stdout, untracked.stdout], `${prefix}.migent/sessions/`);
}

// The Git top level and the workspace's prefix within it; reports through `fail` outside a work tree.
function gitWorkTree(workspace: string, fail: (message: string) => never): { toplevel: string; prefix: string } {
  const top = runGit(['rev-parse', '--show-toplevel'], workspace);
  if (!top.ok) {
    return fail(
      top.error === 'git is not available'
        ? 'git is not available.'
        : `the workspace is not in a Git work tree (${top.error}).`,
    );
  }
  const prefixResult = runGit(['rev-parse', '--show-prefix'], workspace);
  if (!prefixResult.ok) {
    return fail(`the workspace is not in a Git work tree (${prefixResult.error}).`);
  }
  return { toplevel: top.stdout.trim(), prefix: prefixResult.stdout.trim() };
}

// Sorted unique NUL-separated paths, without Migent's own session files.
function workspacePaths(outputs: readonly string[], own: string): string[] {
  const paths = new Set<string>();
  for (const text of outputs) {
    for (const item of text.split('\0')) {
      if (item === '' || item.startsWith(own)) continue;
      paths.add(item);
    }
  }
  return [...paths].sort();
}

/** Decide whether a `run_when` stage runs. Git problems throw; they are never a skip. */
export function evaluateRunWhen(workspace: string, sessionId: string, stage: StageSpec): RunWhenEvaluation {
  const {runWhen} = stage;
  if ((runWhen === null || runWhen === undefined)) return { matched: '' };
  const label = `stages.${stage.id}.run_when`;
  const baseline = readSessionBaseline(sessionDirectoryOf(workspace, sessionId));
  if (baseline === null) {
    throw new ConfigurationError(
      `${label}: session ${sessionId} has no Git baseline. It started before Migent recorded one; start a new session.`,
    );
  }
  if (baseline.commit === null) {
    throw new ConfigurationError(
      `${label}: session ${sessionId} recorded no Git baseline (${baseline.error ?? 'unknown'}).`,
    );
  }
  const changed = changedPathsSinceBaseline(workspace, baseline.commit, label);
  const matchers = runWhen.changedPaths.map((pattern) => compileChangedPathPattern(pattern));
  const regexes = matchers.flatMap((compiled) => ('ok' in compiled ? [compiled.ok] : []));
  const matched = changed.find((candidate) => matchesAny(regexes, candidate));
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

function matchesAny(regexes: readonly RegExp[], candidate: string): boolean {
  return regexes.some((regex) => regex.test(candidate));
}
