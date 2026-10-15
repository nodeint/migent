import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, unlinkSync } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { monotonic, sleep } from "./time.js";

export class RegistryBusy extends Error {
  constructor(message = "Timed out waiting for the registry lock.") {
    super(message);
    this.name = "RegistryBusy";
  }
}

export class StartLockBusy extends Error {
  constructor(message = "Timed out waiting for start.lock.") {
    super(message);
    this.name = "StartLockBusy";
  }
}

export class LockNotHeld extends Error {
  constructor(message = "start.lock is not held.") {
    super(message);
    this.name = "LockNotHeld";
  }
}

// proper-lockfile holds a lock as a directory at the lock path and refreshes its mtime while held.
// A holder that dies without releasing leaves it stale after STALE_MS.
const STALE_MS = 5000;
const UPDATE_MS = 1000;

/** Migent 0.1 used plain fcntl-locked files at the same paths. */
function removeLegacyLockFile(lockPath: string): void {
  try {
    if (lstatSync(lockPath).isFile()) unlinkSync(lockPath);
  } catch {
    // absent, or already a lock directory
  }
}

const heldPaths = new AsyncLocalStorage<Set<string>>();
const processLocks = new Map<string, ProcessLock>();

export const lockOps = {
  /** One non-blocking attempt. Resolves to a release function, or null when another process holds it. */
  async tryLock(lockPath: string): Promise<(() => Promise<void>) | null> {
    removeLegacyLockFile(lockPath);
    try {
      return await lockfile.lock(lockPath, {
        realpath: false,
        lockfilePath: lockPath,
        stale: STALE_MS,
        update: UPDATE_MS,
        retries: 0,
        // A lost lock is reported by the next holder's own check; never crash the process for it.
        onCompromised: () => undefined,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") return null;
      throw error;
    }
  },
  sleep,
};

export function lockKey(lockPath: string): string {
  return path.resolve(lockPath);
}

export class ProcessLock {
  private locked = false;
  private readonly waiters: Array<{
    resolve: (ok: boolean) => void;
    timer: NodeJS.Timeout;
  }> = [];

  tryAcquire(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  acquireTimeout(seconds: number): Promise<boolean> {
    if (this.tryAcquire()) return Promise.resolve(true);
    if (seconds <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(false);
        }, seconds * 1000),
      };
      this.waiters.push(waiter);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (!next) {
      this.locked = false;
      return;
    }
    clearTimeout(next.timer);
    this.locked = true;
    next.resolve(true);
  }
}

export function processLockFor(lockPath: string): ProcessLock {
  const key = lockKey(lockPath);
  let lock = processLocks.get(key);
  if (!lock) {
    lock = new ProcessLock();
    processLocks.set(key, lock);
  }
  return lock;
}

export function threadHolds(lockPath: string): boolean {
  const held = heldPaths.getStore();
  if (!held) return false;
  return held.has(lockKey(lockPath));
}

export function registryBusy(): RegistryBusy {
  return new RegistryBusy();
}

export function startLockBusy(): StartLockBusy {
  return new StartLockBusy();
}

async function acquireProcessLock(lock: ProcessLock, deadline: number): Promise<boolean> {
  const remaining = deadline - monotonic();
  if (remaining <= 0) return lock.tryAcquire();
  return lock.acquireTimeout(remaining);
}

async function acquireFileLock(
  lockPath: string,
  deadline: number,
  busyError: () => Error,
): Promise<() => Promise<void>> {
  for (;;) {
    const release = await lockOps.tryLock(lockPath);
    if (release !== null) return release;
    const remaining = deadline - monotonic();
    if (remaining <= 0) throw busyError();
    await lockOps.sleep(Math.min(0.05, remaining));
  }
}

/**
 * Exclusive lock across threads of this process and across processes. `shared` is accepted for
 * callers that only read, but every holder is exclusive; the critical sections are short.
 */
export async function interprocessLock<T>(
  lockPath: string,
  options: { shared: boolean; timeoutSec: number; busyError: () => Error },
  body: () => Promise<T> | T,
): Promise<T> {
  const key = lockKey(lockPath);
  const processLock = processLockFor(lockPath);
  const deadline = monotonic() + options.timeoutSec;
  let release: (() => Promise<void>) | null = null;
  let gotProcess = false;
  const existing = heldPaths.getStore();
  const held = existing ?? new Set<string>();
  const run = async (): Promise<T> => {
    try {
      gotProcess = await acquireProcessLock(processLock, deadline);
      if (!gotProcess) throw options.busyError();
      release = await acquireFileLock(lockPath, deadline, options.busyError);
      held.add(key);
      return await body();
    } finally {
      held.delete(key);
      if (release !== null) {
        try {
          await (release as () => Promise<void>)();
        } catch {
          // Already released or compromised; it goes stale either way.
        }
      }
      if (gotProcess) processLock.release();
    }
  };
  if (existing) return run();
  return heldPaths.run(held, run);
}

export function holdStartLock<T>(home: string, timeoutSec: number, body: () => Promise<T> | T): Promise<T> {
  return interprocessLock(
    path.join(home, "start.lock"),
    { shared: false, timeoutSec, busyError: startLockBusy },
    body,
  );
}
