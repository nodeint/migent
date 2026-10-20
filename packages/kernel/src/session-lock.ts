import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-file.js";
import { isRecord } from "./record.js";
import { utcNow } from "./runtime.js";

export const SESSION_LOCK_FILENAME = "session.lock";
export const SESSION_LOCK_STALE_MS = 30_000;
export const SESSION_LOCK_HEARTBEAT_MS = 10_000;

export interface SessionLockTiming {
  staleMs?: number;
  heartbeatMs?: number;
}

interface LockInfo {
  pid: number;
  host: string;
  started_at: string;
  heartbeat_at: string;
  nonce: string;
}

/** A holder lost the lock after another process took it over. */
export function isSessionLockLost(error: unknown): error is Error {
  return error instanceof Error && error.message.includes("lock was taken by another process");
}

export class SessionLockHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLockHeldError";
  }
}

const held = new Map<string, SessionLock>();

/** Throw when this process holds the session lock but another process has taken it over. */
export function assertSessionLockHeld(sessionDirectory: string): void {
  held.get(path.resolve(sessionDirectory))?.assertHeld();
}

/** True when this process already holds the lock. A second acquire would fail as our own pid. */
export function sessionLockHeldLocally(sessionDirectory: string): boolean {
  return held.has(path.resolve(sessionDirectory));
}

/**
 * Exclusive writer lock for one session directory. The file holds the owner's pid, host and a
 * heartbeat that a timer refreshes. A lock is stale after `staleMs` without a heartbeat, or when
 * its owner pid is gone on this host. The holder re-checks its nonce before every session write.
 */
export class SessionLock {
  private timer: NodeJS.Timeout | null = null;
  private lost = false;

  private constructor(
    readonly sessionId: string,
    private readonly directory: string,
    private readonly lockPath: string,
    private readonly info: LockInfo,
    private readonly heartbeatMs: number,
  ) {}

  /** Take the lock, or return null while a live holder has it. */
  static tryAcquire(sessionDirectory: string, timing: SessionLockTiming = {}): SessionLock | null {
    const staleMs = timing.staleMs ?? SESSION_LOCK_STALE_MS;
    const heartbeatMs = timing.heartbeatMs ?? SESSION_LOCK_HEARTBEAT_MS;
    const directory = path.resolve(sessionDirectory);
    const lockPath = path.join(directory, SESSION_LOCK_FILENAME);
    if (held.has(directory)) return null;
    const now = utcNow();
    const info: LockInfo = {
      pid: process.pid,
      host: os.hostname(),
      started_at: now,
      heartbeat_at: now,
      nonce: randomBytes(12).toString("hex"),
    };
    if (!createExclusive(lockPath, info)) {
      if (!takeOverStale(lockPath, staleMs)) return null;
      if (!createExclusive(lockPath, info)) return null;
    }
    const lock = new SessionLock(path.basename(directory), directory, lockPath, info, heartbeatMs);
    held.set(directory, lock);
    lock.startHeartbeat();
    return lock;
  }

  /** Take the lock or throw a plain Error naming the holder. */
  static acquire(sessionDirectory: string, timing: SessionLockTiming = {}): SessionLock {
    const lock = SessionLock.tryAcquire(sessionDirectory, timing);
    if (lock !== null) return lock;
    const holder = readLock(path.join(path.resolve(sessionDirectory), SESSION_LOCK_FILENAME));
    const sessionId = path.basename(path.resolve(sessionDirectory));
    const who = holder === null ? "another process" : `pid ${holder.pid} on ${holder.host}`;
    throw new SessionLockHeldError(`Session ${sessionId} is being run by ${who}.`);
  }

  assertHeld(): void {
    const current = readLock(this.lockPath);
    if (this.lost || current === null || current.nonce !== this.info.nonce) {
      this.lost = true;
      throw new Error(`Session ${this.sessionId} lock was taken by another process. Stopping.`);
    }
  }

  release(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (held.get(this.directory) === this) held.delete(this.directory);
    const current = readLock(this.lockPath);
    if (current !== null && current.nonce === this.info.nonce) {
      try {
        rmSync(this.lockPath, { force: true });
      } catch {
        // A lock nobody refreshes goes stale.
      }
    }
  }

  /** Write one heartbeat now. Does nothing once the lock is lost. */
  refresh(): void {
    if (this.lost) return;
    const current = readLock(this.lockPath);
    if (current === null || current.nonce !== this.info.nonce) {
      this.lost = true;
      return;
    }
    this.info.heartbeat_at = utcNow();
    try {
      writeJsonAtomic(this.lockPath, this.info);
    } catch {
      // The next refresh retries; a long failure lets the lock go stale.
    }
  }

  private startHeartbeat(): void {
    this.timer = setInterval(() => this.refresh(), this.heartbeatMs);
    this.timer.unref();
  }
}

function createExclusive(lockPath: string, info: LockInfo): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(info, null, 2));
  } finally {
    closeSync(fd);
  }
  return true;
}

function readLock(lockPath: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed.pid === "number" &&
      typeof parsed.host === "string" &&
      typeof parsed.heartbeat_at === "string" &&
      typeof parsed.nonce === "string"
    ) {
      return parsed as unknown as LockInfo;
    }
  } catch {
    // Missing, or created but not yet written.
  }
  return null;
}

/** A lock file that exists but does not parse is as old as its mtime. */
function snapshot(lockPath: string): { nonce: string; heartbeat: string; info: LockInfo | null } | null {
  const info = readLock(lockPath);
  if (info !== null) return { nonce: info.nonce, heartbeat: info.heartbeat_at, info };
  try {
    return { nonce: "", heartbeat: statSync(lockPath).mtime.toISOString(), info: null };
  } catch {
    return null;
  }
}

function isStale(entry: { heartbeat: string; info: LockInfo | null }, staleMs: number): boolean {
  if (entry.info !== null && entry.info.host === os.hostname() && !pidAlive(entry.info.pid)) return true;
  const beat = Date.parse(entry.heartbeat);
  return !Number.isFinite(beat) || Date.now() - beat > staleMs;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Null in production. A test changes the lock between the two stale reads. */
let betweenStaleReads: (() => void) | null = null;

export function setBetweenStaleLockReads(observe: (() => void) | null): void {
  betweenStaleReads = observe;
}

/** Remove a stale lock only when two reads agree on its nonce and heartbeat. */
function takeOverStale(lockPath: string, staleMs: number): boolean {
  const first = snapshot(lockPath);
  if (first === null) return true;
  if (!isStale(first, staleMs)) return false;
  betweenStaleReads?.();
  const second = snapshot(lockPath);
  if (second === null) return true;
  if (second.nonce !== first.nonce || second.heartbeat !== first.heartbeat) return false;
  try {
    rmSync(lockPath, { force: true });
  } catch {
    return false;
  }
  return true;
}
