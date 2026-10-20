import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { AgentToolRunner, AgentSessionRecord, GrokAdapter, createAgentSession, createWorkflowSession } from "../src/index.ts";
import {
  BlockedAdapter,
  FakeAdapter,
  MissingOutcomeAdapter,
  ScriptedAdapter,
  repoWorkflowText,
  tempDir,
  writePlanReviewSession,
  writeSessionConfig,
} from "./support.ts";

function executionFile(workspace: string, sessionId: string, executionId: string): string {
  return path.join(
    workspace,
    ".migent",
    "sessions",
    sessionId,
    "executions",
    executionId,
    "execution.json",
  );
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

test("reads legacy native session id as agent id", () => {
  const record = AgentSessionRecord.fromJson(
    { native_session_id: "legacy-provider-id" },
    "grok",
    "grok-4.6",
    "/repo",
  );
  expect(record.agentId).toBe("legacy-provider-id");
  expect(record.toJson()).not.toHaveProperty("native_session_id");
});

test("resume reuses agent id on a new execution", async () => {
  const adapter = new FakeAdapter();
  const runner = new AgentToolRunner({ fake: adapter }, 10);
  const tmp = tempDir("migent-runner-");
  const first = await runner.run({ provider: "fake", model: "m1", prompt: "first prompt", workspace: tmp });
  const second = await runner.run({
    provider: "fake",
    model: "m1",
    prompt: "second prompt",
    workspace: tmp,
    sessionId: first.session_id,
    resumeExecutionId: first.execution_id,
  });
  const execution = readJson(executionFile(tmp, second.session_id, second.execution_id));
  expect(second.session_id).toBe(first.session_id);
  expect(second.execution_id).not.toBe(first.execution_id);
  expect(adapter.calls[1]?.agentId).toBe("native-session-1");
  expect(execution.resumes_execution_id).toBe(first.execution_id);
});

test("writes conversation checkpoint", async () => {
  const runner = new AgentToolRunner({ fake: new FakeAdapter() }, 10);
  const tmp = tempDir("migent-runner-");
  const result = await runner.run({ provider: "fake", model: "m1", prompt: "first prompt", workspace: tmp });
  const executionDirectory = path.dirname(executionFile(tmp, result.session_id, result.execution_id));
  expect(existsSync(path.join(executionDirectory, "conversation.json"))).toBe(true);
  expect(existsSync(path.join(executionDirectory, "session.json"))).toBe(false);
});

test("resumes from legacy session checkpoint", async () => {
  const adapter = new FakeAdapter();
  const runner = new AgentToolRunner({ fake: adapter }, 10);
  const tmp = tempDir("migent-runner-");
  const first = await runner.run({ provider: "fake", model: "m1", prompt: "first prompt", workspace: tmp });
  const executionDirectory = path.dirname(executionFile(tmp, first.session_id, first.execution_id));
  renameSync(path.join(executionDirectory, "conversation.json"), path.join(executionDirectory, "session.json"));
  await runner.run({
    provider: "fake",
    model: "m1",
    prompt: "second prompt",
    workspace: tmp,
    sessionId: first.session_id,
    resumeExecutionId: first.execution_id,
  });
  expect(adapter.calls[1]?.agentId).toBe("native-session-1");
});

test("rejects a resume execution from another session", async () => {
  const runner = new AgentToolRunner({ fake: new FakeAdapter() }, 10);
  const tmp = tempDir("migent-runner-");
  const first = await runner.run({
    provider: "fake",
    model: "m1",
    prompt: "one",
    workspace: tmp,
    sessionId: "run-a",
  });
  await expect(
    runner.run({
      provider: "fake",
      model: "m1",
      prompt: "two",
      workspace: tmp,
      sessionId: "run-b",
      resumeExecutionId: first.execution_id,
    }),
  ).rejects.toThrow(/was not found in session/);
});

test("rejects an option change when resuming", async () => {
  const runner = new AgentToolRunner({ fake: new FakeAdapter() }, 10);
  const tmp = tempDir("migent-runner-");
  const first = await runner.run({
    provider: "fake",
    model: "m1",
    prompt: "first",
    workspace: tmp,
    options: { effort: "high" },
  });
  await expect(
    runner.run({
      provider: "fake",
      model: "m1",
      prompt: "second",
      workspace: tmp,
      sessionId: first.session_id,
      resumeExecutionId: first.execution_id,
      options: { effort: "medium" },
    }),
  ).rejects.toThrow(/different provider, model, or options/);
});

test("records loop executions without overwriting attempts", async () => {
  const runner = new AgentToolRunner({ fake: new FakeAdapter() }, 10);
  const workspace = tempDir("migent-runner-");
  const first = await runner.run({
    provider: "fake",
    model: "m1",
    prompt: "review",
    workspace,
    sessionId: "run_loop",
    stageId: "review",
  });
  const second = await runner.run({
    provider: "fake",
    model: "m1",
    prompt: "review again",
    workspace,
    sessionId: "run_loop",
    stageId: "review",
    stageAttempt: 2,
    executionOrder: 2,
  });
  const executions = path.join(workspace, ".migent", "sessions", "run_loop", "executions");
  expect(readdirSync(executions).sort()).toEqual([first.execution_id, second.execution_id].sort());
  expect(existsSync(path.join(executions, first.execution_id, "response.md"))).toBe(true);
});

test("blocks a session after a blocked stage outcome", async () => {
  const runner = new AgentToolRunner({ fake: new BlockedAdapter() }, 10);
  const workspace = tempDir("migent-runner-");
  const result = await runner.run({
    provider: "fake",
    model: "m1",
    prompt: "implement",
    workspace,
    sessionId: "blocked-run",
    stageId: "implement",
  });
  const status = readJson(path.join(workspace, ".migent", "sessions", "blocked-run", "status.json"));
  expect(result.outcome_status).toBe("blocked");
  expect(status.status).toBe("blocked");
  expect(status.blocked_by_execution_id).toBe(result.execution_id);
  await expect(
    runner.run({
      provider: "fake",
      model: "m1",
      prompt: "review",
      workspace,
      sessionId: "blocked-run",
      stageId: "review-work",
    }),
  ).rejects.toThrow(/Session blocked-run is blocked/);
  expect(readdirSync(path.join(workspace, ".migent", "sessions", "blocked-run", "executions"))).toHaveLength(1);
});

test("fails a workflow session without a stage status", async () => {
  const workspace = tempDir("migent-runner-");
  const result = await new AgentToolRunner({ fake: new MissingOutcomeAdapter() }, 10).run({
    provider: "fake",
    model: "m1",
    prompt: "implement",
    workspace,
    sessionId: "missing-status-run",
    stageId: "implement",
  });
  const sessionDirectory = path.join(workspace, ".migent", "sessions", result.session_id);
  const execution = readJson(path.join(sessionDirectory, "executions", result.execution_id, "execution.json"));
  const status = readJson(path.join(sessionDirectory, "status.json"));
  expect(execution.status).toBe("failed");
  expect(String(execution.error)).toContain("must start with");
  expect(status.status).toBe("active");
  expect(status).not.toHaveProperty("terminal_execution_id");
  const retry = await new AgentToolRunner({ fake: new FakeAdapter() }, 10).run({
    provider: "fake",
    model: "m1",
    prompt: "implement",
    workspace,
    sessionId: "missing-status-run",
    stageId: "implement",
  });
  expect(retry.outcome_status).toBe("complete");
  expect(retry.execution_id).not.toBe(result.execution_id);
  const retryStatus = readJson(path.join(sessionDirectory, "status.json"));
  expect(retryStatus.status).toBe("active");
});

test("rejects provider options before creating a session", async () => {
  const runner = new AgentToolRunner({ grok: new GrokAdapter() }, 10);
  const tmp = tempDir("migent-runner-");
  await expect(
    runner.run({
      provider: "grok",
      model: "grok-4",
      prompt: "prompt",
      workspace: tmp,
      options: { temperature: "0.2" },
    }),
  ).rejects.toThrow(/temperature is not a grok option/);
  expect(existsSync(path.join(tmp, ".migent"))).toBe(false);
});

test("constructs the default adapter registry", async () => {
  const { defaultAdapters } = await import("../src/index.ts");
  const first = defaultAdapters();
  const second = defaultAdapters();
  expect(new Set(Object.keys(new AgentToolRunner().adapters))).toEqual(new Set(["codex", "grok"]));
  expect(new Set(Object.keys(first))).toEqual(new Set(["codex", "grok"]));
  expect(first).not.toBe(second);
  expect(first.codex).not.toBe(second.codex);
  const tmp = tempDir("migent-runner-");
  await expect(
    new AgentToolRunner({ fake: new FakeAdapter() }, 10).run({
      provider: "missing",
      model: "m1",
      prompt: "prompt",
      workspace: tmp,
    }),
  ).rejects.toThrow(/Unsupported CLI provider/);
});

test("allows another execution on a completed agent session", async () => {
  const runner = new AgentToolRunner({ fake: new FakeAdapter() }, 10);
  const workspace = tempDir("migent-runner-");
  const sessionId = createAgentSession(workspace, "reviewer", "review the plan");
  const first = await runner.run({
    provider: "fake",
    model: "m1",
    prompt: "first",
    workspace,
    sessionId,
    stageId: "reviewer",
  });
  const statusPath = path.join(workspace, ".migent", "sessions", sessionId, "status.json");
  const status = readJson(statusPath);
  expect(status.status).toBe("completed");
  const second = await runner.run({
    provider: "fake",
    model: "m1",
    prompt: "second",
    workspace,
    sessionId,
    stageId: "reviewer",
  });
  expect(second.outcome_status).toBe("complete");
  expect(second.execution_id).not.toBe(first.execution_id);
});

test("refuses another execution on a completed named workflow session", async () => {
  const runner = new AgentToolRunner({ fake: new FakeAdapter() }, 10);
  const workspace = tempDir("migent-runner-");
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workflows, "plan.yaml"), repoWorkflowText("plan"), "utf8");
  writeSessionConfig(workspace);
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  const statusPath = path.join(workspace, ".migent", "sessions", sessionId, "status.json");
  const status = readJson(statusPath);
  status.status = "completed";
  status.terminal_execution_id = "exec-1";
  writeFileSync(statusPath, JSON.stringify(status), "utf8");
  await expect(
    runner.run({
      provider: "fake",
      model: "m1",
      prompt: "again",
      workspace,
      sessionId,
      stageId: "plan",
    }),
  ).rejects.toThrow(
    `Session ${sessionId} is completed at exec-1; start a new session to continue.`,
  );
});

test("approved completion publishes the reviewed artifact and the session status becomes completed", async () => {
  const [workspace, sessionId] = writePlanReviewSession();
  const runner = new AgentToolRunner(
    {
      fake: new ScriptedAdapter(
        ["status: complete\n\nplanned", "status: complete\ndecision: approved\n\nlooks good"],
        ["# Plan v1\n", null],
      ),
    },
    10,
  );
  await runner.run({
    provider: "fake",
    model: "m1",
    prompt: "plan",
    workspace,
    sessionId,
    stageId: "plan",
  });
  const review = await runner.run({
    provider: "fake",
    model: "m1",
    prompt: "review",
    workspace,
    sessionId,
    stageId: "review-plan",
  });
  const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
  const status = readJson(path.join(sessionDirectory, "status.json"));
  expect(readFileSync(path.join(sessionDirectory, "outputs", "plan"), "utf8")).toBe("# Plan v1\n");
  expect(status.status).toBe("completed");
  expect(review.session_status).toBe("completed");
});

test("missing or whitespace-only artifact fails that stage", async () => {
  for (const body of [null, "   \n"] as const) {
    const [workspace, sessionId] = writePlanReviewSession();
    const result = await new AgentToolRunner(
      {
        fake: new ScriptedAdapter(["status: complete\n\nplanned"], body === null ? null : [body]),
      },
      10,
    ).run({
      provider: "fake",
      model: "m1",
      prompt: "plan",
      workspace,
      sessionId,
      stageId: "plan",
    });
    const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
    const execution = readJson(path.join(sessionDirectory, "executions", result.execution_id, "execution.json"));
    const status = readJson(path.join(sessionDirectory, "status.json"));
    expect(execution.status).toBe("failed");
    expect(String(execution.error)).toContain("artifact missing");
    expect(status.status).toBe("active");
    expect(existsSync(path.join(sessionDirectory, "outputs"))).toBe(false);
  }
});

test("prose approval without a decision header fails the execution", async () => {
  const [workspace, sessionId] = writePlanReviewSession();
  const runner = new AgentToolRunner(
    {
      fake: new ScriptedAdapter(
        ["status: complete\n\nplanned", "status: complete\n\nApproved."],
        ["# Plan v1\n", null],
      ),
    },
    10,
  );
  await runner.run({
    provider: "fake",
    model: "m1",
    prompt: "plan",
    workspace,
    sessionId,
    stageId: "plan",
  });
  const review = await runner.run({
    provider: "fake",
    model: "m1",
    prompt: "review",
    workspace,
    sessionId,
    stageId: "review-plan",
  });
  const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
  const execution = readJson(path.join(sessionDirectory, "executions", review.execution_id, "execution.json"));
  const status = readJson(path.join(sessionDirectory, "status.json"));
  expect(execution.status).toBe("failed");
  expect(String(execution.error)).toContain("decision:");
  expect(status.status).toBe("active");
  expect(existsSync(path.join(sessionDirectory, "outputs"))).toBe(false);
});
