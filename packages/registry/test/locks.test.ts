import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { LockNotHeld, RegistryBusy, interprocessLock, lockOps, processLockFor, registryBusy, threadHolds } from "../src/locks.ts";
import { fsExt } from "../src/posix.ts";
import { publishServiceJson, unlinkServiceJsonIfUnchanged } from "../src/service.ts";
import { monotonic } from "../src/time.ts";

function heldError(): NodeJS.ErrnoException {
  const error = new Error("held") as NodeJS.ErrnoException;
  error.errno = osConstants.errno.EAGAIN;
  error.code = "EAGAIN";
  return error;
}

test("contention uses setlk and times out", async () => {
  const commands: number[] = [];
  const sleeps: number[] = [];
  const realFlock = lockOps.fcntlFlock;
  const realSleep = lockOps.sleep;
  lockOps.fcntlFlock = async (_fd, cmd, lockType) => {
    commands.push(cmd);
    if (lockType === fsExt.constants.F_UNLCK) return;
    throw heldError();
  };
  lockOps.sleep = async (seconds) => {
    sleeps.push(seconds);
  };
  const tmp = mkdtempSync(path.join(tmpdir(), "registry-lock-"));
  const lockPath = path.join(tmp, "registry.lock");
  const started = monotonic();
  try {
    await expect(
      interprocessLock(lockPath, { shared: false, timeoutSec: 0.2, busyError: registryBusy }, () => undefined),
    ).rejects.toBeInstanceOf(RegistryBusy);
  } finally {
    lockOps.fcntlFlock = realFlock;
    lockOps.sleep = realSleep;
  }
  expect(monotonic() - started).toBeLessThan(1);
  expect(commands.length).toBeGreaterThan(0);
  expect(commands.every((cmd) => cmd === fsExt.constants.F_SETLK)).toBe(true);
  expect(commands).not.toContain(fsExt.constants.F_SETLKW);
  expect(sleeps.length).toBeGreaterThan(0);
});

test("lock acquired when it frees before the deadline", async () => {
  const commands: number[] = [];
  const state = { tries: 0 };
  const realFlock = lockOps.fcntlFlock;
  const realSleep = lockOps.sleep;
  lockOps.fcntlFlock = async (_fd, cmd, lockType) => {
    commands.push(cmd);
    if (lockType === fsExt.constants.F_UNLCK) return;
    state.tries += 1;
    if (state.tries < 3) throw heldError();
  };
  lockOps.sleep = async () => undefined;
  const tmp = mkdtempSync(path.join(tmpdir(), "registry-lock-"));
  const lockPath = path.join(tmp, "registry.lock");
  try {
    await interprocessLock(lockPath, { shared: false, timeoutSec: 1, busyError: registryBusy }, () => {
      expect(threadHolds(lockPath)).toBe(true);
    });
    expect(threadHolds(lockPath)).toBe(false);
  } finally {
    lockOps.fcntlFlock = realFlock;
    lockOps.sleep = realSleep;
  }
  expect(commands).not.toContain(fsExt.constants.F_SETLKW);
  expect(state.tries).toBeGreaterThanOrEqual(3);
});

test("timeout zero fails on the first eagain without sleeping", async () => {
  const sleeps: number[] = [];
  const realFlock = lockOps.fcntlFlock;
  const realSleep = lockOps.sleep;
  lockOps.fcntlFlock = async (_fd, _cmd, lockType) => {
    if (lockType === fsExt.constants.F_UNLCK) return;
    throw heldError();
  };
  lockOps.sleep = async (seconds) => {
    sleeps.push(seconds);
  };
  const tmp = mkdtempSync(path.join(tmpdir(), "registry-lock-"));
  const lockPath = path.join(tmp, "registry.lock");
  const started = monotonic();
  try {
    await expect(
      interprocessLock(lockPath, { shared: false, timeoutSec: 0, busyError: registryBusy }, () => undefined),
    ).rejects.toBeInstanceOf(RegistryBusy);
  } finally {
    lockOps.fcntlFlock = realFlock;
    lockOps.sleep = realSleep;
  }
  expect(monotonic() - started).toBeLessThan(0.5);
  expect(sleeps).toEqual([]);
});

test("process lock timeout does not open the lock file", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "registry-lock-"));
  const lockPath = path.join(tmp, "registry.lock");
  const holder = processLockFor(lockPath);
  expect(holder.tryAcquire()).toBe(true);
  const opened: string[] = [];
  const realOpen = lockOps.open;
  lockOps.open = (file, flags, mode) => {
    opened.push(String(file));
    return realOpen(file, flags, mode);
  };
  try {
    await expect(
      interprocessLock(lockPath, { shared: false, timeoutSec: 0.1, busyError: registryBusy }, () => undefined),
    ).rejects.toBeInstanceOf(RegistryBusy);
  } finally {
    lockOps.open = realOpen;
    holder.release();
  }
  expect(opened).toEqual([]);
});

test("publish and unlink outside start lock raise lock not held", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "registry-lock-"));
  const target = path.join(home, "service.json");
  writeFileSync(target, '{"keep":true}\n');
  const before = readFileSync(target);
  expect(() => publishServiceJson(home, { schema_version: 1 })).toThrow(LockNotHeld);
  await expect(unlinkServiceJsonIfUnchanged(home, "instance", 1, "start")).rejects.toThrow(LockNotHeld);
  expect(readFileSync(target)).toEqual(before);
});
