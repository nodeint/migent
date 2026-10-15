import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { LockNotHeld, RegistryBusy, interprocessLock, lockOps, processLockFor, registryBusy, threadHolds } from "../src/locks.ts";
import { publishServiceJson, unlinkServiceJsonIfUnchanged } from "../src/service.ts";
import { monotonic } from "../src/time.ts";

function lockPathIn(prefix: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), prefix)), "registry.lock");
}

test("contention polls without blocking and times out", async () => {
  const tries: string[] = [];
  const sleeps: number[] = [];
  const realTry = lockOps.tryLock;
  const realSleep = lockOps.sleep;
  lockOps.tryLock = async (file) => {
    tries.push(file);
    return null;
  };
  lockOps.sleep = async (seconds) => {
    sleeps.push(seconds);
  };
  const lockPath = lockPathIn("registry-lock-");
  const started = monotonic();
  try {
    await expect(
      interprocessLock(lockPath, { shared: false, timeoutSec: 0.2, busyError: registryBusy }, () => undefined),
    ).rejects.toBeInstanceOf(RegistryBusy);
  } finally {
    lockOps.tryLock = realTry;
    lockOps.sleep = realSleep;
  }
  expect(monotonic() - started).toBeLessThan(1);
  expect(tries.length).toBeGreaterThan(0);
  expect(sleeps.length).toBeGreaterThan(0);
});

test("lock acquired when it frees before the deadline", async () => {
  const state = { tries: 0, released: 0 };
  const realTry = lockOps.tryLock;
  const realSleep = lockOps.sleep;
  lockOps.tryLock = async () => {
    state.tries += 1;
    if (state.tries < 3) return null;
    return async () => {
      state.released += 1;
    };
  };
  lockOps.sleep = async () => undefined;
  const lockPath = lockPathIn("registry-lock-");
  try {
    await interprocessLock(lockPath, { shared: false, timeoutSec: 1, busyError: registryBusy }, () => {
      expect(threadHolds(lockPath)).toBe(true);
    });
    expect(threadHolds(lockPath)).toBe(false);
  } finally {
    lockOps.tryLock = realTry;
    lockOps.sleep = realSleep;
  }
  expect(state.tries).toBe(3);
  expect(state.released).toBe(1);
});

test("timeout zero fails on the first contention without sleeping", async () => {
  const sleeps: number[] = [];
  const realTry = lockOps.tryLock;
  const realSleep = lockOps.sleep;
  lockOps.tryLock = async () => null;
  lockOps.sleep = async (seconds) => {
    sleeps.push(seconds);
  };
  const started = monotonic();
  try {
    await expect(
      interprocessLock(lockPathIn("registry-lock-"), { shared: false, timeoutSec: 0, busyError: registryBusy }, () => undefined),
    ).rejects.toBeInstanceOf(RegistryBusy);
  } finally {
    lockOps.tryLock = realTry;
    lockOps.sleep = realSleep;
  }
  expect(monotonic() - started).toBeLessThan(0.5);
  expect(sleeps).toEqual([]);
});

test("process lock timeout does not touch the lock file", async () => {
  const lockPath = lockPathIn("registry-lock-");
  const holder = processLockFor(lockPath);
  expect(holder.tryAcquire()).toBe(true);
  const tried: string[] = [];
  const realTry = lockOps.tryLock;
  lockOps.tryLock = async (file) => {
    tried.push(file);
    return realTry(file);
  };
  try {
    await expect(
      interprocessLock(lockPath, { shared: false, timeoutSec: 0.1, busyError: registryBusy }, () => undefined),
    ).rejects.toBeInstanceOf(RegistryBusy);
  } finally {
    lockOps.tryLock = realTry;
    holder.release();
  }
  expect(tried).toEqual([]);
});

test("a lock file left by Migent 0.1 does not block", async () => {
  const lockPath = lockPathIn("registry-lock-");
  writeFileSync(lockPath, "");
  await interprocessLock(lockPath, { shared: false, timeoutSec: 0.5, busyError: registryBusy }, () => {
    expect(statSync(lockPath).isDirectory()).toBe(true);
  });
  expect(() => statSync(lockPath)).toThrow();
});

test("publish and unlink outside start lock raise lock not held", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "registry-lock-"));
  const target = path.join(home, "service.json");
  writeFileSync(target, '{"keep":true}\n');
  const before = readFileSync(target);
  expect(() => publishServiceJson(home, { schema_version: 2 })).toThrow(LockNotHeld);
  await expect(unlinkServiceJsonIfUnchanged(home, "instance")).rejects.toThrow(LockNotHeld);
  expect(readFileSync(target)).toEqual(before);
});
