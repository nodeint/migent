import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { BuildCommandInput } from "../src/provider-contract.ts";
import { AgentToolRunner, SessionLock, SessionStore, StageOutcome, createWorkflowSession, executeNamedWorkflow, raiseCancellation } from "../src/index.ts";
import { clearInFlightExecution, noteInFlightExecution } from "../src/session-store.ts";
import type { CommandSpec } from "../src/command-executor.ts";
import { ScriptedProvider, tempDir } from "./support.ts";

const CONFIG = `\
models:
  fake:
    provider: fake
    model: m1
roles:
  developer:
    default_model: fake
`;

const OK = "status: complete\n\ndone";

function setup(workflow: string): { workspace: string; sessionId: string } {
  const workspace = tempDir("migent-cancel-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), CONFIG, "utf8");
  writeFileSync(path.join(workspace, ".migent", "workflows", "wf.yaml"), workflow, "utf8");
  return { workspace, sessionId: createWorkflowSession(workspace, "wf", "Finish the notes") };
}

function executionIds(workspace: string, sessionId: string): string[] {
  return readdirSync(path.join(workspace, ".migent", "sessions", sessionId, "executions"));
}

class HangFirstProvider extends ScriptedProvider {
  private hung = false;

  constructor(
    private readonly pidFile: string,
    responses: string[],
    artifacts?: Array<string | null>,
  ) {
    super(responses, artifacts);
  }

  override buildCommand(input: BuildCommandInput): CommandSpec {
    if (!this.hung) {
      this.hung = true;
      this.calls.push({
        model: input.model,
        workspace: input.workspace,
        prompt: input.prompt,
        agentId: input.agentId,
        newAgentId: input.newAgentId,
        promptFile: input.promptFile,
        options: { ...input.options },
      });
      const code = `require("fs").writeFileSync(${JSON.stringify(this.pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
      return { argv: [process.execPath, "-e", code] };
    }
    return super.buildCommand(input);
  }
}

test("continue resends a cancelled provider turn on the same execution", async () => {
  const root = tempDir("migent-cancel-turn-");
  const pidFile = path.join(root, "pid");
  const { workspace, sessionId } = setup(`\
id: wf
stages:
  - id: implement
    role: developer
completion:
  stage: implement
`);
  const provider = new HangFirstProvider(pidFile, [OK]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const timer = setInterval(() => {
    if (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "") return;
    clearInterval(timer);
    try {
      raiseCancellation(15);
    } catch {
      // The waiters were woken; the throw is for signal handlers.
    }
  }, 50);
  const first = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, runner);
  clearInterval(timer);
  expect(first.stopReason).toBe("cancelled");
  expect(first.status).toBe("cancelled");
  expect(provider.calls).toHaveLength(1);
  const executionId = executionIds(workspace, sessionId)[0];
  expect(executionId).toBeTruthy();

  const second = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, resetRevisions: true },
    runner,
  );
  expect(second.code).toBe(0);
  expect(second.stopReason).toBe("completed");
  expect(second.latestExecutionId).toBe(executionId);
  expect(executionIds(workspace, sessionId)).toEqual([executionId]);
  expect(provider.calls).toHaveLength(2);
  expect(provider.calls[1]?.prompt).toContain(provider.calls[0]?.prompt ?? "missing");
  const conversation = JSON.parse(
    readFileSync(
      path.join(workspace, ".migent", "sessions", sessionId, "executions", executionId!, "conversation.json"),
      "utf8",
    ),
  ) as { history: Array<{ role: string }> };
  expect(conversation.history.map((item) => item.role)).toEqual(["user", "assistant"]);
}, 30_000);

test("continue reruns a cancelled verify without a new provider turn", async () => {
  const root = tempDir("migent-cancel-verify-");
  const marker = path.join(root, "go");
  const pidFile = path.join(root, "pid");
  const script = path.join(root, "hold.cjs");
  writeFileSync(
    script,
    `const fs=require("fs");
if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0);
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => { if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0); }, 50);`,
    "utf8",
  );
  const command = `"${process.execPath}" "${script}"`;
  const { workspace, sessionId } = setup(`\
id: wf
stages:
  - id: implement
    role: developer
    produces:
      artifact: notes.md
    verify:
      - ${JSON.stringify(command)}
completion:
  stage: implement
`);
  const provider = new ScriptedProvider([OK], ["# notes\n"]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const timer = setInterval(() => {
    if (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "") return;
    clearInterval(timer);
    try {
      raiseCancellation(15);
    } catch {
      // The waiters were woken; the throw is for signal handlers.
    }
  }, 50);
  const first = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, runner);
  clearInterval(timer);
  expect(first.stopReason).toBe("cancelled");
  expect(provider.calls).toHaveLength(1);
  const executionId = executionIds(workspace, sessionId)[0];
  writeFileSync(marker, "1", "utf8");

  const second = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, resetRevisions: true },
    runner,
  );
  expect(second.code).toBe(0);
  expect(second.stopReason).toBe("completed");
  expect(second.latestExecutionId).toBe(executionId);
  expect(executionIds(workspace, sessionId)).toEqual([executionId]);
  expect(provider.calls).toHaveLength(1);
  expect(new SessionStore(workspace).readSessionStatus(sessionId).status).toBe("completed");
}, 30_000);

test("continue reopens every cancelled execution", () => {
  const { workspace, sessionId } = setup(`\
id: wf
stages:
  - id: implement
    role: developer
  - id: review
    role: developer
completion:
  stage: review
`);
  const store = new SessionStore(workspace);
  const lock = SessionLock.acquire(path.join(workspace, ".migent", "sessions", sessionId));
  let noted: string | null = null;
  try {
    const [implementRecord, , implement] = store.loadOrCreate(
      "fake",
      "m1",
      {},
      workspace,
      sessionId,
      "implement",
      null,
      null,
      "go",
    );
    noted = implement.executionId;
    noteInFlightExecution(sessionId, implement.executionId);
    const [reviewRecord, , review] = store.loadOrCreate(
      "fake",
      "m1",
      {},
      workspace,
      sessionId,
      "review",
      null,
      null,
      "review",
    );
    clearInFlightExecution(sessionId, implement.executionId);
    noted = null;
    store.save(implementRecord, implement);
    store.save(reviewRecord, review);
    store.saveExecution(implement, implementRecord, "cancelled");
    store.saveExecution(review, reviewRecord, "cancelled");
    expect(store.readSessionStatus(sessionId).status).toBe("cancelled");
    const reopened = store.reopenCancelledExecutions(sessionId);
    expect(reopened.map((item) => item.executionId)).toEqual([implement.executionId, review.executionId]);
    expect(execution(workspace, sessionId, implement.executionId).status).toBe("running");
    expect(execution(workspace, sessionId, review.executionId).status).toBe("running");
    expect(store.readSessionStatus(sessionId).status).toBe("active");
  } finally {
    if (noted) clearInFlightExecution(sessionId, noted);
    lock.release();
  }
});

test("continue reopens a cancelled stage while a blocked stage stays resumed", async () => {
  const { workspace, sessionId } = setup(`\
id: wf
stages:
  - id: implement
    role: developer
  - id: review
    role: developer
completion:
  stage: review
`);
  const store = new SessionStore(workspace);
  const lock = SessionLock.acquire(path.join(workspace, ".migent", "sessions", sessionId));
  let noted: string | null = null;
  let reviewId = "";
  try {
    const [implementRecord, , implement] = store.loadOrCreate(
      "fake",
      "m1",
      {},
      workspace,
      sessionId,
      "implement",
      null,
      null,
      "go",
    );
    noted = implement.executionId;
    noteInFlightExecution(sessionId, implement.executionId);
    const [reviewRecord, , review] = store.loadOrCreate(
      "fake",
      "m1",
      {},
      workspace,
      sessionId,
      "review",
      null,
      null,
      "review",
    );
    clearInFlightExecution(sessionId, implement.executionId);
    noted = null;
    reviewId = review.executionId;
    reviewRecord.history.push({ role: "user", content: "review" });
    store.save(implementRecord, implement);
    store.save(reviewRecord, review);
    store.saveExecution(implement, implementRecord, "completed", null, new StageOutcome("blocked", "implement gate"));
    store.saveExecution(review, reviewRecord, "cancelled");
    expect(store.readSessionStatus(sessionId).status).toBe("blocked");
  } finally {
    if (noted) clearInFlightExecution(sessionId, noted);
    lock.release();
  }
  const provider = new ScriptedProvider([OK, OK]);
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId },
    new AgentToolRunner({ fake: provider }, 10),
  );
  expect(result.stopReason).toBe("completed");
  expect(result.code).toBe(0);
  expect(execution(workspace, sessionId, reviewId).status).toBe("completed");
  const ids = executionIds(workspace, sessionId);
  expect(ids).toContain(reviewId);
  expect(ids.filter((id) => id.includes("implement"))).toHaveLength(2);
  expect(result.stages.map((stage) => stage.execution_id)).toContain(reviewId);
}, 30_000);

class HangManyProvider extends ScriptedProvider {
  private hung = 0;

  constructor(
    private readonly pidFiles: string[],
    responses: string[],
  ) {
    super(responses);
  }

  override buildCommand(input: BuildCommandInput): CommandSpec {
    if (this.hung < this.pidFiles.length) {
      const pidFile = this.pidFiles[this.hung]!;
      this.hung += 1;
      this.calls.push({
        model: input.model,
        workspace: input.workspace,
        prompt: input.prompt,
        agentId: input.agentId,
        newAgentId: input.newAgentId,
        promptFile: input.promptFile,
        options: { ...input.options },
      });
      const code = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
      return { argv: [process.execPath, "-e", code] };
    }
    return super.buildCommand(input);
  }
}

test("one SIGINT cancels two runners before the lock is released and continue resumes both", async () => {
  const root = tempDir("migent-cancel-two-");
  const pidA = path.join(root, "a");
  const pidB = path.join(root, "b");
  const { workspace, sessionId } = setup(`\
schema_version: 2
id: wf
concurrency: 2
stages:
  - id: a
    role: developer
    depends_on: []
  - id: b
    role: developer
    depends_on: []
`);
  const provider = new HangManyProvider([pidA, pidB], [OK, OK]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  let signaled = false;
  const timer = setInterval(() => {
    if (signaled || !existsSync(pidA) || !existsSync(pidB)) return;
    if (readFileSync(pidA, "utf8").trim() === "" || readFileSync(pidB, "utf8").trim() === "") return;
    signaled = true;
    clearInterval(timer);
    // Windows terminates the process on process.kill(pid, "SIGINT") instead of emitting the signal.
    if (process.platform === "win32") process.emit("SIGINT");
    else process.kill(process.pid, "SIGINT");
  }, 20);
  const original = SessionLock.prototype.release;
  let releasedAfterCancel = false;
  SessionLock.prototype.release = function release(this: SessionLock) {
    const records = executionIds(workspace, sessionId).map((id) => execution(workspace, sessionId, id));
    releasedAfterCancel = records.length === 2 && records.every((record) => record.status === "cancelled");
    return original.call(this);
  };
  try {
    const first = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, runner);
    expect(signaled).toBe(true);
    expect(releasedAfterCancel).toBe(true);
    expect(first.stopReason).toBe("cancelled");
    expect(first.status).toBe("cancelled");
    const ids = executionIds(workspace, sessionId);
    expect(ids).toHaveLength(2);

    const second = await executeNamedWorkflow(
      workspace,
      { workflowId: "wf", sessionId, resetRevisions: true },
      runner,
    );
    expect(second.code).toBe(0);
    expect(second.stopReason).toBe("completed");
    expect(executionIds(workspace, sessionId).sort()).toEqual([...ids].sort());
    for (const id of ids) expect(execution(workspace, sessionId, id).status).toBe("completed");
  } finally {
    clearInterval(timer);
    SessionLock.prototype.release = original;
  }
}, 30_000);

function execution(workspace: string, sessionId: string, executionId: string): Record<string, unknown> {
  const file = path.join(workspace, ".migent", "sessions", sessionId, "executions", executionId, "execution.json");
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}
