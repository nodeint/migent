import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ConfigurationError, executeNamedWorkflow, loadWorkflowDocument, SessionLock } from "../src/index.ts";
import { readFoldedStatus, statusDriftMessage } from "../src/session-fold.ts";
import { appendLifecycleEvent, readParsedEvents } from "../src/session-events.ts";
import { repairSession } from "../src/session-repair.ts";
import { createAgentSession, createWorkflowSession } from "../src/session-records.ts";
import { clearInFlightExecution, noteInFlightExecution, SessionStore } from "../src/session-store.ts";
import { StageOutcome } from "../src/stage-outcome.ts";
import { freezeSessionTask } from "../src/task-file.ts";
import { tempDir, writeSessionConfig } from "./support.ts";

const PLAN = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workflows", "plan.yaml"),
  "utf8",
);

function workspaceWithPlan(): string {
  const workspace = tempDir("migent-fold-");
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workflows, "plan.yaml"), PLAN, "utf8");
  writeSessionConfig(workspace);
  return workspace;
}

function sessionDirectory(workspace: string, sessionId: string): string {
  return path.join(workspace, ".migent", "sessions", sessionId);
}

function readStatus(workspace: string, sessionId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(sessionDirectory(workspace, sessionId), "status.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function expectFold(workspace: string, sessionId: string): Record<string, unknown> {
  const written = readStatus(workspace, sessionId);
  expect(readFoldedStatus(workspace, sessionDirectory(workspace, sessionId))).toEqual(written);
  return written;
}

function eventsText(workspace: string, sessionId: string): string {
  return readFileSync(path.join(sessionDirectory(workspace, sessionId), "events.jsonl"), "utf8");
}

test("the fold matches status.json after each session write", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  const created = expectFold(workspace, sessionId);
  expect(created.status).toBe("active");
  expect(created.workflow_id).toBe("plan");
  expect(eventsText(workspace, sessionId)).toContain("\"event\":\"session.created\"");

  freezeSessionTask(workspace, sessionId);
  const frozen = expectFold(workspace, sessionId);
  expect(frozen.task_sha256).toMatch(/^[a-f0-9]{64}$/);

  const store = new SessionStore(workspace);
  const [planRecord, , planContext] = store.loadOrCreate(
    "fake",
    "fake-model",
    {},
    workspace,
    sessionId,
    "plan",
    null,
    null,
    "plan the work",
  );
  const started = expectFold(workspace, sessionId);
  expect(started.latest_execution_id).toBe(planContext.executionId);
  expect(started.latest_execution_status).toBe("running");

  store.saveExecution(planContext, planRecord, "running");
  expectFold(workspace, sessionId);
  const runningStatus = readFileSync(path.join(sessionDirectory(workspace, sessionId), "status.json"), "utf8");
  store.recordProviderEvent(planContext, {
    event: "provider.stage_started",
    provider: "fake",
    session_id: sessionId,
    execution_id: planContext.executionId,
    stage_id: "plan",
    timestamp: "2026-10-19T00:00:00+00:00",
    summary: "fake/fake-model",
  });
  expectFold(workspace, sessionId);
  const afterStage = readFileSync(path.join(sessionDirectory(workspace, sessionId), "status.json"), "utf8");
  expect(afterStage).not.toBe(runningStatus);
  store.recordProviderEvent(planContext, {
    event: "provider.heartbeat",
    provider: "fake",
    session_id: sessionId,
    execution_id: planContext.executionId,
    stage_id: "plan",
    timestamp: "2026-10-19T00:00:01+00:00",
    summary: "running for 1s",
  });
  store.recordProviderEvent(planContext, {
    event: "provider.item_started",
    provider: "fake",
    session_id: sessionId,
    execution_id: planContext.executionId,
    stage_id: "plan",
    timestamp: "2026-10-19T00:00:02+00:00",
    summary: "command started",
  });
  expect(readFileSync(path.join(sessionDirectory(workspace, sessionId), "status.json"), "utf8")).toBe(afterStage);
  const afterHeartbeat = readFileSync(path.join(sessionDirectory(workspace, sessionId), "status.json"), "utf8");
  store.recordProviderEvent(planContext, {
    event: "verify.heartbeat",
    provider: "fake",
    session_id: sessionId,
    execution_id: planContext.executionId,
    stage_id: "plan",
    timestamp: "2026-10-19T00:00:03+00:00",
    summary: "verify running",
  });
  expect(readFileSync(path.join(sessionDirectory(workspace, sessionId), "status.json"), "utf8")).toBe(afterHeartbeat);
  const log = eventsText(workspace, sessionId);
  expect(log).not.toContain("provider.item_started");
  expect(log).not.toContain("provider.heartbeat");
  expect(log).toContain("verify.heartbeat");
  const stream = readFileSync(path.join(planContext.directory, "stream.jsonl"), "utf8");
  expect(stream).toContain("provider.item_started");
  expect(stream).toContain("provider.heartbeat");

  writeFileSync(path.join(planContext.artifactDirectory, "plan.md"), "# Plan\n", "utf8");
  store.saveExecution(planContext, planRecord, "completed", null, new StageOutcome("complete"));
  const planned = expectFold(workspace, sessionId);
  expect(planned.status).toBe("active");
  expect(planned.running_stages).toBeUndefined();
  expect(planned.current_stage).toBeUndefined();

  const [reviewRecord, , reviewContext] = store.loadOrCreate(
    "fake",
    "fake-model",
    {},
    workspace,
    sessionId,
    "review-plan",
    null,
    null,
    "review the plan",
  );
  expectFold(workspace, sessionId);
  store.saveExecution(reviewContext, reviewRecord, "completed", null, new StageOutcome("complete", null, "approved"));
  const published = expectFold(workspace, sessionId);
  expect(published.status).toBe("completed");
  expect(published.outputs).toMatchObject({
    plan: {
      path: "outputs/plan.md",
      source_execution_id: planContext.executionId,
      published_by_execution_id: reviewContext.executionId,
    },
  });
  expect(eventsText(workspace, sessionId)).toContain("\"event\":\"outputs.published\"");
  expect(eventsText(workspace, sessionId)).toContain("\"event\":\"session.completed\"");

  store.resetRevisionCounts(sessionId, store.executionSnapshots(sessionId));
  const reset = expectFold(workspace, sessionId);
  expect(reset.revision_baselines).toEqual({ plan: 1, "review-plan": 1 });

  const sequences = [
    ...readParsedEvents(path.join(sessionDirectory(workspace, sessionId), "events.jsonl")),
    ...readParsedEvents(path.join(planContext.directory, "stream.jsonl")),
  ]
    .map((event) => event.seq)
    .filter((seq): seq is number => seq !== null)
    .sort((left, right) => left - right);
  expect(sequences).toEqual(sequences.map((_, index) => index + 1));
});

test("the fold matches status.json for every workflow fixture", () => {
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workflows");
  for (const name of readdirSync(fixtures).filter((entry) => entry.endsWith(".yaml"))) {
    const workspace = tempDir("migent-fold-fixture-");
    const workflows = path.join(workspace, ".migent", "workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(path.join(workflows, name), readFileSync(path.join(fixtures, name), "utf8"), "utf8");
    writeSessionConfig(workspace);
    const workflowId = name.slice(0, -".yaml".length);
    const sessionId = createWorkflowSession(workspace, workflowId, "Write the change");
    expectFold(workspace, sessionId);
    freezeSessionTask(workspace, sessionId);
    expectFold(workspace, sessionId);
    const workflow = loadWorkflowDocument(path.join(workflows, name));
    const stageId = Object.values(workflow.stages)[0]?.id;
    if (!stageId) throw new Error(`${workflowId} declares no stages.`);
    const store = new SessionStore(workspace);
    const [, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, stageId, null, null, "work");
    const started = expectFold(workspace, sessionId);
    expect(started.latest_execution_id).toBe(context.executionId);
    expect(started.latest_execution_status).toBe("running");
  }
});

test("a directory created before execution.json leaves no event and is not reused", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  const directory = sessionDirectory(workspace, sessionId);
  const before = eventsText(workspace, sessionId);
  mkdirSync(path.join(directory, "executions", "0001-plan--attempt-01"), { recursive: true });
  expect(eventsText(workspace, sessionId)).toBe(before);
  const store = new SessionStore(workspace);
  const lock = SessionLock.acquire(directory);
  try {
    const [, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "plan", null, null, "plan");
    expect(context.executionId).toBe("0002-plan--attempt-02");
    expect(eventsText(workspace, sessionId)).not.toContain("0001-plan--attempt-01");
    expect(eventsText(workspace, sessionId)).toContain(`"execution_id":"${context.executionId}"`);
  } finally {
    lock.release();
  }
});

test("repair rebuilds a running execution whose started event is missing", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  const directory = sessionDirectory(workspace, sessionId);
  const store = new SessionStore(workspace);
  const [, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "plan", null, null, "plan");
  const kept = eventsText(workspace, sessionId)
    .split("\n")
    .filter((line) => line.includes("\"event\":\"session.created\""))
    .join("\n");
  writeFileSync(path.join(directory, "events.jsonl"), kept.endsWith("\n") || kept === "" ? kept : `${kept}\n`, "utf8");
  const restored = repairSession(workspace, sessionId);
  expect(eventsText(workspace, sessionId)).toContain("\"event\":\"execution.started\"");
  expect(eventsText(workspace, sessionId)).not.toContain("\"event\":\"execution.completed\"");
  expect(restored.latest_execution_id).toBe(context.executionId);
  expect(restored.latest_execution_status).toBe("running");
  expectFold(workspace, sessionId);
});

test("repair rebuilds a truncated schema 2 status.json", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  freezeSessionTask(workspace, sessionId);
  const store = new SessionStore(workspace);
  const [record, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "plan", null, null, "plan");
  writeFileSync(path.join(context.artifactDirectory, "plan.md"), "# Plan\n", "utf8");
  store.saveExecution(context, record, "completed", null, new StageOutcome("complete"));
  const intact = readStatus(workspace, sessionId);
  writeFileSync(path.join(sessionDirectory(workspace, sessionId), "status.json"), "{", "utf8");
  const restored = repairSession(workspace, sessionId);
  expect(restored.task_sha256).toBe(intact.task_sha256);
  expect(restored.latest_execution_id).toBe(context.executionId);
  expect(restored.workflow_id).toBe("plan");
  expectFold(workspace, sessionId);
});

test("continue repairs a status.json that missed its event, and refuses a destroyed one", async () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  freezeSessionTask(workspace, sessionId);
  const store = new SessionStore(workspace);
  const [record, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "plan", null, null, "plan");
  writeFileSync(path.join(context.artifactDirectory, "plan.md"), "# Plan\n", "utf8");
  store.saveExecution(context, record, "completed", null, new StageOutcome("complete"));
  const [reviewRecord, , reviewContext] = store.loadOrCreate(
    "fake",
    "model",
    {},
    workspace,
    sessionId,
    "review-plan",
    null,
    null,
    "review",
  );
  store.saveExecution(reviewContext, reviewRecord, "completed", null, new StageOutcome("complete", null, "approved"));
  const directory = sessionDirectory(workspace, sessionId);
  const intact = readStatus(workspace, sessionId);
  expect(intact.status).toBe("completed");
  const hash = intact.task_sha256;
  writeFileSync(path.join(directory, "status.json"), JSON.stringify({ session_id: sessionId, status: "active" }), "utf8");
  const restored = repairSession(workspace, sessionId);
  expect(restored.task_sha256).toBe(hash);
  expect(restored.latest_execution_id).toBe(reviewContext.executionId);
  expectFold(workspace, sessionId);

  writeFileSync(path.join(directory, "outputs", "notes"), "orphan\n", "utf8");
  const withFile = repairSession(workspace, sessionId);
  expect(withFile.outputs).toMatchObject({
    plan: intact.outputs?.plan,
    notes: { path: "outputs/notes" },
  });
  expect(withFile.outputs?.notes).not.toHaveProperty("source_execution_id");
  expect(withFile.outputs?.notes).not.toHaveProperty("published_by_execution_id");
  expectFold(workspace, sessionId);

  const partial = {
    session_id: sessionId,
    workflow_id: "plan",
    task_sha256: hash,
    outputs: intact.outputs,
    status: "active",
  };
  writeFileSync(path.join(directory, "status.json"), JSON.stringify(partial), "utf8");
  const continued = await executeNamedWorkflow(workspace, { sessionId, resetRevisions: true });
  expect(continued.stopReason).toBe("completed");
  expect(continued.status).toBe("completed");
  const kept = readStatus(workspace, sessionId);
  expect(kept.task_sha256).toBe(hash);
  expect(kept.outputs).toMatchObject(intact.outputs as Record<string, unknown>);
  expect(kept.workflow_id).toBe("plan");

  markSchema1(workspace, sessionId);
  writeFileSync(path.join(directory, "status.json"), "{", "utf8");
  await expect(executeNamedWorkflow(workspace, { sessionId })).rejects.toThrow(/--accept-task/);
  expect(() => repairSession(workspace, sessionId)).toThrow(ConfigurationError);
  expect(() => repairSession(workspace, sessionId)).toThrow(/task_sha256/);
  const task = readFileSync(path.join(directory, "task.md"), "utf8");
  const accepted = repairSession(workspace, sessionId, { acceptTask: true });
  expect(accepted.task_sha256).toBe(createHash("sha256").update(task, "utf8").digest("hex"));
  expect(accepted.task_sha256).not.toBe("");
  expectFold(workspace, sessionId);
});

test("a schema 2 repair rebuilds missing execution events and ignores a forged start", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  const directory = sessionDirectory(workspace, sessionId);
  markSchema2(workspace, sessionId);
  const store = new SessionStore(workspace);
  const [record, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "plan", null, null, "plan");
  store.saveExecution(context, record, "completed", null, new StageOutcome("complete"));
  const kept = eventsText(workspace, sessionId)
    .split("\n")
    .filter((line) => line.includes("session.created"))
    .join("\n");
  writeFileSync(path.join(directory, "events.jsonl"), kept.endsWith("\n") || kept === "" ? kept : `${kept}\n`, "utf8");
  repairSession(workspace, sessionId);
  const repaired = eventsText(workspace, sessionId);
  expect(repaired).toContain("\"event\":\"execution.started\"");
  expect(repaired).toContain("\"event\":\"execution.completed\"");
  expectFold(workspace, sessionId);
  expect(readStatus(workspace, sessionId).latest_execution_id).toBe(context.executionId);

  appendLifecycleEvent(directory, {
    event: "execution.started",
    timestamp: "2026-10-19T00:00:00+00:00",
    executionId: "0005-plan--attempt-01",
    stageId: "plan",
    data: { execution_order: 5, stage_attempt: 1, provider: "fake", model: "model", resumes_execution_id: null },
  });
  mkdirSync(path.join(directory, "executions", "0003-plan--attempt-01"));
  const folded = readFoldedStatus(workspace, directory);
  expect(folded.latest_execution_id).not.toBe("0005-plan--attempt-01");
  const [, , next] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "plan", null, null, "again");
  expect(next.executionId).toBe("0006-plan--attempt-02");
  expect(statusDriftMessage(workspace, sessionId)).toBeNull();
  const drifted = readStatus(workspace, sessionId);
  drifted.task = "changed by hand";
  writeFileSync(path.join(directory, "status.json"), `${JSON.stringify(drifted, null, 2)}\n`, "utf8");
  expect(statusDriftMessage(workspace, sessionId)).toContain("task");
});

test("a new running execution does not keep the previous current stage", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  const directory = sessionDirectory(workspace, sessionId);
  const store = new SessionStore(workspace);
  const [record, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "plan", null, null, "plan");
  appendLifecycleEvent(directory, {
    event: "provider.stage_started",
    timestamp: "2026-10-19T00:00:01+00:00",
    executionId: context.executionId,
    stageId: "plan",
    summary: "old",
  });
  store.saveExecution(context, record, "completed", null, new StageOutcome("complete"));
  const [, , next] = store.loadOrCreate(
    "fake",
    "model",
    {},
    workspace,
    sessionId,
    "review-plan",
    null,
    null,
    "review",
  );
  const started = readStatus(workspace, sessionId);
  expect(started.latest_execution_id).toBe(next.executionId);
  expect(started.latest_execution_status).toBe("running");
  expect(started.running_stages).toBeUndefined();
  expect(started.current_stage).toBeUndefined();
  markSchema2(workspace, sessionId);
  const folded = readFoldedStatus(workspace, directory);
  expect(folded.latest_execution_id).toBe(next.executionId);
  expect(folded.running_stages).toBeUndefined();
  expect(folded.current_stage).toBeUndefined();
  appendLifecycleEvent(directory, {
    event: "provider.stage_started",
    timestamp: "2026-10-19T00:00:03+00:00",
    executionId: next.executionId,
    stageId: "review-plan",
    summary: "new",
  });
  const refreshed = repairSession(workspace, sessionId);
  expect(refreshed.running_stages).toEqual([
    expect.objectContaining({
      execution_id: next.executionId,
      stage_id: "review-plan",
      event: "provider.stage_started",
    }),
  ]);
  expect(refreshed.current_stage).toBeUndefined();
  expectFold(workspace, sessionId);
});

test("junk files in outputs are not recorded", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  markSchema2(workspace, sessionId);
  const outputs = path.join(sessionDirectory(workspace, sessionId), "outputs");
  mkdirSync(outputs, { recursive: true });
  writeFileSync(path.join(outputs, "notes"), "orphan\n", "utf8");
  for (const name of [".DS_Store", "plan.md~", "Thumbs.db", "desktop.ini", ".notes.swp", ".notes.tmp"]) {
    writeFileSync(path.join(outputs, name), "junk", "utf8");
  }
  const recorded = repairSession(workspace, sessionId);
  expect(recorded.outputs).toEqual({ notes: { path: "outputs/notes" } });
  for (const name of [".DS_Store", "plan.md~", "Thumbs.db", "desktop.ini", ".notes.swp", ".notes.tmp"]) {
    unlinkSync(path.join(outputs, name));
  }
  const kept = repairSession(workspace, sessionId);
  expect(kept.outputs).toEqual({ notes: { path: "outputs/notes" } });
  unlinkSync(path.join(outputs, "notes"));
  expect(() => repairSession(workspace, sessionId)).toThrow(/outputs\.notes would be dropped/);
});

test("a v1 show does not report fold drift", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  markSchema1(workspace, sessionId);
  const status = readStatus(workspace, sessionId);
  status.task = "changed by hand";
  writeFileSync(path.join(sessionDirectory(workspace, sessionId), "status.json"), JSON.stringify(status), "utf8");
  expect(statusDriftMessage(workspace, sessionId)).toBeNull();
});

test("repair refuses a parsed hash the fold would replace", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  freezeSessionTask(workspace, sessionId);
  const directory = sessionDirectory(workspace, sessionId);
  appendLifecycleEvent(directory, {
    event: "task.frozen",
    timestamp: "2026-10-19T00:00:00+00:00",
    data: { sha256: "a".repeat(64) },
  });
  expect(() => repairSession(workspace, sessionId, { acceptTask: true })).toThrow(/task_sha256 would be dropped/);
  expect(() => repairSession(workspace, sessionId, { acceptTask: true })).not.toThrow(/--accept-task/);
  expect(readStatus(workspace, sessionId).task_sha256).not.toBe("a".repeat(64));
});

test("an execution file without its started event is still visible to a v1 fold", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  markSchema1(workspace, sessionId);
  const store = new SessionStore(workspace);
  const [record, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "plan", null, null, "plan");
  store.saveExecution(context, record, "failed", "boom", null);
  const directory = sessionDirectory(workspace, sessionId);
  const lines = eventsText(workspace, sessionId)
    .split("\n")
    .filter((line) => line !== "" && !line.includes("\"event\":\"execution.started\""));
  writeFileSync(path.join(directory, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
  writeFileSync(path.join(directory, "status.json"), "{\"status\":\"active\"}", "utf8");
  const folded = repairSession(workspace, sessionId);
  expect(folded.latest_execution_id).toBe(context.executionId);
  expect(folded.latest_execution_status).toBe("failed");
  expect(folded.workflow_id).toBe("plan");
});

function markSchema2(workspace: string, sessionId: string): void {
  const manifestPath = path.join(sessionDirectory(workspace, sessionId), "manifest.yaml");
  const text = readFileSync(manifestPath, "utf8");
  if (/^schema_version:/m.test(text)) return;
  writeFileSync(manifestPath, `${text.replace(/\n$/, "")}\nschema_version: 2\n`, "utf8");
}

function markSchema1(workspace: string, sessionId: string): void {
  const manifestPath = path.join(sessionDirectory(workspace, sessionId), "manifest.yaml");
  const stripped = readFileSync(manifestPath, "utf8").replace(/\nschema_version:.*(?:\n|$)/, "\n");
  const text = /^status:/m.test(stripped) ? stripped : `${stripped.replace(/\n$/, "")}\nstatus: running\n`;
  writeFileSync(manifestPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
}

test("a schema 2 fold keeps a finished execution when its started event is appended later", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  markSchema2(workspace, sessionId);
  const store = new SessionStore(workspace);
  const [record, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "plan", null, null, "plan");
  writeFileSync(path.join(context.artifactDirectory, "plan.md"), "# Plan\n", "utf8");
  store.saveExecution(context, record, "completed", null, new StageOutcome("complete"));
  const [reviewRecord, , reviewContext] = store.loadOrCreate(
    "fake",
    "model",
    {},
    workspace,
    sessionId,
    "review-plan",
    null,
    null,
    "review",
  );
  store.saveExecution(reviewContext, reviewRecord, "completed", null, new StageOutcome("complete", null, "approved"));
  const directory = sessionDirectory(workspace, sessionId);
  const withoutStarted = eventsText(workspace, sessionId)
    .split("\n")
    .filter((line) => line !== "" && !line.includes("\"event\":\"execution.started\""));
  writeFileSync(path.join(directory, "events.jsonl"), `${withoutStarted.join("\n")}\n`, "utf8");
  repairSession(workspace, sessionId);
  const status = readStatus(workspace, sessionId);
  expect(status.latest_execution_id).toBe(reviewContext.executionId);
  expect(status.latest_execution_status).toBe("completed");
  expect(status.latest_decision).toBe("approved");
  expect(status.status).toBe("completed");

  const withoutEarlyTerminal = eventsText(workspace, sessionId)
    .split("\n")
    .filter((line) => {
      if (!line.includes(context.executionId)) return true;
      return !line.includes("\"event\":\"execution.completed\"") && !line.includes("\"event\":\"stage.") && !line.includes("\"event\":\"session.");
    });
  writeFileSync(path.join(directory, "events.jsonl"), `${withoutEarlyTerminal.join("\n")}\n`, "utf8");
  repairSession(workspace, sessionId);
  const kept = readStatus(workspace, sessionId);
  expect(kept.latest_execution_id).toBe(reviewContext.executionId);
  expect(kept.status).toBe("completed");
  expectFold(workspace, sessionId);
});

test("a refused repair does not append reconciled events", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  freezeSessionTask(workspace, sessionId);
  markSchema2(workspace, sessionId);
  const store = new SessionStore(workspace);
  const [record, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "plan", null, null, "plan");
  store.saveExecution(context, record, "completed", null, new StageOutcome("complete"));
  const directory = sessionDirectory(workspace, sessionId);
  const stripped = eventsText(workspace, sessionId)
    .split("\n")
    .filter((line) => line !== "" && !line.includes("\"event\":\"execution.started\""));
  writeFileSync(path.join(directory, "events.jsonl"), `${stripped.join("\n")}\n`, "utf8");
  const status = readStatus(workspace, sessionId);
  status.task_sha256 = "b".repeat(64);
  writeFileSync(path.join(directory, "status.json"), JSON.stringify(status), "utf8");
  const before = eventsText(workspace, sessionId);
  expect(() => repairSession(workspace, sessionId)).toThrow(/task_sha256 would be dropped/);
  expect(() => repairSession(workspace, sessionId)).not.toThrow(/--accept-task/);
  expect(eventsText(workspace, sessionId)).toBe(before);
});

test("a repair that would reveal a torn hash does not seal it", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  freezeSessionTask(workspace, sessionId);
  markSchema2(workspace, sessionId);
  const store = new SessionStore(workspace);
  const [record, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "plan", null, null, "plan");
  store.saveExecution(context, record, "completed", null, new StageOutcome("complete"));
  const directory = sessionDirectory(workspace, sessionId);
  const eventsPath = path.join(directory, "events.jsonl");
  const stripped = eventsText(workspace, sessionId)
    .split("\n")
    .filter((line) => line !== "" && !line.includes("\"event\":\"execution.started\""));
  const torn = JSON.stringify({
    v: 2,
    event: "task.frozen",
    timestamp: "2026-10-19T00:00:02+00:00",
    data: { sha256: "b".repeat(64) },
  });
  writeFileSync(eventsPath, `${stripped.join("\n")}\n${torn}`, "utf8");
  const before = readFileSync(eventsPath, "utf8");
  const hash = readStatus(workspace, sessionId).task_sha256;
  expect(() => repairSession(workspace, sessionId)).toThrow(/task_sha256 would be dropped/);
  expect(() => repairSession(workspace, sessionId)).not.toThrow(/--accept-task/);
  expect(readFileSync(eventsPath, "utf8")).toBe(before);
  expect(readStatus(workspace, sessionId).task_sha256).toBe(hash);
});

test("a repair seals a torn tail that the fold keeps", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  freezeSessionTask(workspace, sessionId);
  markSchema2(workspace, sessionId);
  const kept = readStatus(workspace, sessionId).task_sha256;
  const store = new SessionStore(workspace);
  const [record, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "plan", null, null, "plan");
  store.saveExecution(context, record, "completed", null, new StageOutcome("complete"));
  const directory = sessionDirectory(workspace, sessionId);
  const eventsPath = path.join(directory, "events.jsonl");
  const stripped = eventsText(workspace, sessionId)
    .split("\n")
    .filter((line) => line !== "" && !line.includes("\"event\":\"execution.started\""));
  const torn = JSON.stringify({
    v: 2,
    event: "task.frozen",
    timestamp: "2026-10-19T00:00:02+00:00",
    data: { sha256: kept },
  });
  writeFileSync(eventsPath, `${stripped.join("\n")}\n${torn}`, "utf8");
  repairSession(workspace, sessionId);
  const text = readFileSync(eventsPath, "utf8");
  expect(text).toContain(`${torn}\n`);
  expect(text).toContain("\"event\":\"execution.started\"");
  expect(readStatus(workspace, sessionId).task_sha256).toBe(kept);
  expectFold(workspace, sessionId);
});

test("a partial agent status uses the manifest workflow id", () => {
  const workspace = tempDir("migent-fold-");
  const sessionId = createAgentSession(workspace, "reviewer", "Think");
  const store = new SessionStore(workspace);
  const [record, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "reviewer", null, null, "think");
  store.saveExecution(context, record, "completed", null, new StageOutcome("complete"));
  const status = readStatus(workspace, sessionId);
  status.workflow_id = "plan";
  writeFileSync(path.join(sessionDirectory(workspace, sessionId), "status.json"), JSON.stringify(status), "utf8");
  const restored = repairSession(workspace, sessionId);
  expect(restored.workflow_id).toBe("agent");
  expect(restored.status).toBe("completed");
  expectFold(workspace, sessionId);
});

test("a torn event line does not consume the next sequence number", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  const directory = sessionDirectory(workspace, sessionId);
  const eventsPath = path.join(directory, "events.jsonl");
  const before = readParsedEvents(eventsPath);
  const previousSeq = before.at(-1)?.seq ?? 0;
  writeFileSync(eventsPath, `${readFileSync(eventsPath, "utf8")}{"event":"torn"`, "utf8");
  appendLifecycleEvent(directory, {
    event: "task.frozen",
    timestamp: "2026-10-19T00:00:00+00:00",
    data: { sha256: "ab" },
  });
  const text = readFileSync(eventsPath, "utf8");
  const lines = text.split("\n").filter((line) => line !== "");
  expect(lines.some((line) => line.includes("torn"))).toBe(true);
  const last = JSON.parse(lines.at(-1) ?? "{}") as { event?: string; seq?: number };
  expect(last.event).toBe("task.frozen");
  expect(last.seq).toBe(previousSeq + 1);
});

test("a parseable torn tail is counted before the next sequence", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  const directory = sessionDirectory(workspace, sessionId);
  const eventsPath = path.join(directory, "events.jsonl");
  const previousSeq = readParsedEvents(eventsPath).at(-1)?.seq ?? 0;
  const torn = JSON.stringify({
    v: 2,
    seq: previousSeq + 1,
    event: "task.frozen",
    timestamp: "2026-10-19T00:00:00+00:00",
    data: { sha256: "aa" },
  });
  writeFileSync(eventsPath, `${readFileSync(eventsPath, "utf8")}${torn}`, "utf8");
  appendLifecycleEvent(directory, {
    event: "task.frozen",
    timestamp: "2026-10-19T00:00:01+00:00",
    data: { sha256: "bb" },
  });
  const lines = readFileSync(eventsPath, "utf8").split("\n").filter((line) => line !== "");
  const repaired = JSON.parse(lines.at(-2) ?? "{}") as { seq?: number; data?: { sha256?: string } };
  const added = JSON.parse(lines.at(-1) ?? "{}") as { seq?: number; data?: { sha256?: string } };
  expect(repaired.seq).toBe(previousSeq + 1);
  expect(repaired.data?.sha256).toBe("aa");
  expect(added.seq).toBe(previousSeq + 2);
  expect(added.data?.sha256).toBe("bb");
});

test("a parseable torn stream line counts toward the next sequence", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  const directory = sessionDirectory(workspace, sessionId);
  const previousSeq = readParsedEvents(path.join(directory, "events.jsonl")).at(-1)?.seq ?? 0;
  const executionDirectory = path.join(directory, "executions", "0001-plan--attempt-01");
  mkdirSync(executionDirectory, { recursive: true });
  const torn = JSON.stringify({
    v: 2,
    seq: previousSeq + 1,
    event: "provider.item_started",
    timestamp: "2026-10-19T00:00:00+00:00",
    execution_id: "0001-plan--attempt-01",
    stage_id: "plan",
  });
  const streamPath = path.join(executionDirectory, "stream.jsonl");
  writeFileSync(streamPath, torn, "utf8");
  appendLifecycleEvent(directory, {
    event: "task.frozen",
    timestamp: "2026-10-19T00:00:01+00:00",
    data: { sha256: "bb" },
  });
  const added = JSON.parse(
    readFileSync(path.join(directory, "events.jsonl"), "utf8").trim().split("\n").at(-1) ?? "{}",
  ) as { seq?: number };
  expect(added.seq).toBe(previousSeq + 2);
  expect(readFileSync(streamPath, "utf8")).toBe(`${torn}\n`);
});

test("a missing workflow file does not stop the fold", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  const directory = sessionDirectory(workspace, sessionId);
  const manifestPath = path.join(directory, "manifest.yaml");
  writeFileSync(
    manifestPath,
    readFileSync(manifestPath, "utf8").replace(/workflow_path: .+\n/, "workflow_path: missing-workflow.yaml\n"),
    "utf8",
  );
  const status = readStatus(workspace, sessionId);
  status.workflow_path = "missing-workflow.yaml";
  writeFileSync(path.join(directory, "status.json"), JSON.stringify(status), "utf8");
  const store = new SessionStore(workspace);
  const [record, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "plan", null, null, "plan");
  writeFileSync(path.join(context.artifactDirectory, "plan.md"), "# Plan\n", "utf8");
  store.saveExecution(context, record, "completed", null, new StageOutcome("complete"));
  const [reviewRecord, , reviewContext] = store.loadOrCreate(
    "fake",
    "model",
    {},
    workspace,
    sessionId,
    "review-plan",
    null,
    null,
    "review",
  );
  store.saveExecution(reviewContext, reviewRecord, "completed", null, new StageOutcome("complete", null, "approved"));
  const folded = readStatus(workspace, sessionId);
  expect(folded.status).toBe("completed");
  expect(folded.workflow_id).toBe("plan");
  expect(folded.workflow_path).toBe("missing-workflow.yaml");
});

test("a schema 2 fold keeps an earlier decision while a later execution has none", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  const store = new SessionStore(workspace);
  const [record, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "plan", null, null, "plan");
  writeFileSync(path.join(context.artifactDirectory, "plan.md"), "# Plan\n", "utf8");
  store.saveExecution(context, record, "completed", null, new StageOutcome("complete"));
  const [reviewRecord, , reviewContext] = store.loadOrCreate(
    "fake",
    "model",
    {},
    workspace,
    sessionId,
    "review-plan",
    null,
    null,
    "review",
  );
  store.saveExecution(reviewContext, reviewRecord, "completed", null, new StageOutcome("complete", null, "revise"));
  const [, , again] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "plan", null, null, "again");
  markSchema2(workspace, sessionId);
  const folded = readFoldedStatus(workspace, sessionDirectory(workspace, sessionId));
  expect(folded.latest_execution_id).toBe(again.executionId);
  expect(folded.latest_execution_status).toBe("running");
  expect(folded.latest_decision).toBe("revise");
  expect(folded.status).toBe("active");
});

test("a blocked stage stays blocked when a later sibling completes", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  const store = new SessionStore(workspace);
  let noted: string | null = null;
  try {
    const [planRecord, , plan] = store.loadOrCreate(
      "fake",
      "model",
      {},
      workspace,
      sessionId,
      "plan",
      null,
      null,
      "plan",
    );
    // The first save would block the session, and loadOrCreate refuses a blocked session.
    noted = plan.executionId;
    noteInFlightExecution(sessionId, plan.executionId);
    const [reviewRecord, , review] = store.loadOrCreate(
      "fake",
      "model",
      {},
      workspace,
      sessionId,
      "review-plan",
      null,
      null,
      "review",
    );
    clearInFlightExecution(sessionId, plan.executionId);
    noted = null;
    store.saveExecution(plan, planRecord, "completed", null, new StageOutcome("blocked", "plan gate"));
    store.saveExecution(review, reviewRecord, "completed", null, new StageOutcome("complete", null, "approved"));
    const status = expectFold(workspace, sessionId);
    expect(status.status).toBe("blocked");
    expect(status.latest_execution_id).toBe(review.executionId);
    expect(status.latest_decision).toBe("approved");
    expect(status.blocked_by_execution_id).toBe(plan.executionId);
    expect(status.blocked_by_execution_ids).toEqual([plan.executionId]);
  } finally {
    if (noted) clearInFlightExecution(sessionId, noted);
  }
});

test("a later complete execution of a blocked stage leaves a non-completion stage active", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  const store = new SessionStore(workspace);
  let noted: string | null = null;
  try {
    const [blockedRecord, , blocked] = store.loadOrCreate(
      "fake",
      "model",
      {},
      workspace,
      sessionId,
      "plan",
      null,
      null,
      "plan",
    );
    noted = blocked.executionId;
    noteInFlightExecution(sessionId, blocked.executionId);
    const [doneRecord, , done] = store.loadOrCreate(
      "fake",
      "model",
      {},
      workspace,
      sessionId,
      "plan",
      null,
      null,
      "again",
    );
    clearInFlightExecution(sessionId, blocked.executionId);
    noted = null;
    store.saveExecution(blocked, blockedRecord, "completed", null, new StageOutcome("blocked", "plan gate"));
    store.saveExecution(done, doneRecord, "completed", null, new StageOutcome("complete"));
    const status = expectFold(workspace, sessionId);
    expect(status.status).toBe("active");
    expect(status.latest_execution_id).toBe(done.executionId);
    expect(status.blocked_by_execution_id).toBeUndefined();
    expect(status.blocked_by_execution_ids).toBeUndefined();
  } finally {
    if (noted) clearInFlightExecution(sessionId, noted);
  }
});

test("repair of two terminal executions appends the blocked session status", () => {
  const workspace = workspaceWithPlan();
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  const store = new SessionStore(workspace);
  let noted: string | null = null;
  try {
    const [planRecord, , plan] = store.loadOrCreate(
      "fake",
      "model",
      {},
      workspace,
      sessionId,
      "plan",
      null,
      null,
      "plan",
    );
    noted = plan.executionId;
    noteInFlightExecution(sessionId, plan.executionId);
    const [reviewRecord, , review] = store.loadOrCreate(
      "fake",
      "model",
      {},
      workspace,
      sessionId,
      "review-plan",
      null,
      null,
      "review",
    );
    clearInFlightExecution(sessionId, plan.executionId);
    noted = null;
    store.saveExecution(plan, planRecord, "completed", null, new StageOutcome("blocked", "plan gate"));
    store.saveExecution(review, reviewRecord, "completed", null, new StageOutcome("complete", null, "approved"));
    const directory = sessionDirectory(workspace, sessionId);
    const kept = eventsText(workspace, sessionId)
      .split("\n")
      .filter(
        (line) => line === "" || !line.includes(review.executionId) || !line.includes('"event":"execution.completed"'),
      );
    writeFileSync(
      path.join(directory, "events.jsonl"),
      kept.join("\n").endsWith("\n") ? kept.join("\n") : `${kept.join("\n")}\n`,
      "utf8",
    );
    repairSession(workspace, sessionId);
    const repaired = eventsText(workspace, sessionId)
      .split("\n")
      .find((line) => line.includes(review.executionId) && line.includes('"event":"execution.completed"'));
    expect(repaired).toBeDefined();
    const parsed = JSON.parse(repaired ?? "{}") as { data?: { session_status?: string } };
    expect(parsed.data?.session_status).toBe("blocked");
    const text = eventsText(workspace, sessionId);
    expect(text).not.toContain('"event":"session.completed"');
    expect(text).not.toContain('"event":"session.active"');
    const status = expectFold(workspace, sessionId);
    expect(status.status).toBe("blocked");
  } finally {
    if (noted) clearInFlightExecution(sessionId, noted);
  }
});
