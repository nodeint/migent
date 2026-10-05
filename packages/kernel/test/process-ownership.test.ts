import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { TERMINATION_GRACE_SEC } from "../src/command-executor.ts";
import {
  ERROR_ALREADY_EXITED,
  ERROR_BOOT_MISMATCH,
  ERROR_REAPED,
  IDENTITY_FILENAME,
  PID_GONE,
  PID_PRESENT,
  PID_UNVERIFIED,
  REAP_ALREADY_EXITED,
  REAP_BOOT_MISMATCH,
  REAP_REAPED,
  REAP_STILL_RUNNING,
  REAP_UNVERIFIED,
  classifyOrphanedExecution,
  type ProcessInspector,
  wrapperArgv,
} from "../src/process-ownership.ts";
import { createPipe, setFdCloexec, stdioKeepingFd } from "../src/process-wrapper.ts";

const SENTINEL_SCRIPT = `
const fs = require("fs");
fs.writeFileSync(process.argv[1], "ready");
while (!fs.existsSync(process.argv[2])) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
`;

class FakeInspector implements ProcessInspector {
  hostnameValue = "host.example";
  bootIdValue: string | null = "boot-1";
  probes = new Map<number, string>();
  identities = new Map<number, string | null>();
  pgids = new Map<number, number | null>();
  lockPid: number | null = 4242;
  identityPayload: Record<string, unknown> | null = null;
  missingIdentityFile = false;
  killed: Array<[number, number]> = [];

  hostname(): string {
    return this.hostnameValue;
  }

  bootId(): string | null {
    return this.bootIdValue;
  }

  probePid(pid: number): string {
    return this.probes.get(pid) ?? PID_UNVERIFIED;
  }

  kernelProcessIdentity(pid: number): string | null {
    return this.identities.has(pid) ? (this.identities.get(pid) ?? null) : null;
  }

  getpgid(pid: number): number | null {
    return this.pgids.has(pid) ? (this.pgids.get(pid) ?? null) : null;
  }

  identityLockHolder(_filePath: string): number | null {
    if (this.missingIdentityFile) return null;
    return this.lockPid;
  }

  readIdentityFile(_filePath: string): Record<string, unknown> | null {
    if (this.missingIdentityFile) return null;
    return this.identityPayload;
  }

  killpg(pgid: number, sig: number): void {
    this.killed.push([pgid, sig]);
  }
}

function inspector(ownerAlive: boolean, providerProbe: string): FakeInspector {
  const fake = new FakeInspector();
  fake.probes.set(111, ownerAlive ? PID_PRESENT : PID_GONE);
  fake.probes.set(4242, providerProbe);
  fake.identities.set(111, "owner-key");
  fake.identities.set(4242, "provider-key");
  fake.pgids.set(4242, 4242);
  fake.identityPayload = {
    token: "aa".repeat(16),
    pid: 4242,
    pgid: 4242,
    start_key: "provider-key",
  };
  return fake;
}

function metadata(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "run-1",
    execution_id: "0001-implement--attempt-01",
    status: "running",
    hostname: "host.example",
    boot_id: "boot-1",
    owner_pid: 111,
    owner_start_key: "owner-key",
    provider_pid: 4242,
    provider_pgid: 4242,
    provider_start_key: "provider-key",
    identity_path: IDENTITY_FILENAME,
    identity_token: "aa".repeat(16),
    ...extra,
  };
}

async function waitUntil(predicate: () => boolean, timeoutSec: number): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition not met within ${timeoutSec}s`);
}

function processGroupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

const strayPids: number[] = [];

afterEach(() => {
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

function track(child: ChildProcess): ChildProcess {
  if (child.pid !== undefined) strayPids.push(child.pid);
  return child;
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

test("closed death pipe before exec does not start provider", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "migent-own-"));
  const sentinel = path.join(directory, "sentinel");
  const release = path.join(directory, "release");
  const identityPath = path.join(directory, IDENTITY_FILENAME);
  const pipe = createPipe();
  closeSync(pipe.writeFd);
  let child: ChildProcess | undefined;
  try {
    const argv = wrapperArgv(
      [process.execPath, "-e", SENTINEL_SCRIPT, sentinel, release],
      {
        deathFd: pipe.readFd,
        identityPath,
        token: "ab".repeat(16),
        graceSec: TERMINATION_GRACE_SEC,
      },
    );
    child = track(
      spawn(argv[0] ?? "", argv.slice(1), {
        detached: true,
        stdio: stdioKeepingFd(pipe.readFd, "inherit", "inherit", "inherit"),
      }),
    );
    closeSync(pipe.readFd);
    await waitUntil(() => child?.exitCode !== null || child?.signalCode !== null, 2);
    expect(child.exitCode).toBe(1);
    expect(existsSync(sentinel)).toBe(false);
  } finally {
    await stopChild(child);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("owner death after start exits process group", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "migent-own-"));
  const sentinel = path.join(directory, "sentinel");
  const release = path.join(directory, "release");
  const identityPath = path.join(directory, IDENTITY_FILENAME);
  const pipe = createPipe();
  setFdCloexec(pipe.writeFd);
  let writeFd = pipe.writeFd;
  let child: ChildProcess | undefined;
  try {
    const argv = wrapperArgv(
      [process.execPath, "-e", SENTINEL_SCRIPT, sentinel, release],
      {
        deathFd: pipe.readFd,
        identityPath,
        token: "ab".repeat(16),
        graceSec: 0.5,
      },
    );
    child = track(
      spawn(argv[0] ?? "", argv.slice(1), {
        detached: true,
        stdio: stdioKeepingFd(pipe.readFd, "inherit", "inherit", "inherit"),
      }),
    );
    closeSync(pipe.readFd);
    await waitUntil(() => existsSync(sentinel), 2);
    closeSync(writeFd);
    writeFd = -1;
    await waitUntil(() => child?.exitCode !== null || child?.signalCode !== null, 2);
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    await waitUntil(() => processGroupGone(child?.pid ?? -1), 2);
    expect(processGroupGone(child?.pid ?? -1)).toBe(true);
  } finally {
    if (writeFd >= 0) {
      try {
        closeSync(writeFd);
      } catch {
        // already closed
      }
    }
    await stopChild(child);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dead owner and gone provider already exited", () => {
  const fake = inspector(false, PID_GONE);
  const directory = mkdtempSync(path.join(tmpdir(), "migent-own-"));
  try {
    writeFileSync(path.join(directory, IDENTITY_FILENAME), "{}", "utf8");
    const decision = classifyOrphanedExecution(metadata(), directory, fake);
    expect(decision.action).toBe(REAP_ALREADY_EXITED);
    expect(decision.error).toBe(ERROR_ALREADY_EXITED);
    expect(fake.killed).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("matching identity is reaped", () => {
  const fake = inspector(false, PID_PRESENT);
  const directory = mkdtempSync(path.join(tmpdir(), "migent-own-"));
  try {
    writeFileSync(path.join(directory, IDENTITY_FILENAME), "{}", "utf8");
    const decision = classifyOrphanedExecution(metadata(), directory, fake);
    expect(decision.action).toBe(REAP_REAPED);
    expect(decision.error).toBe(ERROR_REAPED);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live owner is still running", () => {
  const fake = inspector(true, PID_PRESENT);
  const directory = mkdtempSync(path.join(tmpdir(), "migent-own-"));
  try {
    writeFileSync(path.join(directory, IDENTITY_FILENAME), "{}", "utf8");
    const decision = classifyOrphanedExecution(metadata(), directory, fake);
    expect(decision.action).toBe(REAP_STILL_RUNNING);
    expect(fake.killed).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("boot mismatch does not kill", () => {
  const fake = inspector(false, PID_PRESENT);
  const directory = mkdtempSync(path.join(tmpdir(), "migent-own-"));
  try {
    writeFileSync(path.join(directory, IDENTITY_FILENAME), "{}", "utf8");
    const decision = classifyOrphanedExecution(
      metadata({ boot_id: "boot-previous" }),
      directory,
      fake,
    );
    expect(decision.action).toBe(REAP_BOOT_MISMATCH);
    expect(decision.error).toBe(ERROR_BOOT_MISMATCH);
    expect(fake.killed).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unverified live provider does not kill", () => {
  const mutations: Record<string, (fake: FakeInspector) => void> = {
    "identity-mismatch": (fake) => {
      fake.identities.set(4242, "other-start-key");
    },
    "missing-identity-file": (fake) => {
      fake.missingIdentityFile = true;
    },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const fake = inspector(false, PID_PRESENT);
    mutate(fake);
    const directory = mkdtempSync(path.join(tmpdir(), "migent-own-"));
    try {
      if (label !== "missing-identity-file") {
        writeFileSync(path.join(directory, IDENTITY_FILENAME), "{}", "utf8");
      }
      const decision = classifyOrphanedExecution(metadata(), directory, fake);
      expect(decision.action, label).toBe(REAP_UNVERIFIED);
      expect(fake.killed, label).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("reused owner pid is treated as dead", () => {
  const fake = inspector(true, PID_PRESENT);
  fake.identities.set(111, "reused-owner-key");
  const directory = mkdtempSync(path.join(tmpdir(), "migent-own-"));
  try {
    writeFileSync(path.join(directory, IDENTITY_FILENAME), "{}", "utf8");
    const decision = classifyOrphanedExecution(metadata(), directory, fake);
    expect(decision.action).toBe(REAP_REAPED);
    expect(fake.killed).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
