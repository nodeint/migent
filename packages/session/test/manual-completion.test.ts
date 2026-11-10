import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { ConfigurationError, SessionLock, SessionLockHeldError } from "../src/index.ts";
import { readFoldedStatus } from "../src/session-fold.ts";
import { readParsedEvents } from "../src/session-events.ts";
import { createAgentSession, createPreparedSession, createWorkflowSession } from "../src/session-records.ts";
import { repairSession } from "../src/session-repair.ts";
import { SessionStore } from "../src/session-store.ts";
import { StageOutcome } from "../src/stage-outcome.ts";
import { freezeSessionTask } from "../src/task-file.ts";
import { defaultClients, tempDir, writeSessionConfig } from "./support.ts";

const PLAN = `schema_version: 7
id: plan
artifacts:
  plan: { file: plan.md }
  notes: { file: notes.md }
stages:
  - id: draft
    role: planner
    artifacts: [plan]
  - id: extra
    role: planner
    depends_on: [draft]
    artifacts: [notes]
downstream:
  - workflow: implement
    task: Implement the plan
    artifacts: { plan: plan }
`;

function workspaceWithPlan(): string {
  const workspace = tempDir("migent-complete-");
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workflows, "plan.yaml"), PLAN, "utf8");
  writeFileSync(path.join(workflows, "implement.yaml"), "schema_version: 7\nid: implement\nstages:\n  - { id: work, role: developer }\n");
  writeSessionConfig(workspace);
  return workspace;
}

function directoryOf(workspace: string, sessionId: string): string {
  return path.join(workspace, ".migent", "sessions", sessionId);
}

function statusOf(workspace: string, sessionId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(directoryOf(workspace, sessionId), "status.json"), "utf8")) as Record<string, unknown>;
}

function stageRun(
  workspace: string,
  store: SessionStore,
  sessionId: string,
  stageId: string,
  status: string,
  outcome: StageOutcome | null,
  files: Record<string, string> = {},
): void {
  const [record, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, stageId, null, null, stageId);
  const lock = SessionLock.acquire(directoryOf(workspace, sessionId));
  try {
    store.saveExecution(context, record, "running");
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(context.artifactDirectory, name), body, "utf8");
    store.saveExecution(context, record, status, null, outcome);
  } finally {
    lock.release();
  }
}

function started(): { workspace: string; store: SessionStore; sessionId: string } {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  freezeSessionTask(workspace, sessionId);
  return { workspace, store: new SessionStore(workspace, undefined, defaultClients()), sessionId };
}

test("completing a stopped schema 7 session publishes artifacts, seals metrics, writes next.json, and survives repair", () => {
  const { workspace, store, sessionId } = started();
  stageRun(workspace, store, sessionId, "draft", "completed", new StageOutcome("complete"), { "plan.md": "# Plan\n" });
  expect(statusOf(workspace, sessionId).status).toBe("active");
  const result = store.completeManually(sessionId);
  expect(result).toMatchObject({ alreadyCompleted: false, from: "active", missingOutputs: ["notes"] });
  const status = statusOf(workspace, sessionId);
  expect(status.status).toBe("completed");
  expect(status.completion_method).toBe("manual");
  expect(status.manual_completion).toMatchObject({ from: "active" });
  expect(status.outputs).toMatchObject({ plan: { path: "outputs/plan.md", published_by_execution_id: "manual" } });
  const directory = directoryOf(workspace, sessionId);
  expect(readFileSync(path.join(directory, "outputs", "plan.md"), "utf8")).toBe("# Plan\n");
  const event = readParsedEvents(path.join(directory, "events.jsonl")).find((item) => item.event === "session.completed");
  expect(event?.data).toMatchObject({ manual: true, from: "active", missing_outputs: ["notes"] });
  expect(typeof event?.data.reason).toBe("string");
  expect(JSON.parse(readFileSync(path.join(directory, "metrics.json"), "utf8")).status).toBe("completed");
  expect(JSON.parse(readFileSync(path.join(directory, "next.json"), "utf8")).next[0]).toMatchObject({ workflow: "implement" });
  expect(result.next.path).toBe(path.join(directory, "next.json"));
  expect(existsSync(path.join(directory, "session.lock"))).toBe(false);

  const repaired = repairSession(workspace, sessionId);
  expect(repaired.status).toBe("completed");
  expect(repaired.manual_completion).toEqual(status.manual_completion);
  expect(statusOf(workspace, sessionId).outputs).toEqual(status.outputs);
  expect(readFoldedStatus(workspace, directory)).toEqual(statusOf(workspace, sessionId));
});

test("a required artifact from a failed stage is reported missing and the rest is still published", () => {
  const { workspace, store, sessionId } = started();
  stageRun(workspace, store, sessionId, "draft", "completed", new StageOutcome("complete"), { "plan.md": "# Plan\n" });
  stageRun(workspace, store, sessionId, "extra", "failed", null, { "notes.md": "not trusted\n" });
  const result = store.completeManually(sessionId);
  expect(result.missingOutputs).toEqual(["notes"]);
  expect(Object.keys(result.outputs)).toEqual(["plan"]);
  expect(existsSync(path.join(directoryOf(workspace, sessionId), "outputs", "notes.md"))).toBe(false);
});

test("blocked, question, and cancelled sessions lose their stopped presentation", () => {
  const question = {
    id: "1", question: "Which?", context: "Because.", selection: "single", recommended: ["A"], options: [{ id: "A", label: "A", description: "first" }, { id: "B", label: "B", description: "second" }],
  };
  const cases: Array<[string, string, StageOutcome | null]> = [
    ["blocked", "completed", new StageOutcome("blocked", "needs a decision")],
    ["question", "completed", new StageOutcome("question", null, null, "Which?", [question as never])],
    ["cancelled", "cancelled", null],
  ];
  for (const [expected, executionStatus, outcome] of cases) {
    const { workspace, store, sessionId } = started();
    stageRun(workspace, store, sessionId, "draft", executionStatus, outcome);
    expect(statusOf(workspace, sessionId).status).toBe(expected);
    const result = store.completeManually(sessionId);
    expect(result.from).toBe(expected);
    const status = statusOf(workspace, sessionId);
    expect(status.status).toBe("completed");
    expect(status.completion_method).toBe("manual");
    for (const key of ["blocker", "blocked_by_execution_id", "blocked_by_execution_ids", "blocked_by_stage_id", "questions"]) {
      expect(status).not.toHaveProperty(key);
    }
    expect(status.manual_completion).toMatchObject({ from: expected });
    const file = path.join(directoryOf(workspace, sessionId), "questions.json");
    const listed = JSON.parse(readFileSync(file, "utf8")).questions as Array<{ status: string }>;
    expect(listed.filter((item) => item.status === "pending")).toEqual([]);
    expect(repairSession(workspace, sessionId).status).toBe("completed");
  }
});

test("a completed session is a no-op and stays terminal", () => {
  const { workspace, store, sessionId } = started();
  stageRun(workspace, store, sessionId, "draft", "completed", new StageOutcome("complete"), { "plan.md": "# Plan\n" });
  store.completeManually(sessionId);
  const directory = directoryOf(workspace, sessionId);
  const events = readFileSync(path.join(directory, "events.jsonl"), "utf8");
  const status = readFileSync(path.join(directory, "status.json"), "utf8");
  const again = store.completeManually(sessionId);
  expect(again.alreadyCompleted).toBe(true);
  expect(Object.keys(again.outputs)).toEqual(["plan"]);
  expect(again.next.path).toBe(path.join(directory, "next.json"));
  expect(readFileSync(path.join(directory, "events.jsonl"), "utf8")).toBe(events);
  expect(readFileSync(path.join(directory, "status.json"), "utf8")).toBe(status);
  expect(() => store.loadOrCreate("fake", "model", {}, workspace, sessionId, "extra", null, null, "x")).toThrow(/start a new session/);
});

test("missing, prepared, role, and running sessions are rejected", () => {
  const { workspace, store, sessionId } = started();
  expect(() => store.completeManually("nope")).toThrow(/does not exist/);
  expect(() => store.completeManually("..")).toThrow(ConfigurationError);

  const prepared = createPreparedSession(workspace, "Later", "plan");
  expect(() => store.completeManually(prepared)).toThrow(`migent session run --session ${prepared}`);
  expect(statusOf(workspace, prepared).status).toBe("prepared");

  const role = createAgentSession(workspace, "planner", "A role");
  expect(() => store.completeManually(role)).toThrow(/role session/);

  const lock = SessionLock.acquire(directoryOf(workspace, sessionId));
  try {
    expect(() => store.completeManually(sessionId)).toThrow(SessionLockHeldError);
    expect(() => store.completeManually(sessionId)).toThrow(`migent session cancel ${sessionId}`);
  } finally {
    lock.release();
  }
  expect(statusOf(workspace, sessionId).status).toBe("active");
  expect(readParsedEvents(path.join(directoryOf(workspace, sessionId), "events.jsonl")).some((e) => e.event === "session.completed")).toBe(false);
});

test("schema 2-6 outputs and version 1 completion.outputs publish from completed sources", () => {
  const workflows: Array<[string, string]> = [
    [
      "v5",
      "schema_version: 5\nid: v5\nstages:\n  - id: draft\n    role: planner\n    produces: { artifact: plan.md }\n  - id: review\n    role: reviewer\n    depends_on: [draft]\noutputs:\n  - { name: plan, from_stage: draft, artifact: plan.md }\n",
    ],
    [
      "v1",
      "id: v1\nstages:\n  - id: draft\n    role: planner\n    produces: { artifact: plan.md }\n  - id: review\n    role: reviewer\n    depends_on: [draft]\ncompletion:\n  stage: review\n  decision: approved\n  outputs:\n    - { name: plan, from_stage: draft, artifact: plan.md }\n",
    ],
  ];
  for (const [id, text] of workflows) {
    const workspace = tempDir("migent-complete-old-");
    mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
    writeFileSync(path.join(workspace, ".migent", "workflows", `${id}.yaml`), text, "utf8");
    writeSessionConfig(workspace);
    const sessionId = createWorkflowSession(workspace, id, "Write a plan");
    freezeSessionTask(workspace, sessionId);
    const store = new SessionStore(workspace, undefined, defaultClients());
    stageRun(workspace, store, sessionId, "draft", "completed", new StageOutcome("complete"), { "plan.md": "# Plan\n" });
    expect(statusOf(workspace, sessionId).status).toBe("active");
    const result = store.completeManually(sessionId);
    expect(result.missingOutputs).toEqual([]);
    const status = statusOf(workspace, sessionId);
    expect(status.status).toBe("completed");
    expect(status.outputs).toMatchObject({ plan: { path: "outputs/plan.md", published_by_execution_id: "manual" } });
    expect(repairSession(workspace, sessionId).status).toBe("completed");
    expect(statusOf(workspace, sessionId).outputs).toEqual(status.outputs);
  }
});

test("agent-driven completion sets completion_method: agent", () => {
  const { workspace, store, sessionId } = started();
  stageRun(workspace, store, sessionId, "draft", "completed", new StageOutcome("complete"), { "plan.md": "# Plan\n" });
  stageRun(workspace, store, sessionId, "extra", "completed", new StageOutcome("complete"), { "notes.md": "notes\n" });
  const status = statusOf(workspace, sessionId);
  expect(status.status).toBe("completed");
  expect(status.completion_method).toBe("agent");
  expect(status).not.toHaveProperty("manual_completion");
});
