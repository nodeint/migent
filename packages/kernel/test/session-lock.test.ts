import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  AgentToolRunner,
  SessionLock,
  SessionStore,
  assertSessionLockHeld,
  createWorkflowSession,
  executeNamedWorkflow,
} from "../src/index.ts";
import { createSessionDirectory, createPreparedSession } from "../src/session-records.ts";
import { ScriptedAdapter, tempDir } from "./support.ts";

function sessionDir(): string {
  const dir = path.join(tempDir("migent-lock-"), "s1");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function foreignLock(dir: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    path.join(dir, "session.lock"),
    JSON.stringify({
      pid: 4242,
      host: "other-host",
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      nonce: "foreign",
      ...overrides,
    }),
  );
}

test("a second acquire of a held session fails and names the holder", () => {
  const dir = sessionDir();
  const lock = SessionLock.acquire(dir);
  try {
    expect(SessionLock.tryAcquire(dir)).toBeNull();
    expect(() => SessionLock.acquire(dir)).toThrow(`being run by pid ${process.pid} on ${os.hostname()}`);
  } finally {
    lock.release();
  }
  expect(existsSync(path.join(dir, "session.lock"))).toBe(false);
  SessionLock.acquire(dir).release();
});

test("a live foreign holder keeps the lock", () => {
  const dir = sessionDir();
  foreignLock(dir);
  expect(SessionLock.tryAcquire(dir)).toBeNull();
});

test("a lock with no heartbeat for the stale limit is taken over", () => {
  const dir = sessionDir();
  foreignLock(dir, { heartbeat_at: new Date(Date.now() - 60_000).toISOString() });
  const lock = SessionLock.tryAcquire(dir);
  expect(lock).not.toBeNull();
  lock?.release();
});

test("a lock whose pid is gone on this host is taken over", () => {
  const dir = sessionDir();
  foreignLock(dir, { host: os.hostname(), pid: 2 ** 30 });
  const lock = SessionLock.tryAcquire(dir);
  expect(lock).not.toBeNull();
  lock?.release();
});

test("a holder whose lock was taken stops and does not remove the new lock", () => {
  const dir = sessionDir();
  const lock = SessionLock.acquire(dir, { heartbeatMs: 3_600_000 });
  assertSessionLockHeld(dir);
  foreignLock(dir, { nonce: "taker" });
  expect(() => assertSessionLockHeld(dir)).toThrow(/taken by another process/);
  lock.release();
  expect(JSON.parse(readFileSync(path.join(dir, "session.lock"), "utf8")).nonce).toBe("taker");
});

test("refresh updates the heartbeat with the same nonce", async () => {
  const dir = sessionDir();
  const lock = SessionLock.acquire(dir, { heartbeatMs: 3_600_000 });
  try {
    const before = JSON.parse(readFileSync(path.join(dir, "session.lock"), "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    lock.refresh();
    const after = JSON.parse(readFileSync(path.join(dir, "session.lock"), "utf8"));
    expect(after.nonce).toBe(before.nonce);
    expect(after.heartbeat_at >= before.heartbeat_at).toBe(true);
  } finally {
    lock.release();
  }
});

const CONFIG = "models:\n  fake:\n    provider: fake\n    model: m1\nroles:\n  developer:\n    default_model: fake\n";
const WORKFLOW = "id: wf\nstages:\n  - id: implement\n    role: developer\ncompletion:\n  stage: implement\n";

function setup(): { workspace: string; sessionId: string } {
  const workspace = tempDir("migent-lock-run-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), CONFIG);
  writeFileSync(path.join(workspace, ".migent", "workflows", "wf.yaml"), WORKFLOW);
  return { workspace, sessionId: createWorkflowSession(workspace, "wf", "task") };
}

test("continue on a session another process is running exits 2 and runs nothing", async () => {
  const { workspace, sessionId } = setup();
  const dir = path.join(workspace, ".migent", "sessions", sessionId);
  foreignLock(dir);
  const adapter = new ScriptedAdapter(["status: complete\n\ndone"]);
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId },
    new AgentToolRunner({ fake: adapter }, 10),
  );
  expect(result.code).toBe(2);
  expect(adapter.calls).toHaveLength(0);
  expect(new SessionStore(workspace).executionSnapshots(sessionId)).toHaveLength(0);
});

test("a finished run releases the session lock", async () => {
  const { workspace, sessionId } = setup();
  const adapter = new ScriptedAdapter(["status: complete\n\ndone"]);
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId },
    new AgentToolRunner({ fake: adapter }, 10),
  );
  expect(result.code).toBe(0);
  expect(existsSync(path.join(workspace, ".migent", "sessions", sessionId, "session.lock"))).toBe(false);
});

test("a writer that lost the lock cannot save", () => {
  const { workspace, sessionId } = setup();
  const dir = path.join(workspace, ".migent", "sessions", sessionId);
  const lock = SessionLock.acquire(dir, { heartbeatMs: 3_600_000 });
  foreignLock(dir, { nonce: "taker" });
  try {
    expect(() => new SessionStore(workspace).resetRevisionCounts(sessionId, [])).toThrow(/taken by another/);
  } finally {
    lock.release();
  }
});

test("session creation with one task never shares a directory", () => {
  const workspace = tempDir("migent-alloc-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), CONFIG);
  writeFileSync(path.join(workspace, ".migent", "workflows", "wf.yaml"), WORKFLOW);
  const ids = new Set(Array.from({ length: 5 }, () => createWorkflowSession(workspace, "wf", "same task")));
  expect(ids.size).toBe(5);
});

test("createSessionDirectory skips an existing id and a prepared id collision fails", () => {
  const sessions = path.join(tempDir("migent-alloc-"), "sessions");
  const [first] = createSessionDirectory(sessions, "base");
  const [second] = createSessionDirectory(sessions, "base");
  expect([first, second]).toEqual(["base", "base--02"]);
  const workspace = tempDir("migent-prep-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), CONFIG);
  writeFileSync(path.join(workspace, ".migent", "workflows", "wf.yaml"), WORKFLOW);
  createPreparedSession(workspace, "wave-1", "wf");
  expect(() => createPreparedSession(workspace, "wave-1", "wf")).toThrow(/already exists/);
});

test("an execution directory that exists is an error, never shared", () => {
  const { workspace, sessionId } = setup();
  const dir = path.join(workspace, ".migent", "sessions", sessionId);
  const store = new SessionStore(workspace);
  const lock = SessionLock.acquire(dir);
  try {
    const first = store.createExecution("fake", "m1", null, sessionId, "implement", null, null, "p");
    expect(() =>
      store.createExecution("fake", "m1", null, sessionId, "implement", 1, 1, "p"),
    ).toThrow(/already exists/);
    expect(first.executionId).toMatch(/^0001-/);
  } finally {
    lock.release();
  }
});
