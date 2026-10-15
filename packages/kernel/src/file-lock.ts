import lockfile from "proper-lockfile";

// proper-lockfile holds a lock as a `<file>.lock` directory, which works the same on every
// platform. A holder that dies without releasing leaves it stale after STALE_MS.
const STALE_MS = 10_000;
const POLL_MS = 20;
export const FILE_LOCK_TIMEOUT_MS = 30_000;

export class FileLockTimeout extends Error {
  constructor(filePath: string) {
    super(`Timed out waiting for the lock on ${filePath}.`);
    this.name = "FileLockTimeout";
  }
}

export const fileLockOps = {
  /** One non-blocking attempt. Returns a release function, or null while another holder has it. */
  tryLock(filePath: string): (() => void) | null {
    try {
      return lockfile.lockSync(filePath, {
        realpath: false,
        stale: STALE_MS,
        // A lost lock is reported by the next holder's own check; never crash the process for it.
        onCompromised: () => undefined,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") return null;
      throw error;
    }
  },
  sleepMs(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

/** Run `fn` while holding an exclusive cross-process lock on `filePath`, waiting up to `timeoutMs`. */
export function withFileLockSync<T>(filePath: string, fn: () => T, timeoutMs = FILE_LOCK_TIMEOUT_MS): T {
  const deadline = Date.now() + timeoutMs;
  let release = fileLockOps.tryLock(filePath);
  while (release === null) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FileLockTimeout(filePath);
    fileLockOps.sleepMs(Math.min(POLL_MS, remaining));
    release = fileLockOps.tryLock(filePath);
  }
  try {
    return fn();
  } finally {
    try {
      release();
    } catch {
      // Already released or compromised; it goes stale either way.
    }
  }
}
