import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  APPROVED,
  BLOCKED,
  CODEX_CONFIG,
  CODEX_THREAD,
  COMPLETE,
  DRAFT_NOTE,
  GROK_CONFIG,
  GROK_SESSION,
  PLAN_REVIEW,
  REVISE,
  SOLO,
  asRecords,
  executionRecords,
  executionStatuses,
  hasArgs,
  installScript,
  invocationArgv,
  providerInvocations,
  removeWorkspace,
  resumedNotes,
  runMain,
  sessionStatus,
  tempWorkspace,
  writeWorkspace,
} from "./support.ts";

test("plan review publishes the plan", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, { plan: PLAN_REVIEW });
    const [code, objects, stderr] = await runMain(workspace, ["session", "run", "--workflow", "plan", "--task", "Write a plan", "--verbose"]);
    expect(code, stderr).toBe(0);
    const result = objects[0] ?? {};
    const stages = asRecords(result.stages);
    expect(stages.map((item) => item.agent_id)).toEqual([GROK_SESSION, GROK_SESSION]);
    expect(result.stop_reason).toBe("completed");
    expect(result.session_status).toBe("completed");
    const published = path.join(workspace, ".migent", "sessions", String(result.session_id), "outputs", "plan.md");
    expect(readFileSync(published, "utf8").trim().length).toBeGreaterThan(0);
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test.each([
  ["alias", CODEX_CONFIG],
  ["inline", `schema_version: 2
roles:
  writer:
    default_model:
      provider: codex
      model: codex-test
      effort: low
`],
])("stage runs through the codex provider with an %s model", async (_kind, config) => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, config, { "draft-note": DRAFT_NOTE });
    const [code, objects, stderr] = await runMain(workspace, [
      "session",
      "run",
      "--once",
      "--workflow",
      "draft-note",
      "--task",
      "Draft a note",
      "--verbose",
    ]);
    expect(code, stderr).toBe(0);
    const result = objects[0] ?? {};
    const stage = asRecords(result.stages)[0] ?? {};
    expect(stage.agent_id).toBe(CODEX_THREAD);
    expect(stage.outcome_status).toBe("complete");
    expect(result.stop_reason).toBe("completed");
    const artifact = path.join(String(stage.artifact_directory), "note.md");
    expect(readFileSync(artifact, "utf8").trim().length).toBeGreaterThan(0);
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("invalid stdout fails the execution", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, { solo: SOLO });
    const [code, objects, stderr] = await runMain(
      workspace,
      ["session", "run", "--workflow", "solo", "--task", "Write"],
      "invalid",
    );
    expect(code, stderr).toBe(3);
    expect(objects[0]?.stop_reason).toBe("stage_failed");
    expect(executionStatuses(workspace)).toEqual(["failed"]);
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("revise publishes the later plan", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, { plan: PLAN_REVIEW });
    installScript(workspace, [
      { text: COMPLETE, artifact: "# v1\n" },
      { text: REVISE },
      { text: COMPLETE, artifact: "# v2\n" },
      { text: APPROVED },
    ]);
    const [code, objects, stderr] = await runMain(workspace, ["session", "run", "--workflow", "plan", "--task", "Write a plan", "--verbose"]);
    expect(code, stderr).toBe(0);
    const result = objects[0] ?? {};
    expect(asRecords(result.stages).map((item) => item.outcome_decision)).toEqual(["", "revise", "", "approved"]);
    expect(result.stop_reason).toBe("completed");
    const published = path.join(workspace, ".migent", "sessions", String(result.session_id), "outputs", "plan.md");
    expect(readFileSync(published, "utf8")).toBe("# v2\n");
    const invocations = providerInvocations(workspace).length;
    const [againCode, again, againStderr] = await runMain(workspace, ["session", "continue", String(result.session_id), "--verbose"]);
    expect(againCode, againStderr).toBe(0);
    expect(again[0]?.stop_reason).toBe("completed");
    expect(again[0]?.stages).toEqual([]);
    expect(providerInvocations(workspace)).toHaveLength(invocations);
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("continue redispatches a blocked review", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, { plan: PLAN_REVIEW });
    installScript(workspace, [
      { text: COMPLETE, artifact: "# plan\n" },
      { text: BLOCKED },
      { text: APPROVED },
    ]);
    const [code, objects, stderr] = await runMain(workspace, ["session", "run", "--workflow", "plan", "--task", "Write a plan"]);
    expect(code, stderr).toBe(1);
    const result = objects[0] ?? {};
    expect(result.stop_reason).toBe("blocked");
    expect(result.session_status).toBe("blocked");
    expect(sessionStatus(workspace, String(result.session_id)).status).toBe("blocked");
    expect(providerInvocations(workspace)).toHaveLength(2);
    const sessionId = String(result.session_id);
    const [resumedCode, resumed, resumedStderr] = await runMain(workspace, ["session", "continue", sessionId, "--once", "--verbose"]);
    expect(resumedCode, resumedStderr).toBe(0);
    expect(resumed[0]?.session_status).toBe("completed");
    expect(providerInvocations(workspace)).toHaveLength(3);
    const stages = asRecords(resumed[0]?.stages);
    const response = String(stages[0]?.response ?? "");
    expect(response).toContain("decision: approved");
    const [againCode, again, againStderr] = await runMain(workspace, ["session", "continue", sessionId]);
    expect(againCode, againStderr).toBe(0);
    expect(again[0]?.stop_reason).toBe("completed");
    expect(providerInvocations(workspace)).toHaveLength(3);
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("a bad response fails the stage", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, { plan: PLAN_REVIEW });
    installScript(workspace, [
      { text: "not a status header" },
      { text: COMPLETE, artifact: "# plan\n" },
      { text: APPROVED },
    ]);
    const [code, objects, stderr] = await runMain(workspace, [
      "session",
      "run",
      "--workflow",
      "plan",
      "--task",
      "Write a plan",
    ]);
    expect(code, stderr).toBe(3);
    const result = objects[0] ?? {};
    expect(result.stop_reason).toBe("stage_failed");
    const records = executionRecords(workspace, String(result.session_id));
    expect(records.map((record) => record.status)).toEqual(["failed"]);
    expect(records[0]?.stage_id).toBe("plan");
    expect(providerInvocations(workspace)).toHaveLength(1);
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("provider exit exhausts the attempt", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, { solo: SOLO });
    installScript(workspace, [{ exit: 1 }]);
    const [code, objects, stderr] = await runMain(workspace, ["session", "run", "--workflow", "solo", "--task", "Write"]);
    expect(code, stderr).toBe(3);
    expect(objects[0]?.stop_reason).toBe("stage_failed");
    expect(objects[0]?.session_status).toBe("active");
    const records = executionRecords(workspace, String(objects[0]?.session_id));
    expect(records[0]?.status).toBe("failed");
    expect(String(records[0]?.error ?? "")).toContain("exited with code 1");
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("provider error event fails the stage", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, { solo: SOLO });
    installScript(workspace, [{ events: "error", message: "quota exceeded" }]);
    const [code, objects, stderr] = await runMain(workspace, ["session", "run", "--workflow", "solo", "--task", "Write"]);
    expect(code, stderr).toBe(3);
    expect(objects[0]?.stop_reason).toBe("stage_failed");
    const records = executionRecords(workspace, String(objects[0]?.session_id));
    expect(records[0]?.status).toBe("failed");
    expect(providerInvocations(workspace)).toHaveLength(1);
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("complete without the artifact fails the stage", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, { solo: SOLO });
    installScript(workspace, [{ text: COMPLETE, skip_artifact: true }]);
    const [code, objects, stderr] = await runMain(workspace, ["session", "run", "--workflow", "solo", "--task", "Write"]);
    expect(code, stderr).toBe(3);
    const records = executionRecords(workspace, String(objects[0]?.session_id));
    expect(records[0]?.status).toBe("failed");
    expect(String(records[0]?.error ?? "")).toContain("note.md");
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("continue finishes the stage left by stage", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, { plan: PLAN_REVIEW });
    installScript(workspace, [
      { text: COMPLETE, artifact: "# plan\n" },
      { text: APPROVED },
    ]);
    const [code, objects, stderr] = await runMain(workspace, [
      "session",
      "run",
      "--workflow",
      "plan",
      "--task",
      "Write a plan",
      "--once",
    ]);
    expect(code, stderr).toBe(0);
    const started = objects[0] ?? {};
    expect(started.stop_reason).toBe("stage");
    expect(started.session_status).toBe("active");
    const [finishedCode, finished, finishedStderr] = await runMain(workspace, ["session", "continue", String(started.session_id)]);
    expect(finishedCode, finishedStderr).toBe(0);
    expect(finished[0]?.session_id).toBe(started.session_id);
    expect(finished[0]?.stop_reason).toBe("completed");
    const published = path.join(workspace, ".migent", "sessions", String(started.session_id), "outputs", "plan.md");
    expect(readFileSync(published, "utf8")).toBe("# plan\n");
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("dispatch limit leaves a session continue can finish", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, { plan: PLAN_REVIEW });
    installScript(workspace, [
      { text: COMPLETE, artifact: "# plan\n" },
      { text: APPROVED },
    ]);
    const [code, objects, stderr] = await runMain(workspace, [
      "session",
      "run",
      "--workflow",
      "plan",
      "--task",
      "Write a plan",
      "--max-dispatches",
      "1",
    ]);
    expect(code, stderr).toBe(5);
    const stopped = objects[0] ?? {};
    expect(stopped.stop_reason).toBe("dispatch_limit");
    expect(stopped.session_status).toBe("active");
    expect(providerInvocations(workspace)).toHaveLength(1);
    const [finishedCode, finished, finishedStderr] = await runMain(workspace, ["session", "continue", String(stopped.session_id)]);
    expect(finishedCode, finishedStderr).toBe(0);
    expect(finished[0]?.stop_reason).toBe("completed");
    expect(providerInvocations(workspace)).toHaveLength(2);
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("grok resume from passes the agent id", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, { notes: resumedNotes("planner") });
    installScript(workspace, [
      { text: COMPLETE, artifact: "# draft\n" },
      { text: COMPLETE, artifact: "# follow\n" },
    ]);
    const [code, objects, stderr] = await runMain(workspace, ["session", "run", "--workflow", "notes", "--task", "Write notes"]);
    expect(code, stderr).toBe(0);
    const invocations = providerInvocations(workspace);
    expect(invocations.map((item) => item.provider)).toEqual(["grok", "grok"]);
    const [first, second] = invocationArgv(workspace);
    expect(hasArgs(first ?? [], "-m", "grok-test")).toBe(true);
    expect(hasArgs(first ?? [], "--reasoning-effort", "low")).toBe(true);
    expect(first ?? []).not.toContain("--resume");
    expect(hasArgs(second ?? [], "--resume", GROK_SESSION)).toBe(true);
    const sessionId = String(objects[0]?.session_id);
    const records = executionRecords(workspace, sessionId);
    expect(records[1]?.resumes_execution_id).toBe(records[0]?.execution_id);
    expect(records[1]?.agent_id).toBe(GROK_SESSION);
    const sessionDir = path.join(workspace, ".migent", "sessions", sessionId);
    expect(readFileSync(path.join(sessionDir, "outputs", "draft.md"), "utf8")).toBe("# draft\n");
    const followArtifact = path.join(
      sessionDir,
      "executions",
      String(records[1]?.execution_id),
      "artifacts",
      "follow.md",
    );
    expect(readFileSync(followArtifact, "utf8")).toBe("# follow\n");
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("codex resume from passes the thread id", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, CODEX_CONFIG, { notes: resumedNotes("writer") });
    installScript(workspace, [
      { text: COMPLETE, artifact: "# draft\n" },
      { text: COMPLETE, artifact: "# follow\n" },
    ]);
    const [code, objects, stderr] = await runMain(workspace, ["session", "run", "--workflow", "notes", "--task", "Write notes"]);
    expect(code, stderr).toBe(0);
    const invocations = providerInvocations(workspace);
    expect(invocations.map((item) => item.provider)).toEqual(["codex", "codex"]);
    const [first, second] = invocationArgv(workspace);
    expect(hasArgs(first ?? [], "-m", "codex-test")).toBe(true);
    expect(hasArgs(first ?? [], "-c", 'model_reasoning_effort="low"')).toBe(true);
    expect(first ?? []).toContain("--approve-for-me");
    expect(first ?? []).not.toContain("resume");
    expect(hasArgs(second ?? [], "resume", CODEX_THREAD, "-")).toBe(true);
    expect(second ?? []).not.toContain("--approve-for-me");
    const records = executionRecords(workspace, String(objects[0]?.session_id));
    expect(records[1]?.resumes_execution_id).toBe(records[0]?.execution_id);
    expect(records[1]?.agent_id).toBe(CODEX_THREAD);
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("grok status after a tool event completes", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, { solo: SOLO });
    installScript(workspace, [{ events: "tool", text: COMPLETE, artifact: "# noted\n" }]);
    const [code, objects, stderr] = await runMain(workspace, ["session", "run", "--workflow", "solo", "--task", "Write", "--verbose"]);
    expect(code, stderr).toBe(0);
    expect(stderr).not.toContain("write started");
    expect(stderr).not.toContain("write completed");
    const sessionDirectory = path.join(workspace, ".migent", "sessions", String(objects[0]?.session_id));
    const events = readFileSync(path.join(sessionDirectory, "events.jsonl"), "utf8");
    expect(events).not.toContain("provider.item_started");
    const status = JSON.parse(readFileSync(path.join(sessionDirectory, "status.json"), "utf8")) as {
      latest_execution_id?: string;
    };
    const stream = readFileSync(
      path.join(sessionDirectory, "executions", String(status.latest_execution_id), "stream.jsonl"),
      "utf8",
    );
    expect(stream).toContain("provider.item_started");
    expect(asRecords(objects[0]?.stages)[0]?.outcome_status).toBe("complete");
    expect(objects[0]?.stop_reason).toBe("completed");
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("codex last message overrides stdout", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, CODEX_CONFIG, { "draft-note": DRAFT_NOTE });
    installScript(workspace, [
      {
        stdout_text: "not a status header",
        file_text: COMPLETE,
        artifact: "# noted\n",
      },
    ]);
    const [code, objects, stderr] = await runMain(workspace, [
      "session",
      "run",
      "--once",
      "--workflow",
      "draft-note",
      "--task",
      "Draft a note",
      "--verbose",
    ]);
    expect(code, stderr).toBe(0);
    const stage = asRecords(objects[0]?.stages)[0] ?? {};
    expect(stage.outcome_status).toBe("complete");
    expect(stage.agent_id).toBe(CODEX_THREAD);
    expect(readFileSync(path.join(String(stage.artifact_directory), "note.md"), "utf8")).toBe("# noted\n");
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

const BRANCH_CONFIG = `\
schema_version: 2
models:
  grok-model:
    provider: grok
    model: grok-test
roles:
  developer:
    default_model: grok-model
  reviewer:
    default_model: grok-model
  writer:
    default_model: grok-model
`;

const BRANCH_WORKFLOW = `\
schema_version: 2
id: implement
concurrency: 2
stages:
  - id: implement
    role: developer
    depends_on: []
    produces:
      artifact: implementation.md
  - id: review
    role: reviewer
    depends_on: [implement]
    decision:
      values: [approved, revise]
      routes:
        approved: [test, docs]
        revise: implement
  - id: test
    role: developer
    depends_on: [review]
  - id: docs
    role: writer
    depends_on: [review]
  - id: review-test
    role: reviewer
    depends_on: [test]
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: test
  - id: review-docs
    role: reviewer
    depends_on: [docs]
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: docs
outputs:
  - name: implementation
    from_stage: implement
    artifact: implementation.md
`;

function implementStep(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { stage: "implement", text, artifact: "# implementation\n", ...extra };
}

function stageStep(stage: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { stage, text, ...extra };
}

function invocationsFor(root: string, stage: string): Array<Record<string, unknown>> {
  return providerInvocations(root).filter((item) => item.stage === stage);
}

function eventCount(workspace: string, sessionId: string, name: string): number {
  const text = readFileSync(path.join(workspace, ".migent", "sessions", sessionId, "events.jsonl"), "utf8");
  return text.split("\n").filter((line) => line.includes(`"event":"${name}"`)).length;
}

test("test and docs overlap and review-test starts while docs runs", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, BRANCH_CONFIG, { implement: BRANCH_WORKFLOW });
    installScript(workspace, [
      implementStep(COMPLETE),
      stageStep("review", APPROVED),
      stageStep("test", COMPLETE, { delay_ms: 800 }),
      stageStep("docs", COMPLETE, { delay_ms: 2000 }),
      stageStep("review-test", APPROVED),
      stageStep("review-docs", APPROVED),
    ]);
    const [code, objects, stderr] = await runMain(workspace, [
      "session",
      "run",
      "--workflow",
      "implement",
      "--task",
      "Ship the change",
    ]);
    expect(code, stderr).toBe(0);
    const testRun = invocationsFor(workspace, "test")[0];
    const docsRun = invocationsFor(workspace, "docs")[0];
    const reviewTest = invocationsFor(workspace, "review-test")[0];
    expect(testRun).toBeDefined();
    expect(docsRun).toBeDefined();
    expect(reviewTest).toBeDefined();
    expect(Number(testRun?.started_at)).toBeLessThan(Number(docsRun?.ended_at));
    expect(Number(docsRun?.started_at)).toBeLessThan(Number(testRun?.ended_at));
    expect(Number(reviewTest?.started_at)).toBeLessThan(Number(docsRun?.ended_at));
    expect(objects[0]?.stop_reason).toBe("completed");
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("review-test revise reruns test while the docs branch continues", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, BRANCH_CONFIG, { implement: BRANCH_WORKFLOW });
    installScript(workspace, [
      implementStep(COMPLETE),
      stageStep("review", APPROVED),
      stageStep("test", COMPLETE, { delay_ms: 30 }),
      stageStep("test", COMPLETE),
      stageStep("docs", COMPLETE, { delay_ms: 10_000 }),
      stageStep("review-test", REVISE),
      stageStep("review-test", APPROVED),
      stageStep("review-docs", APPROVED),
    ]);
    const [code, , stderr] = await runMain(workspace, [
      "session",
      "run",
      "--workflow",
      "implement",
      "--task",
      "Ship the change",
    ]);
    expect(code, stderr).toBe(0);
    const tests = invocationsFor(workspace, "test");
    const docsRun = invocationsFor(workspace, "docs")[0];
    expect(tests).toHaveLength(2);
    expect(Number(tests[1]?.started_at)).toBeLessThan(Number(docsRun?.ended_at));
    expect(executionRecords(workspace).filter((record) => record.stage_id === "docs")).toHaveLength(1);
  } finally {
    removeWorkspace(workspace);
  }
}, 60_000);

test("the session completes only after both reviews approve and publishes once", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, BRANCH_CONFIG, { implement: BRANCH_WORKFLOW });
    installScript(workspace, [
      implementStep(COMPLETE),
      stageStep("review", APPROVED),
      stageStep("test", COMPLETE),
      stageStep("docs", COMPLETE),
      stageStep("review-test", APPROVED),
      stageStep("review-docs", APPROVED),
    ]);
    const [code, objects, stderr] = await runMain(workspace, [
      "session",
      "run",
      "--workflow",
      "implement",
      "--task",
      "Ship the change",
    ]);
    expect(code, stderr).toBe(0);
    const sessionId = String(objects[0]?.session_id);
    expect(objects[0]?.stop_reason).toBe("completed");
    expect(objects[0]?.outputs).toMatchObject({ implementation: { path: "outputs/implementation.md" } });
    expect(eventCount(workspace, sessionId, "outputs.published")).toBe(1);
    expect(eventCount(workspace, sessionId, "session.completed")).toBe(1);
    expect(readFileSync(path.join(workspace, ".migent", "sessions", sessionId, "outputs", "implementation.md"), "utf8")).toBe(
      "# implementation\n",
    );
    const artifactLines = stderr.split("\n").filter((line) => line.startsWith("[migent] artifact: "));
    expect(artifactLines).toEqual([
      expect.stringMatching(/\[migent\] artifact: .*[/\\]outputs[/\\]implementation\.md$/),
    ]);
    expect(readFileSync(artifactLines[0]?.slice("[migent] artifact: ".length) ?? "", "utf8")).toBe("# implementation\n");
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("a blocked docs branch lets the test branch finish and continue runs only docs", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, BRANCH_CONFIG, { implement: BRANCH_WORKFLOW });
    installScript(workspace, [
      implementStep(COMPLETE),
      stageStep("review", APPROVED),
      stageStep("test", COMPLETE),
      stageStep("review-test", APPROVED),
      stageStep("docs", BLOCKED, { delay_ms: 1500 }),
      stageStep("docs", COMPLETE),
    ]);
    const [code, objects, stderr] = await runMain(workspace, [
      "session",
      "run",
      "--workflow",
      "implement",
      "--task",
      "Ship the change",
    ]);
    expect(code, stderr).toBe(1);
    const sessionId = String(objects[0]?.session_id);
    expect(objects[0]?.stop_reason).toBe("blocked");
    expect(objects[0]?.outputs).toEqual({});
    expect(sessionStatus(workspace, sessionId).status).toBe("blocked");
    expect(existsSync(path.join(workspace, ".migent", "sessions", sessionId, "outputs", "implementation.md"))).toBe(false);
    const before = executionRecords(workspace, sessionId);
    expect(
      before.some((record) => {
        const outcome = record.outcome;
        return (
          record.stage_id === "review-test" &&
          typeof outcome === "object" &&
          outcome !== null &&
          !Array.isArray(outcome) &&
          (outcome as { decision?: unknown }).decision === "approved"
        );
      }),
    ).toBe(true);
    const [continued, , continuedStderr] = await runMain(workspace, [
      "session",
      "continue",
      sessionId,
      "--max-dispatches",
      "1",
    ]);
    expect(continued, continuedStderr).toBe(5);
    const after = executionRecords(workspace, sessionId);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)?.stage_id).toBe("docs");
    expect(after.filter((record) => record.stage_id === "test")).toHaveLength(1);
    expect(after.filter((record) => record.stage_id === "review-test")).toHaveLength(1);
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("review-test stays suspended while implement reruns and the session does not complete early", async () => {
  const workspace = tempWorkspace();
  try {
    const workflow = BRANCH_WORKFLOW.replace(
      `      routes:
        approved: [test, docs]
        revise: implement`,
      `      routes:
        approved: [test, docs]
        revise: review`,
    ).replace("        revise: docs", "        revise: implement");
    writeWorkspace(workspace, BRANCH_CONFIG, { implement: workflow });
    installScript(workspace, [
      implementStep(COMPLETE),
      implementStep(COMPLETE),
      stageStep("review", APPROVED),
      stageStep("review", APPROVED),
      stageStep("test", COMPLETE, { wait_stage: "review-docs", delay_ms: 800 }),
      stageStep("test", COMPLETE),
      stageStep("docs", COMPLETE, { delay_ms: 20 }),
      stageStep("docs", COMPLETE),
      stageStep("review-docs", REVISE, { delay_ms: 80 }),
      stageStep("review-docs", APPROVED),
      stageStep("review-test", APPROVED),
    ]);
    const [code, objects, stderr] = await runMain(workspace, [
      "session",
      "run",
      "--workflow",
      "implement",
      "--task",
      "Ship the change",
    ]);
    expect(code, stderr).toBe(0);
    const sessionId = String(objects[0]?.session_id);
    const records = executionRecords(workspace, sessionId);
    const implementations = records.filter((record) => record.stage_id === "implement");
    const reviewTests = records.filter((record) => record.stage_id === "review-test");
    expect(implementations).toHaveLength(2);
    expect(reviewTests).toHaveLength(1);
    expect(Number(reviewTests[0]?.execution_order)).toBeGreaterThan(Number(implementations[1]?.execution_order));
    expect(eventCount(workspace, sessionId, "session.completed")).toBe(1);
    expect(objects[0]?.stop_reason).toBe("completed");
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("--stage accepts the second ready stage and continue with two ready stages does not throw", async () => {
  const stageWorkspace = tempWorkspace();
  try {
    writeWorkspace(stageWorkspace, BRANCH_CONFIG, { implement: BRANCH_WORKFLOW });
    installScript(stageWorkspace, [
      implementStep(COMPLETE),
      stageStep("review", APPROVED),
      stageStep("docs", COMPLETE),
    ]);
    const [code, objects, stderr] = await runMain(stageWorkspace, [
      "session",
      "run",
      "--workflow",
      "implement",
      "--task",
      "Ship the change",
      "--max-dispatches",
      "2",
    ]);
    expect(code, stderr).toBe(5);
    const sessionId = String(objects[0]?.session_id);
    const [staged, , stagedStderr] = await runMain(stageWorkspace, ["session", "continue", sessionId, "--stage", "docs"]);
    expect(staged, stagedStderr).toBe(0);
    const records = executionRecords(stageWorkspace, sessionId);
    expect(records.filter((record) => record.stage_id === "docs")).toHaveLength(1);
    expect(records.filter((record) => record.stage_id === "test")).toHaveLength(0);
  } finally {
    removeWorkspace(stageWorkspace);
  }

  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, BRANCH_CONFIG, { implement: BRANCH_WORKFLOW });
    installScript(workspace, [
      implementStep(COMPLETE),
      stageStep("review", APPROVED),
      stageStep("test", COMPLETE),
      stageStep("docs", COMPLETE),
      stageStep("review-test", APPROVED),
      stageStep("review-docs", APPROVED),
    ]);
    const [started, startedObjects, startedStderr] = await runMain(workspace, [
      "session",
      "run",
      "--workflow",
      "implement",
      "--task",
      "Ship the change",
      "--max-dispatches",
      "2",
    ]);
    expect(started, startedStderr).toBe(5);
    const sessionId = String(startedObjects[0]?.session_id);
    const [continued, continuedObjects, continuedStderr] = await runMain(workspace, ["session", "continue", sessionId]);
    expect(continued, continuedStderr).toBe(0);
    expect(continuedStderr).not.toContain("ambiguous");
    expect(continuedObjects[0]?.stop_reason).toBe("completed");
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);
