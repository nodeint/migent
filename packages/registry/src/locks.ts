import { AsyncLocalStorage } from "node:async_hooks";
import { chmodSync, closeSync, constants as fsConstants, openSync } from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { POSIX, fcntlLock } from "./posix.js";
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

const contention = new Set<number>([
  osConstants.errno.EAGAIN,
  osConstants.errno.EACCES,
  osConstants.errno.EWOULDBLOCK,
]);

const heldPaths = new AsyncLocalStorage<Set<string>>();
const processLocks = new Map<string, ProcessLock>();

export const lockOps = {
  async fcntlFlock(fd: number, cmd: number, lockType: number): Promise<void> {
    if (cmd !== POSIX.F_SETLK) {
      throw new Error("registry locks use non-blocking F_SETLK");
    }
    await fcntlLock(fd, cmd, lockType);
  },
  sleep,
  open(file: string, flags: number, mode = 0o777): number {
    return openSync(file, flags, mode);
  },
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

function errnoOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const err = error as NodeJS.ErrnoException;
  if (typeof err.errno === "number") return Math.abs(err.errno);
  if (err.code && err.code in osConstants.errno) {
    return osConstants.errno[err.code as keyof typeof osConstants.errno];
  }
  return undefined;
}

async function acquireProcessLock(lock: ProcessLock, deadline: number): Promise<boolean> {
  const remaining = deadline - monotonic();
  if (remaining <= 0) return lock.tryAcquire();
  return lock.acquireTimeout(remaining);
}

async function acquireRecordLock(
  fd: number,
  lockType: number,
  deadline: number,
  busyError: () => Error,
): Promise<void> {
  let contended = false;
  let eintr = 0;
  for (;;) {
    const remaining = deadline - monotonic();
    if (contended && remaining <= 0) throw busyError();
    try {
      await lockOps.fcntlFlock(fd, POSIX.F_SETLK, lockType);
      return;
    } catch (error) {
      const errno = errnoOf(error);
      if (errno === osConstants.errno.EINTR) {
        eintr += 1;
        if (eintr > 100 && remaining <= 0) throw busyError();
        continue;
      }
      if (errno !== undefined && contention.has(errno)) {
        contended = true;
        const now = deadline - monotonic();
        if (now <= 0) throw busyError();
        await lockOps.sleep(Math.min(0.05, now));
        continue;
      }
      throw error;
    }
  }
}

export async function interprocessLock<T>(
  lockPath: string,
  options: { shared: boolean; timeoutSec: number; busyError: () => Error },
  body: () => Promise<T> | T,
): Promise<T> {
  const key = lockKey(lockPath);
  const processLock = processLockFor(lockPath);
  const deadline = monotonic() + options.timeoutSec;
  let fd: number | null = null;
  let gotProcess = false;
  let gotRecord = false;
  const existing = heldPaths.getStore();
  const held = existing ?? new Set<string>();
  const run = async (): Promise<T> => {
    try {
      gotProcess = await acquireProcessLock(processLock, deadline);
      if (!gotProcess) throw options.busyError();
      const flags = fsConstants.O_RDWR | fsConstants.O_CREAT;
      fd = lockOps.open(lockPath, flags, 0o600);
      chmodSync(lockPath, 0o600);
      const lockType = options.shared ? POSIX.F_RDLCK : POSIX.F_WRLCK;
      await acquireRecordLock(fd, lockType, deadline, options.busyError);
      gotRecord = true;
      held.add(key);
      return await body();
    } finally {
      if (gotRecord && fd !== null) {
        try {
          await lockOps.fcntlFlock(fd, POSIX.F_SETLK, POSIX.F_UNLCK);
        } catch {
          // The fd close below drops the lock if the explicit unlock fails.
        }
      }
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
      }
      held.delete(key);
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
