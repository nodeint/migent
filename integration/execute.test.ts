import { readFileSync } from "node:fs";
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
    const published = path.join(workspace, ".migent", "sessions", String(result.session_id), "outputs", "plan");
    expect(readFileSync(published, "utf8").trim().length).toBeGreaterThan(0);
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("stage runs through the codex adapter", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, CODEX_CONFIG, { "draft-note": DRAFT_NOTE });
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
      ["session", "run", "--workflow", "solo", "--task", "Write", "--attempts", "1"],
      "invalid",
    );
    expect(code, stderr).toBe(3);
    expect(objects[0]?.stop_reason).toBe("retry_exhausted");
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
    const published = path.join(workspace, ".migent", "sessions", String(result.session_id), "outputs", "plan");
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

test("a bad response is retried and the workflow completes", async () => {
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
      "--attempts",
      "2",
    ]);
    expect(code, stderr).toBe(0);
    const result = objects[0] ?? {};
    expect(result.stop_reason).toBe("completed");
    const records = executionRecords(workspace, String(result.session_id));
    expect(records.map((record) => record.status)).toEqual(["failed", "completed", "completed"]);
    expect(records[0]?.stage_id).toBe("plan");
    expect(records[1]?.stage_id).toBe("plan");
    expect(providerInvocations(workspace)).toHaveLength(3);
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("provider exit exhausts the attempt", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, { solo: SOLO });
    installScript(workspace, [{ exit: 1 }]);
    const [code, objects, stderr] = await runMain(workspace, ["session", "run", "--workflow", "solo", "--task", "Write", "--attempts", "1"]);
    expect(code, stderr).toBe(3);
    expect(objects[0]?.stop_reason).toBe("retry_exhausted");
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
    const [code, objects, stderr] = await runMain(workspace, ["session", "run", "--workflow", "solo", "--task", "Write", "--attempts", "1"]);
    expect(code, stderr).toBe(3);
    expect(objects[0]?.stop_reason).toBe("retry_exhausted");
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
    const [code, objects, stderr] = await runMain(workspace, ["session", "run", "--workflow", "solo", "--task", "Write", "--attempts", "1"]);
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
    const published = path.join(workspace, ".migent", "sessions", String(started.session_id), "outputs", "plan");
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
    expect(readFileSync(path.join(sessionDir, "outputs", "draft"), "utf8")).toBe("# draft\n");
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
