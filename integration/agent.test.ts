import { expect, test } from "vitest";
import {
  CODEX_CONFIG,
  CODEX_THREAD,
  COMPLETE,
  GROK_CONFIG,
  GROK_SESSION,
  executionRecords,
  hasArgs,
  installScript,
  invocationArgv,
  providerInvocations,
  removeWorkspace,
  runMain,
  sessionStatus,
  tempWorkspace,
  writeWorkspace,
} from "./support.ts";

const testPosix = process.platform === "win32" ? test.skip : test;

testPosix("agent writes a session record", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, {});
    const [code, objects, stderr] = await runMain(workspace, [
      "agent",
      "start",
      "--role",
      "planner",
      "--task",
      "Think",
      "--prompt",
      "hello",
      "--json",
    ]);
    expect(code, stderr).toBe(0);
    expect(objects).toHaveLength(1);
    const result = objects[0] ?? {};
    expect(result.outcome_status).toBe("complete");
    expect(result.agent_id).toBe(GROK_SESSION);
    const status = sessionStatus(workspace, String(result.session_id));
    expect(status.workflow_id).toBe("agent");
    expect(status.status).toBe("completed");
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

testPosix("continue resumes the grok agent", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, {});
    installScript(workspace, [{ text: COMPLETE }, { text: COMPLETE }]);
    const [code, objects, stderr] = await runMain(workspace, [
      "agent",
      "start",
      "--role",
      "planner",
      "--task",
      "Think",
      "--prompt",
      "hello",
      "--json",
    ]);
    expect(code, stderr).toBe(0);
    const sessionId = String(objects[0]?.session_id);
    const [continuedCode, continued, continuedStderr] = await runMain(workspace, [
      "agent",
      "continue",
      sessionId,
      "--role",
      "planner",
      "--prompt",
      "again",
      "--json",
    ]);
    expect(continuedCode, continuedStderr).toBe(0);
    expect(continued[0]?.session_id).toBe(sessionId);
    expect(continued[0]?.agent_id).toBe(GROK_SESSION);
    expect(continued[0]?.outcome_status).toBe("complete");
    const [first, second] = invocationArgv(workspace);
    expect(hasArgs(first ?? [], "-m", "grok-test")).toBe(true);
    expect(hasArgs(first ?? [], "--reasoning-effort", "low")).toBe(true);
    expect(first ?? []).not.toContain("--resume");
    expect(hasArgs(second ?? [], "--resume", GROK_SESSION)).toBe(true);
    const records = executionRecords(workspace, sessionId);
    expect(records).toHaveLength(2);
    expect(records[1]?.resumes_execution_id).toBe(records[0]?.execution_id);
    expect(records[1]?.status).toBe("completed");
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

testPosix("continue resumes the codex thread", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, CODEX_CONFIG, {});
    installScript(workspace, [{ text: COMPLETE }, { text: COMPLETE }]);
    const [code, objects, stderr] = await runMain(workspace, [
      "agent",
      "start",
      "--role",
      "writer",
      "--prompt",
      "hello",
      "--json",
    ]);
    expect(code, stderr).toBe(0);
    const sessionId = String(objects[0]?.session_id);
    const [continuedCode, continued, continuedStderr] = await runMain(workspace, [
      "agent",
      "continue",
      sessionId,
      "--role",
      "writer",
      "--prompt",
      "again",
      "--json",
    ]);
    expect(continuedCode, continuedStderr).toBe(0);
    expect(continued[0]?.agent_id).toBe(CODEX_THREAD);
    const [first, second] = invocationArgv(workspace);
    expect(first ?? []).toContain("--approve-for-me");
    expect(first ?? []).not.toContain("resume");
    expect(hasArgs(second ?? [], "resume", CODEX_THREAD, "-")).toBe(true);
    expect(second ?? []).not.toContain("--approve-for-me");
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

testPosix("a different option does not resume", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, {});
    installScript(workspace, [{ text: COMPLETE }, { text: COMPLETE }]);
    const [code, objects, stderr] = await runMain(workspace, [
      "agent",
      "start",
      "--role",
      "planner",
      "--prompt",
      "hello",
      "--json",
    ]);
    expect(code, stderr).toBe(0);
    const [continuedCode, , continuedStderr] = await runMain(workspace, [
      "agent",
      "continue",
      String(objects[0]?.session_id),
      "--role",
      "planner",
      "--option",
      "reasoning-effort=high",
      "--prompt",
      "again",
      "--json",
    ]);
    expect(continuedCode, continuedStderr).toBe(2);
    expect(continuedStderr).toContain("options");
    expect(providerInvocations(workspace)).toHaveLength(1);
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);
