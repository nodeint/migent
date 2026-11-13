import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync,type Stats } from 'node:fs';
import path from 'node:path';

import { ConfigurationError, MIGENT_DIRNAME, renameWithRetry, SESSIONS_DIRNAME } from '@nodeint/migent-kernel';

import { readStatusFileState } from './query.js';
import { readSessionManifest } from './session-fold-read.js';
import { LAST_ID_FILENAME, numericName, retireSessionNumber } from './session-id.js';
import { NUMBERING_LOCK_FILENAME, SessionLock, sessionLockState } from './session-lock.js';
import { assertSessionId } from './session-selection.js';
import { effectiveTitle } from './session-title.js';

export const DELETING_DIRNAME = '.deleting';
const BLOCK_BYTES = 512;
const NONCE_BYTES = 6;

export interface PlannedSession {
  session_id: string;
  title: string | null;
  status: string | null;
  updated_at: string | null;
  bytes: number;
  /** Internal: a tombstone from an earlier run whose removal failed. */
  leftover: boolean;
}

export interface Refusal {
  session_id: string;
  reason: 'running' | 'running-elsewhere' | 'not-found';
}

export type DeletionSelection =
  | { ids: readonly string[] }
  | { olderThanMs?: number; statuses?: readonly string[] };

export interface DeletionPlan {
  planned: PlannedSession[];
  refused: Refusal[];
  /** Linked entries a filter skipped. */
  skippedLinks: string[];
}

/** `hidden`: the session is already gone from every view; only its tombstone remains. */
export type DeleteOutcome = { ok: true; bytesFreed: number } | { ok: false; error: string; hidden?: boolean };

export interface DeleteHooks {
  afterAcquire?: (sessionId: string) => void;
  beforeRename?: (sessionId: string) => void;
  afterSweepChecks?: (sessionId: string) => void;
  /** Throw to simulate a failure. */
  renameFailure?: (sessionId: string) => void;
  removeFailure?: (sessionId: string) => void;
}

let hooks: DeleteHooks = {};

/** Test-only: run code at the points between a check and its mutation. */
export function setDeleteHooks(next: DeleteHooks | null): void {
  hooks = next ?? {};
}

function sessionsRoot(workspace: string): string {
  return path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME);
}

function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** The real sessions root, or null when there is none. A root that is not the real path throws. */
export function sessionsRootReal(workspace: string): string | null {
  const root = sessionsRoot(workspace);
  let real: string;
  try {
    real = realpathSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (real !== path.join(realpathSync(workspace), MIGENT_DIRNAME, SESSIONS_DIRNAME)) {
    throw new ConfigurationError(`The sessions directory ${root} resolves outside the workspace. Refusing to delete.`);
  }
  return real;
}

function assertBookkeeping(root: string): void {
  const dir = lstatOrNull(path.join(root, DELETING_DIRNAME));
  if (dir !== null && !dir.isDirectory()) {
    throw new ConfigurationError(`${DELETING_DIRNAME} in ${root} is not a real directory. Refusing to delete.`);
  }
  for (const name of [LAST_ID_FILENAME, NUMBERING_LOCK_FILENAME]) {
    const file = lstatOrNull(path.join(root, name));
    if (file !== null && !file.isFile()) {
      throw new ConfigurationError(`${name} in ${root} is not a regular file. Refusing to delete.`);
    }
  }
}

function assertEntry(root: string, id: string): void {
  const entry = lstatOrNull(path.join(root, id));
  if (entry === null || !entry.isDirectory()) {
    throw new ConfigurationError(`Session ${id} is not a real directory inside ${root}. Refusing to delete.`);
  }
}

/** Full containment check: real root, real bookkeeping, and (with an id) a real direct-child entry. */
function assertContained(workspace: string, id: string | null): string {
  const root = sessionsRootReal(workspace);
  if (root === null) throw new ConfigurationError(`The sessions directory of ${workspace} is missing.`);
  assertBookkeeping(root);
  if (id !== null) assertEntry(root, id);
  return root;
}

function containmentError(workspace: string, id: string | null): string | null {
  try {
    assertContained(workspace, id);
    return null;
  } catch {
    return 'not-contained';
  }
}

/** Allocated bytes of a tree, without following links. */
function treeBytes(target: string): number {
  const stat = lstatOrNull(target);
  if (stat === null) return 0;
  let total = typeof stat.blocks === 'number' ? stat.blocks * BLOCK_BYTES : stat.size;
  if (stat.isDirectory()) {
    for (const name of readdirSync(target)) total += treeBytes(path.join(target, name));
  }
  return total;
}

function leftoverId(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function leftovers(root: string): { id: string; name: string }[] {
  const dir = path.join(root, DELETING_DIRNAME);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ id: leftoverId(name), name }))
    .filter(({ name }) => lstatOrNull(path.join(dir, name))?.isDirectory() === true);
}

interface Facts {
  title: string | null;
  status: string | null;
  updatedAt: string | null;
  matchMs: number;
}

function safeTitle(directory: string): string | null {
  try {
    return effectiveTitle(directory);
  } catch {
    return null;
  }
}

function readFacts(directory: string): Facts {
  const read = readStatusFileState(path.join(directory, 'status.json'));
  const ok = read.state === 'ok' && Object.keys(read.status).length > 0;
  const status = ok && typeof read.status.status === 'string' ? read.status.status : null;
  let stamp: string | null = ok && typeof read.status.updated_at === 'string' && read.status.updated_at !== '' ? read.status.updated_at : null;
  if (stamp === null && ok) {
    try {
      stamp = readSessionManifest(directory).createdAt;
    } catch {
      stamp = null;
    }
  }
  const parsed = stamp === null ? Number.NaN : Date.parse(stamp);
  if (Number.isFinite(parsed)) return { title: safeTitle(directory), status, updatedAt: stamp, matchMs: parsed };
  // An unusable timestamp falls back to the directory mtime with a null status (FR15).
  return { title: safeTitle(directory), status: null, updatedAt: null, matchMs: lstatSync(directory).mtimeMs };
}

function planOne(root: string, id: string, facts: Facts): PlannedSession {
  return {
    session_id: id,
    title: facts.title,
    status: facts.status,
    updated_at: facts.updatedAt,
    bytes: treeBytes(path.join(root, id)),
    leftover: false,
  };
}

/** Decide what a delete would remove. Reads only; throws ConfigurationError on a containment failure. */
export function planSessionDeletion(workspace: string, selection: DeletionSelection, now: number): DeletionPlan {
  const plan: DeletionPlan = { planned: [], refused: [], skippedLinks: [] };
  const root = sessionsRootReal(workspace);
  if (root === null) {
    if ('ids' in selection) for (const id of new Set(selection.ids)) {
      assertSessionId(id);
      plan.refused.push({ session_id: id, reason: 'not-found' });
    }
    return plan;
  }
  assertBookkeeping(root);
  if ('ids' in selection) {
    planNamed(root, [...new Set(selection.ids)], plan);
  } else {
    planFiltered(root, { ...selection, now }, plan);
  }
  return plan;
}

function refuseOrPlan(root: string, target: { id: string; facts: Facts }, plan: DeletionPlan): void {
  const state = sessionLockState(path.join(root, target.id));
  if (state === 'stopped') plan.planned.push(planOne(root, target.id, target.facts));
  else plan.refused.push({ session_id: target.id, reason: state });
}

function planNamed(root: string, ids: string[], plan: DeletionPlan): void {
  const left = leftovers(root);
  for (const id of ids) assertSessionId(id);
  for (const id of ids) {
    if (id.startsWith('.')) {
      plan.refused.push({ session_id: id, reason: 'not-found' });
      continue;
    }
    const tombstones = left.filter((item) => item.id === id);
    if (tombstones.length > 0) {
      const bytes = tombstones.reduce((sum, item) => sum + treeBytes(path.join(root, DELETING_DIRNAME, item.name)), 0);
      plan.planned.push({ session_id: id, title: null, status: null, updated_at: null, bytes, leftover: true });
      continue;
    }
    const entry = lstatOrNull(path.join(root, id));
    if (entry === null || (!entry.isDirectory() && !entry.isSymbolicLink())) {
      plan.refused.push({ session_id: id, reason: 'not-found' });
      continue;
    }
    assertEntry(root, id);
    refuseOrPlan(root, { id, facts: readFacts(path.join(root, id)) }, plan);
  }
}

interface FilterSelection {
  olderThanMs?: number;
  statuses?: readonly string[];
}

function matchesFilter(facts: Facts, selection: FilterSelection, now: number): boolean {
  if (selection.olderThanMs !== undefined && !(facts.matchMs < now - selection.olderThanMs)) return false;
  if (selection.statuses === undefined) return true;
  return facts.status !== null && selection.statuses.includes(facts.status);
}

/** `session list` order: updated_at, then id, descending. */
function listOrder(a: { id: string; facts: Facts }, b: { id: string; facts: Facts }): number {
  const left = a.facts.updatedAt ?? '';
  const right = b.facts.updatedAt ?? '';
  if (left !== right) return left < right ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

function planFiltered(root: string, selection: FilterSelection & { now: number }, plan: DeletionPlan): void {
  const matched: { id: string; facts: Facts }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const id = entry.name;
    const stat = id.startsWith('.') ? null : lstatOrNull(path.join(root, id));
    if (stat === null) continue;
    if (stat.isSymbolicLink()) plan.skippedLinks.push(id);
    if (!stat.isDirectory()) continue;
    const facts = readFacts(path.join(root, id));
    if (matchesFilter(facts, selection, selection.now)) matched.push({ id, facts });
  }
  matched.sort(listOrder);
  for (const target of matched) refuseOrPlan(root, target, plan);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Delete one planned session: lock it, retire its number, rename it into `.deleting/`, then remove
 * the tombstone. A failure before the rename leaves the session whole; after it, the session is
 * gone from every view and the tombstone waits for the next delete.
 */
export function deletePlannedSession(workspace: string, entry: PlannedSession): DeleteOutcome {
  try {
    return entry.leftover ? deleteLeftover(workspace, entry) : deleteSession(workspace, entry);
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

function deleteLeftover(workspace: string, entry: PlannedSession): DeleteOutcome {
  const root = sessionsRootReal(workspace);
  if (root === null) return { ok: false, error: 'not-contained' };
  for (const item of leftovers(root).filter((candidate) => candidate.id === entry.session_id)) {
    if (containmentError(workspace, null) !== null) return { ok: false, error: 'not-contained' };
    hooks.removeFailure?.(entry.session_id);
    rmSync(path.join(root, DELETING_DIRNAME, item.name), { recursive: true, force: true });
  }
  return { ok: true, bytesFreed: entry.bytes };
}

function retire(root: string, id: string): DeleteOutcome | null {
  try {
    const number = numericName(id);
    if (number !== null) retireSessionNumber(root, number);
    return null;
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

function deleteSession(workspace: string, entry: PlannedSession): DeleteOutcome {
  const id = entry.session_id;
  const early = containmentError(workspace, id);
  if (early !== null) return { ok: false, error: early };
  const root = sessionsRootReal(workspace) as string;
  const lock = SessionLock.tryAcquire(path.join(root, id));
  if (lock === null) return { ok: false, error: 'running' };
  const moved = moveToTombstone({ workspace, root, id }, lock);
  if (typeof moved !== 'string') return moved;
  lock.abandon();
  try {
    hooks.removeFailure?.(id);
    rmSync(moved, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, error: errorText(error), hidden: true };
  }
  return { ok: true, bytesFreed: entry.bytes };
}

interface MoveTarget {
  workspace: string;
  root: string;
  id: string;
}

/** Checks 2 and 3, the number retirement, and the rename. Returns the tombstone path, or a failure. */
function moveToTombstone(target: MoveTarget, lock: SessionLock): string | DeleteOutcome {
  const { workspace, root, id } = target;
  const abandon = (error: string): DeleteOutcome => {
    lock.abandon();
    return { ok: false, error };
  };
  hooks.afterAcquire?.(id);
  if (containmentError(workspace, id) !== null) return abandon('not-contained');
  const retired = retire(root, id);
  if (retired !== null) {
    lock.release();
    return retired;
  }
  const bookkeeping = path.join(root, DELETING_DIRNAME);
  const tombstone = path.join(bookkeeping, `${id}.${randomBytes(NONCE_BYTES).toString('hex')}`);
  try {
    if (containmentError(workspace, id) !== null) return abandon('not-contained');
    if (lstatOrNull(bookkeeping) === null) mkdirSync(bookkeeping);
    if (containmentError(workspace, id) !== null) return abandon('not-contained');
    hooks.beforeRename?.(id);
    hooks.renameFailure?.(id);
    renameWithRetry(path.join(root, id), tombstone);
  } catch (error) {
    lock.release();
    return { ok: false, error: errorText(error) };
  }
  return tombstone;
}

/** Remove tombstones left by earlier runs, except those of `skipIds`. Returns the IDs cleared. */
export function sweepDeletionLeftovers(workspace: string, skipIds: readonly string[]): string[] {
  const root = sessionsRootReal(workspace);
  if (root === null) return [];
  assertBookkeeping(root);
  const cleared: string[] = [];
  for (const item of leftovers(root)) {
    if (skipIds.includes(item.id)) continue;
    try {
      assertContained(workspace, null);
      hooks.afterSweepChecks?.(item.id);
      rmSync(path.join(root, DELETING_DIRNAME, item.name), { recursive: true, force: true });
      cleared.push(item.id);
    } catch {
      // A leftover that cannot be removed waits for the next run.
    }
  }
  return cleared;
}
