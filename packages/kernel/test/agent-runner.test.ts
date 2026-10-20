import { execFileSync } from "node:child_process";
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

function sessionEvents(workspace: string, sessionId: string): Array<Record<string, unknown>> {
  const text = readFileSync(path.join(workspace, ".migent", "sessions", sessionId, "events.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function turnEvents(workspace: string, sessionId: string): Array<Record<string, unknown>> {
  return sessionEvents(workspace, sessionId).filter((event) => {
    if (event.event === "provider.turn_completed") return true;
    if (event.event !== "provider.turn_failed") return false;
    const details = event.details;
    return typeof details === "object" && details !== null && typeof (details as { turn?: unknown }).turn === "number";
  });
}

test("a captured turn records usage, turn, agent id, and argv", async () => {
  const adapter = new FakeAdapter();
  adapter.captureUsage = () => ({ result: { total_cost_usd: 1 } });
  const runner = new AgentToolRunner({ fake: adapter }, 10);
  const tmp = tempDir("migent-runner-");
  const result = await runner.run({ provider: "fake", model: "m1", prompt: "measure", workspace: tmp });
  const details = turnEvents(tmp, result.session_id)[0]?.details as Record<string, unknown>;
  expect(details.usage).toEqual({ result: { total_cost_usd: 1 } });
  expect(details.turn).toBe(1);
  expect(details.agent_id).toBe("native-session-1");
  expect(Array.isArray(details.argv)).toBe(true);
  expect((details.argv as string[])[0]).toBe(process.execPath);
});

test("a turn without captureUsage omits usage", async () => {
  const runner = new AgentToolRunner({ fake: new FakeAdapter() }, 10);
  const tmp = tempDir("migent-runner-");
  const result = await runner.run({ provider: "fake", model: "m1", prompt: "plain", workspace: tmp });
  const details = turnEvents(tmp, result.session_id)[0]?.details as Record<string, unknown>;
  expect(details).not.toHaveProperty("usage");
  expect(details.turn).toBe(1);
  expect(details.agent_id).toBe("native-session-1");
});

test("a throwing captureUsage still completes the execution", async () => {
  const adapter = new FakeAdapter();
  adapter.captureUsage = () => {
    throw new Error("usage failed");
  };
  const runner = new AgentToolRunner({ fake: adapter }, 10);
  const tmp = tempDir("migent-runner-");
  const result = await runner.run({ provider: "fake", model: "m1", prompt: "plain", workspace: tmp });
  const execution = readJson(executionFile(tmp, result.session_id, result.execution_id));
  expect(execution.status).toBe("completed");
  const details = turnEvents(tmp, result.session_id)[0]?.details as Record<string, unknown>;
  expect(details).not.toHaveProperty("usage");
});

test("two red verify runs write three numbered turns", async () => {
  const workspace = tempDir("migent-runner-verify-");
  const script = path.join(workspace, "gate.cjs");
  const count = path.join(workspace, "gate.count");
  writeFileSync(
    script,
    `const fs=require("fs");const f=${JSON.stringify(count)};const n=fs.existsSync(f)?Number(fs.readFileSync(f,"utf8")):0;fs.writeFileSync(f,String(n+1));if(n<2)process.exit(1);`,
  );
  const command = `"${process.execPath}" "${script}"`;
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeSessionConfig(workspace);
  writeFileSync(
    path.join(workspace, ".migent", "workflows", "wf.yaml"),
    `id: wf
stages:
  - id: implement
    role: developer
    produces:
      artifact: notes.md
    verify:
      - ${JSON.stringify(command)}
  - id: review
    role: developer
    depends_on: [implement]
completion:
  stage: review
`,
    "utf8",
  );
  const sessionId = createWorkflowSession(workspace, "wf", "task");
  const runner = new AgentToolRunner(
    { fake: new ScriptedAdapter(["status: complete\n\ndone", "status: complete\n\ndone", "status: complete\n\ndone"], ["# notes\n", null, null]) },
    10,
  );
  await runner.run({ provider: "fake", model: "m1", prompt: "go", workspace, sessionId, stageId: "implement" });
  const turns = turnEvents(workspace, sessionId).map((event) => (event.details as { turn: number }).turn);
  expect(turns).toEqual([1, 2, 3]);
});

test("progress turn_failed and the runner turn_failed are both recorded", async () => {
  const adapter = new FakeAdapter();
  adapter.buildCommand = () => ({
    argv: [
      process.execPath,
      "-e",
      "process.stdout.write(process.argv[1] + \"\\n\"); process.exit(1)",
      JSON.stringify({ type: "fail" }),
    ],
  });
  adapter.parseResponse = () => ["status: complete\n\ndone", "native-session-1"];
  adapter.parseProgressEvent = () => ({ event: "provider.turn_failed", summary: "boom" });
  const runner = new AgentToolRunner({ fake: adapter }, 10);
  const tmp = tempDir("migent-runner-");
  const result = await runner.run({ provider: "fake", model: "m1", prompt: "fail", workspace: tmp });
  const failed = sessionEvents(tmp, result.session_id).filter((event) => event.event === "provider.turn_failed");
  expect(failed).toHaveLength(2);
  expect(failed.filter((event) => {
    const details = event.details;
    return typeof details === "object" && details !== null && typeof (details as { turn?: unknown }).turn === "number";
  })).toHaveLength(1);
});

test("stage_started records git head and dirty state", async () => {
  const repo = tempDir("migent-runner-git-");
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  mkdirSync(path.join(repo, ".migent"), { recursive: true });
  writeFileSync(path.join(repo, ".migent", ".gitignore"), "sessions/\n");
  execFileSync("git", ["add", ".migent/.gitignore"], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", "commit", "-m", "ignore sessions"],
    { cwd: repo, stdio: "ignore" },
  );
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const runner = new AgentToolRunner({ fake: new FakeAdapter() }, 10);
  const first = await runner.run({ provider: "fake", model: "m1", prompt: "one", workspace: repo });
  const clean = sessionEvents(repo, first.session_id).find((event) => event.event === "provider.stage_started");
  expect(clean?.details).toMatchObject({ git_head: head, git_dirty: false });
  writeFileSync(path.join(repo, "untracked.txt"), "x\n");
  await runner.run({
    provider: "fake",
    model: "m1",
    prompt: "two",
    workspace: repo,
    sessionId: first.session_id,
  });
  const dirty = sessionEvents(repo, first.session_id).filter((event) => event.event === "provider.stage_started");
  expect(dirty[1]?.details).toMatchObject({ git_head: head, git_dirty: true });

  const outside = tempDir("migent-runner-nogit-");
  const bare = await new AgentToolRunner({ fake: new FakeAdapter() }, 10).run({
    provider: "fake",
    model: "m1",
    prompt: "three",
    workspace: outside,
  });
  const none = sessionEvents(outside, bare.session_id).find((event) => event.event === "provider.stage_started");
  expect(none?.details).toMatchObject({ git_head: null, git_dirty: null });
});

test("the version command runs once for two executions", async () => {
  const tmp = tempDir("migent-runner-version-");
  const hits = path.join(tmp, "hits.txt");
  const adapter = new FakeAdapter();
  adapter.versionCommand = () => [
    process.execPath,
    "-e",
    `require("fs").appendFileSync(${JSON.stringify(hits)}, "1\\n"); process.stdout.write("2.1.304\\n");`,
  ];
  adapter.parseVersion = (stdout: string) => {
    const line = stdout.trim();
    return line === "" ? null : line;
  };
  const runner = new AgentToolRunner({ fake: adapter }, 10);
  const first = await runner.run({ provider: "fake", model: "m1", prompt: "one", workspace: tmp });
  await runner.run({ provider: "fake", model: "m1", prompt: "two", workspace: tmp, sessionId: first.session_id });
  const versions = sessionEvents(tmp, first.session_id)
    .filter((event) => event.event === "provider.stage_started")
    .map((event) => (event.details as { cli_version?: unknown }).cli_version);
  expect(versions).toEqual(["2.1.304", "2.1.304"]);
  expect(readFileSync(hits, "utf8")).toBe("1\n");
});
