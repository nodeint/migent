import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";

const RENAME_RETRIES = 5;
const RENAME_BACKOFF_MS = 10;
const RETRYABLE_RENAME = new Set(["EPERM", "EBUSY"]);

/** Temp files are dot-prefixed and end in `.tmp`, so directory scans can skip a leftover. */
export function isAtomicTempName(name: string): boolean {
  return name.startsWith(".") && name.endsWith(".tmp");
}

export function tempPathFor(destination: string): string {
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomBytes(6).toString("hex")}.tmp`,
  );
}

export function fsyncPath(filePath: string): void {
  const fd = openSync(filePath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Rename onto `destination`. Windows can refuse with EPERM or EBUSY while another handle is open. */
export function renameWithRetry(source: string, destination: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !RETRYABLE_RENAME.has(code) || attempt >= RENAME_RETRIES) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_BACKOFF_MS * (attempt + 1));
    }
  }
}

/** Write a temp file in the same directory, fsync it, then rename. A kill leaves the old file intact. */
export function writeFileAtomic(destination: string, data: string): void {
  const tmp = tempPathFor(destination);
  try {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameWithRetry(tmp, destination);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // The temp file is dot-prefixed and ignored by readers.
    }
    throw error;
  }
}

export function writeJsonAtomic(destination: string, value: unknown): void {
  writeFileAtomic(destination, JSON.stringify(value, null, 2));
}

/** Append one complete line in a single write, then fsync. */
export function appendLineSynced(filePath: string, line: string): void {
  const fd = openSync(filePath, "a");
  try {
    writeSync(fd, line.endsWith("\n") ? line : `${line}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
