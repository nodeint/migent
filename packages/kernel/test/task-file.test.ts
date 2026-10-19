import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { ConfigurationError, createPreparedSession, createWorkflowSession } from "../src/index.ts";
import { activatePreparedSession } from "../src/session-records.ts";
import { SessionLock } from "../src/session-lock.ts";
import { freezeSessionTask } from "../src/task-file.ts";
import { tempDir } from "./support.ts";

const WORKFLOW = "schema_version: 1\nid: solo\nstages:\n  - id: work\n    role: developer\n";

function workspaceWithWorkflow(): string {
  const workspace = tempDir("migent-task-");
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workflows, "solo.yaml"), WORKFLOW, "utf8");
  return workspace;
}

test("a one-line task is stored in task.md", () => {
  const workspace = workspaceWithWorkflow();
  const sessionId = createWorkflowSession(workspace, "solo", "Write a plan");
  const taskPath = path.join(workspace, ".migent", "sessions", sessionId, "task.md");
  expect(readFileSync(taskPath, "utf8")).toBe("Write a plan\n");
  const status = JSON.parse(readFileSync(path.join(workspace, ".migent", "sessions", sessionId, "status.json"), "utf8")) as {
    status: string;
    task: string;
  };
  expect(status.status).toBe("active");
  expect(status.task).toBe("Write a plan");
});

test("a task with a newline is rejected before a session exists", () => {
  const workspace = workspaceWithWorkflow();
  expect(() => createWorkflowSession(workspace, "solo", "one\ntwo")).toThrow(ConfigurationError);
  expect(() => createWorkflowSession(workspace, "solo", "one\ntwo")).toThrow(/one line/);
  expect(() => createWorkflowSession(workspace, "solo", "one\n")).toThrow(/one line/);
  expect(() => createWorkflowSession(workspace, "solo", "one\r")).toThrow(/one line/);
  expect(existsSync(path.join(workspace, ".migent", "sessions"))).toBe(false);
});

test("prepare stores a chosen id and waits for task.md", () => {
  const workspace = workspaceWithWorkflow();
  expect(() => createPreparedSession(workspace, "Wave-3", "solo")).toThrow(/lowercase slug/);
  expect(() => createPreparedSession(workspace, "wave--3", "solo")).toThrow(/lowercase slug/);
  const sessionId = createPreparedSession(workspace, "wave-3", "solo");
  expect(sessionId).toBe("wave-3");
  const directory = path.join(workspace, ".migent", "sessions", "wave-3");
  expect(existsSync(path.join(directory, "session.lock"))).toBe(false);
  expect(readFileSync(path.join(directory, "manifest.yaml"), "utf8")).toContain("status: prepared");
  const status = JSON.parse(readFileSync(path.join(directory, "status.json"), "utf8")) as { status: string; task: string };
  expect(status).toMatchObject({ status: "prepared", task: "wave-3" });
  const events = readFileSync(path.join(directory, "events.jsonl"), "utf8");
  expect(events).toContain("\"event\":\"session.created\"");
  expect(events).toContain("\"v\":2");
  expect(() => createPreparedSession(workspace, "wave-3", "solo")).toThrow(/already exists/);
  expect(() => activatePreparedSession(workspace, "wave-3")).toThrow(/no task.md/);
  writeFileSync(path.join(directory, "task.md"), "   \n", "utf8");
  expect(() => activatePreparedSession(workspace, "wave-3")).toThrow(/no task.md/);
  writeFileSync(path.join(directory, "task.md"), "Migrate wave 3.\nNotes.\n", "utf8");
  activatePreparedSession(workspace, "wave-3");
  const active = JSON.parse(readFileSync(path.join(directory, "status.json"), "utf8")) as { status: string };
  expect(active.status).toBe("active");
  expect(readFileSync(path.join(directory, "manifest.yaml"), "utf8")).toContain("status: running");
  expect(existsSync(path.join(directory, "session.lock"))).toBe(false);
});

test("activate keeps a lock the caller already holds", () => {
  const workspace = workspaceWithWorkflow();
  createPreparedSession(workspace, "wave-4", "solo");
  const directory = path.join(workspace, ".migent", "sessions", "wave-4");
  writeFileSync(path.join(directory, "task.md"), "Migrate wave 4.\n", "utf8");
  const lock = SessionLock.acquire(directory);
  try {
    activatePreparedSession(workspace, "wave-4");
    lock.assertHeld();
  } finally {
    lock.release();
  }
  expect(existsSync(path.join(directory, "session.lock"))).toBe(false);
  const active = JSON.parse(readFileSync(path.join(directory, "status.json"), "utf8")) as { status: string };
  expect(active.status).toBe("active");
});

test("the first dispatch freezes task.md and a later edit fails", () => {
  const workspace = workspaceWithWorkflow();
  const sessionId = createWorkflowSession(workspace, "solo", "Write a plan");
  const directory = path.join(workspace, ".migent", "sessions", sessionId);
  const frozen = freezeSessionTask(workspace, sessionId);
  expect(frozen.taskFile).toBe(path.join(directory, "task.md"));
  const status = JSON.parse(readFileSync(path.join(directory, "status.json"), "utf8")) as { task_sha256?: string };
  expect(status.task_sha256).toMatch(/^[a-f0-9]{64}$/);
  writeFileSync(path.join(directory, "task.md"), "Changed\n", "utf8");
  expect(() => freezeSessionTask(workspace, sessionId)).toThrow(/changed after the first stage/);
});

test("whitespace after the first dispatch is a changed task", () => {
  const workspace = workspaceWithWorkflow();
  const sessionId = createWorkflowSession(workspace, "solo", "Write a plan");
  const taskPath = path.join(workspace, ".migent", "sessions", sessionId, "task.md");
  freezeSessionTask(workspace, sessionId);
  writeFileSync(taskPath, " \n", "utf8");
  expect(() => freezeSessionTask(workspace, sessionId)).toThrow(/changed after the first stage/);
});

test("an activated prepared session does not invent task.md from its id", () => {
  const workspace = workspaceWithWorkflow();
  createPreparedSession(workspace, "wave-3", "solo");
  const directory = path.join(workspace, ".migent", "sessions", "wave-3");
  const taskPath = path.join(directory, "task.md");
  writeFileSync(taskPath, "Real body\n", "utf8");
  activatePreparedSession(workspace, "wave-3");
  unlinkSync(taskPath);
  expect(() => freezeSessionTask(workspace, "wave-3")).toThrow(/no task.md/);
  expect(existsSync(taskPath)).toBe(false);
});

test("an older session gains task.md from its stored task", () => {
  const workspace = workspaceWithWorkflow();
  const sessionId = createWorkflowSession(workspace, "solo", "Write a plan");
  const directory = path.join(workspace, ".migent", "sessions", sessionId);
  const taskPath = path.join(directory, "task.md");
  unlinkSync(taskPath);
  const frozen = freezeSessionTask(workspace, sessionId);
  expect(readFileSync(frozen.taskFile, "utf8")).toBe("Write a plan\n");
});
