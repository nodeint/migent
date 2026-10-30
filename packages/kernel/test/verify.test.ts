import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  AgentToolRunner,
  ConfigurationError,
  SessionLock,
  SessionStore,
  StageOutcome,
  VerifyRunner,
  createWorkflowSession,
  executeNamedWorkflow,
  raiseCancellation,
  resetCancellation,
  loadWorkflowDocument,
  buildStagePrompt,
} from "../src/index.ts";
import { clearInFlightExecution, clearInFlightExecutions, noteInFlightExecution } from "../src/session-store.ts";
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

// Fails while the counter file holds fewer than `failures` runs, then passes.
function counterScript(workspace: string, name: string, failures: number): string {
  const script = path.join(workspace, `${name}.cjs`);
  writeFileSync(
    script,
    `const fs=require("fs");const f=${JSON.stringify(path.join(workspace, `${name}.count`))};
const n=fs.existsSync(f)?Number(fs.readFileSync(f,"utf8")):0;fs.writeFileSync(f,String(n+1));
console.log("run "+(n+1));if(n<${failures}){console.error("boom "+(n+1));process.exit(1);}`,
    "utf8",
  );
  return `"${process.execPath}" "${script}"`;
}

function workflowText(verify: string | string[], extra = ""): string {
  verify = Array.isArray(verify) ? verify : [verify];
  return `\
id: wf
stages:
  - id: implement
    role: developer
    produces:
      artifact: notes.md
    verify:
${verify.map((item) => `      - ${JSON.stringify(item)}\n`).join("")}${extra}  - id: review
    role: developer
    depends_on: [implement]
completion:
  stage: review
`;
}

function setup(workflow: string): { workspace: string; sessionId: string } {
  const workspace = tempDir("migent-verify-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), CONFIG, "utf8");
  writeFileSync(path.join(workspace, ".migent", "workflows", "wf.yaml"), workflow, "utf8");
  return { workspace, sessionId: createWorkflowSession(workspace, "wf", "task") };
}

function runStage(runner: AgentToolRunner, workspace: string, sessionId: string, extra = {}) {
  return runner.run({
    provider: "fake",
    model: "m1",
    prompt: "go",
    workspace,
    sessionId,
    stageId: "implement",
    ...extra,
  });
}

function execution(workspace: string, sessionId: string, executionId: string): Record<string, unknown> {
  const file = path.join(workspace, ".migent", "sessions", sessionId, "executions", executionId, "execution.json");
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

const OK = "status: complete\n\ndone";

test("passing verify completes one execution and writes verify.md", async () => {
  const { workspace, sessionId } = setup(workflowText(`node -e "process.exit(0)"`));
  const runner = new AgentToolRunner({ fake: new ScriptedProvider([OK], ["# notes\n"]) }, 10);
  const result = await runStage(runner, workspace, sessionId);
  const record = execution(workspace, sessionId, result.execution_id);
  expect(record.status).toBe("completed");
  expect(record.turns).toBe(1);
  expect(readFileSync(path.join(result.artifact_directory, "verify.md"), "utf8")).toContain("verify: pass");
  expect(result.failure_reason).toBe("");
});

test("red verify repairs in the same execution", async () => {
  const workspace0 = tempDir("migent-verify-c-");
  const command = counterScript(workspace0, "c", 1);
  const { workspace, sessionId } = setup(workflowText(command));
  const provider = new ScriptedProvider([OK, OK], ["# notes\n", null]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const result = await runStage(runner, workspace, sessionId);
  const record = execution(workspace, sessionId, result.execution_id);
  expect(record.status).toBe("completed");
  expect(record.turns).toBe(2);
  expect((record.verify as Record<string, unknown>).red).toBe(1);
  expect(provider.calls).toHaveLength(2);
  expect(provider.calls[1]?.newAgentId).toBeNull();
  expect(provider.calls[1]?.prompt).toContain("Verify failed (1 of 3 red runs)");
  expect(provider.calls[1]?.prompt).toContain("boom 1");
  expect(existsSync(path.join(result.artifact_directory, "verify.md"))).toBe(true);
  const events = readFileSync(
    path.join(workspace, ".migent", "sessions", sessionId, "events.jsonl"),
    "utf8",
  );
  expect(events.match(/"event":"execution.running"/g)).toHaveLength(1);
  expect(events).toContain("verify.failed");
  expect(events).toContain("verify.passed");
});

test("blocked runs no verify command", async () => {
  const { workspace, sessionId } = setup(workflowText(`touch ran.flag`));
  const runner = new AgentToolRunner(
    { fake: new ScriptedProvider(["status: blocked\nblocker: nope"]) },
    10,
  );
  const result = await runStage(runner, workspace, sessionId);
  expect(existsSync(path.join(workspace, "ran.flag"))).toBe(false);
  expect(result.session_status).toBe("blocked");
});

const BLOCKED = "status: blocked\nblocker: gate clones\n\nstopped";

// Three provider turns plus verification spawn real wrapper processes. Parallel Windows
// CI can exceed the default 10 seconds even when every subprocess exits normally.
test("continue redispatches a blocked stage and names the blocker", async () => {
  const { workspace, sessionId } = setup(workflowText(`node -e "process.exit(0)"`));
  const provider = new ScriptedProvider([BLOCKED, OK, OK], [null, "# notes\n", null]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, runner);
  expect(first.stopReason).toBe("blocked");
  expect(first.code).toBe(1);
  expect(new SessionStore(workspace).executionSnapshots(sessionId)).toHaveLength(1);

  const second = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, resetRevisions: true },
    runner,
  );
  expect(second.code).toBe(0);
  expect(second.status).toBe("completed");
  const snapshots = new SessionStore(workspace).executionSnapshots(sessionId);
  expect(snapshots.map((item) => item.stageId)).toEqual(["implement", "implement", "review"]);
  expect(snapshots[1]?.outcomeStatus).toBe("complete");
  expect(second.latestExecutionId).not.toBe(first.latestExecutionId);
  expect(provider.calls[1]?.agentId).toBe("native-session-1");
  expect(execution(workspace, sessionId, snapshots[1]!.executionId).resumes_execution_id).toBe(
    snapshots[0]?.executionId,
  );
  expect(provider.calls[1]?.prompt).toContain("gate clones");
  expect(provider.calls[1]?.prompt).toContain("handled outside this session");
  const events = readFileSync(path.join(workspace, ".migent", "sessions", sessionId, "events.jsonl"), "utf8");
  expect(events).toContain('"event":"session.active"');
  expect(events).toContain('"from":"blocked"');
  const status = new SessionStore(workspace).readSessionStatus(sessionId);
  expect(status.blocker).toBeUndefined();
  expect(status.blocked_by_execution_id).toBeUndefined();
}, 30_000);

test("continue with a reply sends only that reply to the blocked stage", async () => {
  const { workspace, sessionId } = setup(workflowText(`node -e "process.exit(0)"`));
  const provider = new ScriptedProvider([BLOCKED, OK, OK], [null, "# notes\n", null]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, runner);
  expect(first.stopReason).toBe("blocked");

  const reply = "use docs/api.yaml";
  const second = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, resetRevisions: true, reply },
    runner,
  );
  expect(second.code).toBe(0);
  expect(second.status).toBe("completed");
  const snapshots = new SessionStore(workspace).executionSnapshots(sessionId);
  expect(snapshots.map((item) => item.stageId)).toEqual(["implement", "implement", "review"]);
  const resumed = snapshots[1]!;
  expect(execution(workspace, sessionId, resumed.executionId).resumes_execution_id).toBe(snapshots[0]?.executionId);
  const sent = provider.calls[1]?.prompt ?? "";
  expect(sent.startsWith(`Reply:\n${reply}\n`)).toBe(true);
  expect(sent).toContain("Workflow stage response contract:");
  expect(sent).toContain("Migent artifact directory:");
  expect(sent).not.toContain("gate clones");
  expect(sent).not.toContain("handled outside this session");
  expect(sent).not.toContain("Previous attempt of this stage:");
  expect(provider.calls[1]?.agentId).toBe("native-session-1");
  expect(provider.calls[2]?.prompt ?? "").not.toContain(reply);
});

test("reply is rejected unless the session is blocked", async () => {
  const { workspace, sessionId } = setup(workflowText(`node -e "process.exit(0)"`));
  await expect(
    executeNamedWorkflow(workspace, { workflowId: "wf", sessionId, reply: "   " }, new AgentToolRunner({ fake: new ScriptedProvider([]) }, 10)),
  ).rejects.toThrow(ConfigurationError);
  await expect(
    executeNamedWorkflow(workspace, { workflowId: "wf", sessionId, reply: "   " }, new AgentToolRunner({ fake: new ScriptedProvider([]) }, 10)),
  ).rejects.toThrow(/--reply is empty/);
  expect(new SessionStore(workspace).executionSnapshots(sessionId)).toHaveLength(0);
  expect(new SessionStore(workspace).readSessionStatus(sessionId).status).toBe("active");
});

test("reply to one of two blocked stages leaves the other blocked", async () => {
  const workflow = `\
schema_version: 2
concurrency: 2
id: wf
stages:
  - id: a
    role: developer
  - id: b
    role: developer
`;
  const { workspace, sessionId } = setup(workflow);
  const provider = new ScriptedProvider([BLOCKED, BLOCKED, OK]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, runner);
  expect(first.stopReason).toBe("blocked");
  const store = new SessionStore(workspace);
  expect(store.blockedStages(sessionId).map((item) => item.stageId)).toEqual(["a", "b"]);

  await expect(
    executeNamedWorkflow(workspace, { workflowId: "wf", sessionId, reply: "answer a" }, runner),
  ).rejects.toThrow(/--reply needs --stage when more than one stage is waiting: a, b/);
  expect(store.readSessionStatus(sessionId).status).toBe("blocked");
  expect(store.executionSnapshots(sessionId)).toHaveLength(2);

  await expect(
    executeNamedWorkflow(workspace, { workflowId: "wf", sessionId, stageId: "missing", reply: "answer" }, runner),
  ).rejects.toThrow(/Stage missing is not waiting for a reply/);
  expect(store.readSessionStatus(sessionId).status).toBe("blocked");

  const second = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, stageId: "b", reply: "answer b" },
    runner,
  );
  expect(second.stopReason).toBe("blocked");
  expect(second.code).toBe(1);
  const snapshots = store.executionSnapshots(sessionId);
  expect(snapshots.filter((item) => item.stageId === "a")).toHaveLength(1);
  const bRuns = snapshots.filter((item) => item.stageId === "b");
  expect(bRuns).toHaveLength(2);
  expect(bRuns[1]?.outcomeStatus).toBe("complete");
  expect(execution(workspace, sessionId, bRuns[1]!.executionId).resumes_execution_id).toBe(bRuns[0]?.executionId);
  const sent = provider.calls.find((call) => call.prompt.startsWith("Reply:\n"));
  expect(sent?.prompt.startsWith("Reply:\nanswer b\n")).toBe(true);
  expect(sent?.prompt).toContain("Workflow stage response contract:");
  expect(sent?.prompt).not.toContain("gate clones");
  expect(sent?.agentId).toBe("native-session-1");
  expect(store.readSessionStatus(sessionId).status).toBe("blocked");
  expect(store.blockedStages(sessionId).map((item) => item.stageId)).toEqual(["a"]);
  const events = readFileSync(path.join(workspace, ".migent", "sessions", sessionId, "events.jsonl"), "utf8");
  const resumes = events.split("\n").filter((line) => line.includes('"from":"blocked"'));
  expect(resumes).toHaveLength(1);
  expect(resumes[0]).toContain(bRuns[0]?.executionId);
});

test("a reply is sent before a cancelled sibling is reopened", async () => {
  const { workspace, sessionId } = setup(`\
id: wf
stages:
  - id: implement
    role: developer
  - id: review
    role: developer
    depends_on: [implement]
    max_verify: 1
    verify:
      - node -e "process.exit(1)"
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
    reviewRecord.history.push({ role: "assistant", content: "status: complete\n\ndone" });
    implementRecord.agentId = "native-session-1";
    store.save(implementRecord, implement);
    store.save(reviewRecord, review);
    store.saveExecution(implement, implementRecord, "completed", null, new StageOutcome("blocked", "implement gate"));
    store.saveExecution(review, reviewRecord, "cancelled");
    expect(store.readSessionStatus(sessionId).status).toBe("blocked");
  } finally {
    if (noted) clearInFlightExecution(sessionId, noted);
    lock.release();
  }
  const provider = new ScriptedProvider([OK]);
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, reply: "use the schema" },
    new AgentToolRunner({ fake: provider }, 10),
  );
  expect(result.stopReason).toBe("verify_exhausted");
  expect(result.code).toBe(6);
  const sent = provider.calls.find((call) => call.prompt.startsWith("Reply:\n"));
  expect(sent?.prompt.startsWith("Reply:\nuse the schema\n")).toBe(true);
  expect(sent?.prompt).not.toContain("implement gate");
  expect(execution(workspace, sessionId, reviewId).status).toBe("failed");
  const implementRuns = new SessionStore(workspace)
    .executionSnapshots(sessionId)
    .filter((item) => item.stageId === "implement");
  expect(implementRuns).toHaveLength(2);
  expect(implementRuns[1]?.outcomeStatus).toBe("complete");
});

test("a reply is sent while another blocked stage and a cancelled sibling remain", async () => {
  const { workspace, sessionId } = setup(`\
schema_version: 2
concurrency: 2
id: wf
stages:
  - id: a
    role: developer
  - id: b
    role: developer
  - id: c
    role: developer
`);
  const store = new SessionStore(workspace);
  const lock = SessionLock.acquire(path.join(workspace, ".migent", "sessions", sessionId));
  const noted: string[] = [];
  let cancelledId = "";
  try {
    const created = ["a", "b", "c"].map((stageId) => {
      const [record, , context] = store.loadOrCreate(
        "fake",
        "m1",
        {},
        workspace,
        sessionId,
        stageId,
        null,
        null,
        stageId,
      );
      noted.push(context.executionId);
      noteInFlightExecution(sessionId, context.executionId);
      return { stageId, record, context };
    });
    for (const id of noted) clearInFlightExecution(sessionId, id);
    noted.length = 0;
    const cancelled = created[2]!;
    cancelledId = cancelled.context.executionId;
    cancelled.record.agentId = "native-session-1";
    cancelled.record.history.push({ role: "user", content: "c" });
    created[1]!.record.agentId = "native-session-1";
    store.save(created[1]!.record, created[1]!.context);
    store.save(cancelled.record, cancelled.context);
    store.saveExecution(created[0]!.context, created[0]!.record, "completed", null, new StageOutcome("blocked", "a gate"));
    store.saveExecution(created[1]!.context, created[1]!.record, "completed", null, new StageOutcome("blocked", "b gate"));
    store.saveExecution(cancelled.context, cancelled.record, "cancelled");
    expect(store.readSessionStatus(sessionId).status).toBe("blocked");
  } finally {
    for (const id of noted) clearInFlightExecution(sessionId, id);
    lock.release();
  }
  const provider = new ScriptedProvider([OK, OK]);
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, stageId: "b", reply: "answer b" },
    new AgentToolRunner({ fake: provider }, 10),
  );
  expect(result.stopReason).toBe("blocked");
  const sent = provider.calls.find((call) => call.prompt.startsWith("Reply:\n"));
  expect(sent?.prompt.startsWith("Reply:\nanswer b\n")).toBe(true);
  expect(sent?.prompt).not.toContain("b gate");
  const snapshots = store.executionSnapshots(sessionId);
  expect(snapshots.filter((item) => item.stageId === "a")).toHaveLength(1);
  expect(snapshots.filter((item) => item.stageId === "b")).toHaveLength(2);
  expect(execution(workspace, sessionId, cancelledId).status).toBe("completed");
  expect(store.blockedStages(sessionId).map((item) => item.stageId)).toEqual(["a"]);
});

test("a reply that exhausts verify stops instead of repairing", async () => {
  const workflow = `\
schema_version: 2
id: wf
stages:
  - id: implement
    role: developer
    max_verify: 1
    verify:
      - node -e "process.exit(1)"
`;
  const { workspace, sessionId } = setup(workflow);
  const provider = new ScriptedProvider([BLOCKED, OK]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, runner);
  expect(first.stopReason).toBe("blocked");
  const second = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, reply: "ship it" },
    runner,
  );
  expect(second.stopReason).toBe("verify_exhausted");
  expect(second.code).toBe(6);
  expect(provider.calls).toHaveLength(2);
  expect(provider.calls[1]?.prompt.startsWith("Reply:\nship it\n")).toBe(true);
  expect(new SessionStore(workspace).executionSnapshots(sessionId)).toHaveLength(2);
});

test("a reply counts toward the dispatch ceiling", async () => {
  const { workspace, sessionId } = setup(workflowText(`node -e "process.exit(0)"`));
  const provider = new ScriptedProvider([BLOCKED, OK, OK], [null, "# notes\n", null]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, runner);
  expect(first.stopReason).toBe("blocked");
  const second = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, maxDispatches: 1, reply: "use docs/api.yaml" },
    runner,
  );
  expect(second.stopReason).toBe("dispatch_limit");
  expect(second.code).toBe(5);
  const snapshots = new SessionStore(workspace).executionSnapshots(sessionId);
  expect(snapshots.map((item) => item.stageId)).toEqual(["implement", "implement"]);
  expect(provider.calls[1]?.prompt.startsWith("Reply:\nuse docs/api.yaml\n")).toBe(true);
});

test("continue once redispatches only the blocked stage", async () => {
  const { workspace, sessionId } = setup(workflowText(`node -e "process.exit(0)"`));
  const provider = new ScriptedProvider([BLOCKED, OK], [null, "# notes\n"]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, runner);
  expect(first.stopReason).toBe("blocked");

  const second = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId, once: true }, runner);
  expect(second.code).toBe(0);
  expect(second.status).toBe("active");
  expect(second.stopReason).toBe("stage");
  const snapshots = new SessionStore(workspace).executionSnapshots(sessionId);
  expect(snapshots).toHaveLength(2);
  expect(snapshots[1]?.stageId).toBe("implement");
  expect(snapshots[1]?.outcomeStatus).toBe("complete");
  expect(provider.calls[1]?.prompt).toContain("gate clones");
});

test("a blocked retry stops again without dispatching the next stage", async () => {
  const { workspace, sessionId } = setup(workflowText(`node -e "process.exit(0)"`));
  const provider = new ScriptedProvider([BLOCKED, BLOCKED], [null, null]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, runner);
  const second = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, resetRevisions: true },
    runner,
  );
  expect(second.stopReason).toBe("blocked");
  expect(second.code).toBe(1);
  expect(second.latestExecutionId).not.toBe(first.latestExecutionId);
  const snapshots = new SessionStore(workspace).executionSnapshots(sessionId);
  expect(snapshots).toHaveLength(2);
  expect(snapshots.every((item) => item.stageId === "implement")).toBe(true);
  expect(provider.calls).toHaveLength(2);
});

test("continue redispatches a blocked schema 2 session", async () => {
  const { workspace, sessionId } = setup(workflowText(`node -e "process.exit(0)"`));
  const provider = new ScriptedProvider([BLOCKED, OK], [null, "# notes\n"]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, runner);
  expect(first.stopReason).toBe("blocked");
  const second = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId, once: true }, runner);
  expect(second.status).toBe("active");
  expect(second.latestExecutionId).not.toBe(first.latestExecutionId);
  expect(provider.calls[1]?.prompt).toContain("gate clones");
});

test("exhausted verify stops with exit 6 and continue resumes without --attempts", async () => {
  const { workspace, sessionId } = setup(workflowText(`echo bad; exit 1`, "    max_verify: 1\n"));
  const provider = new ScriptedProvider([OK, OK], ["# n\n", null]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const first = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId },
    runner,
  );
  expect(first.stopReason).toBe("verify_exhausted");
  expect(first.code).toBe(6);
  expect(first.status).toBe("active");
  expect(provider.calls).toHaveLength(1);
  const store = new SessionStore(workspace);
  const [exhausted] = store.executionSnapshots(sessionId);
  expect(exhausted?.failureReason).toBe("verify_exhausted");
  expect(execution(workspace, sessionId, exhausted!.executionId).outcome).toBeUndefined();

  const second = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, resetRevisions: true },
    runner,
  );
  expect(second.stopReason).toBe("verify_exhausted");
  expect(second.code).toBe(6);
  expect(provider.calls).toHaveLength(2);
  expect(provider.calls[1]?.agentId).toBe("native-session-1");
  expect(provider.calls[1]?.prompt).toContain("bad");
  const records = store.executionSnapshots(sessionId);
  expect(records).toHaveLength(2);
  const resumed = execution(workspace, sessionId, records[1]!.executionId);
  expect(resumed.resumes_execution_id).toBe(exhausted!.executionId);
  // The carried artifact exists although the resumed turn did not rewrite it.
  expect(existsSync(path.join(records[1]!.artifactDirectory, "notes.md"))).toBe(true);
});

test("completion decision is not published before verify passes", async () => {
  const workflow = `\
id: wf
stages:
  - id: implement
    role: developer
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: implement
    verify: exit 1
    max_verify: 1
completion:
  stage: implement
  decision: approved
`;
  const { workspace, sessionId } = setup(workflow);
  const runner = new AgentToolRunner(
    { fake: new ScriptedProvider(["status: complete\ndecision: approved\n\nok"]) },
    10,
  );
  const result = await runStage(runner, workspace, sessionId);
  expect(result.session_status).toBe("active");
  expect(result.outcome_status).toBe("");
});

test("reaper cannot fail an execution between verify commands", async () => {
  const cmd = `node -e "process.exit(0)"`;
  const { workspace, sessionId } = setup(workflowText([cmd, cmd]));
  const reaper = new SessionStore(workspace);
  let raised = "";
  const verifyRunner = new VerifyRunner(1);
  const original = verifyRunner.run.bind(verifyRunner);
  verifyRunner.run = (input) =>
    original({
      ...input,
      onEnd: () => {
        input.onEnd?.();
        try {
          reaper.reapOrphanedExecutions(sessionId, "raise");
        } catch (error) {
          raised = (error as Error).message;
        }
      },
    });
  const runner = new AgentToolRunner({ fake: new ScriptedProvider([OK], ["# n\n"]) }, 10, verifyRunner);
  const result = await runStage(runner, workspace, sessionId);
  expect(raised).toMatch(/running|unverified|still/i);
  expect(execution(workspace, sessionId, result.execution_id).status).toBe("completed");
});

test("reap skips an in-flight sibling", () => {
  const { workspace, sessionId } = setup(workflowText(`node -e "process.exit(0)"`));
  const store = new SessionStore(workspace);
  const [, , sibling] = store.loadOrCreate("fake", "m1", {}, workspace, sessionId, "implement", null, null, "go");
  try {
    expect(() => store.reapOrphanedExecutions(sessionId, "raise", new Set([sibling.executionId]))).not.toThrow();
    noteInFlightExecution(sessionId, sibling.executionId);
    expect(() => store.reapOrphanedExecutions(sessionId, "raise")).not.toThrow();
    expect(() =>
      new SessionStore(workspace).loadOrCreate("fake", "m1", {}, workspace, sessionId, "review", null, null, "next"),
    ).not.toThrow();
    clearInFlightExecution(sessionId, sibling.executionId);
    expect(() => store.reapOrphanedExecutions(sessionId, "raise")).toThrow(/running|unverified|still/i);
    expect(execution(workspace, sessionId, sibling.executionId).status).toBe("running");
  } finally {
    clearInFlightExecutions(sessionId);
  }
});

test("resume reopens every blocked stage", () => {
  const { workspace, sessionId } = setup(workflowText(`node -e "process.exit(0)"`));
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
    // Saving the first outcome blocks the session before the sibling exists.
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
    store.saveExecution(implement, implementRecord, "completed", null, new StageOutcome("blocked", "implement gate"));
    store.saveExecution(review, reviewRecord, "completed", null, new StageOutcome("blocked", "review gate"));
    const blocked = store.readSessionStatus(sessionId);
    expect(blocked.status).toBe("blocked");
    expect(blocked.blocked_by_execution_id).toBe(implement.executionId);
    expect(blocked.blocked_by_execution_ids).toEqual([implement.executionId, review.executionId]);
    const resumed = store.resumeBlockedSession(sessionId);
    expect(resumed.map((item) => item.executionId)).toEqual([implement.executionId, review.executionId]);
    const status = store.readSessionStatus(sessionId);
    expect(status.status).toBe("active");
    expect(status.blocked_by_execution_id).toBeUndefined();
    expect(status.blocked_by_execution_ids).toBeUndefined();
  } finally {
    if (noted) clearInFlightExecution(sessionId, noted);
    lock.release();
  }
});

test("VerifyRunner: first failure skips the rest, tail is bounded, heartbeat fires", async () => {
  const workspace = tempDir("migent-vr-");
  const turnDirectory = path.join(workspace, "turns", "01");
  const heartbeats: string[] = [];
  const result = await new VerifyRunner(1).run({
    commands: [
      `node -e "for(let i=0;i<500;i++)console.log('l'+i);setTimeout(()=>{},1500)" | cat`,
      `echo hi && exit 3`,
      `echo never`,
    ],
    workspace,
    executionDirectory: workspace,
    turnDirectory,
    timeoutSec: null,
    onHeartbeat: (command) => heartbeats.push(command),
  });
  expect(result.passed).toBe(false);
  expect(result.commands.map((item) => item.status)).toEqual(["pass", "fail", "skipped"]);
  expect(result.commands[1]?.exitCode).toBe(3);
  expect(heartbeats.length).toBeGreaterThan(0);
  const log = readFileSync(path.join(turnDirectory, "commands", "01.log"), "utf8").trim().split("\n");
  expect(log).toHaveLength(200);
  expect(log.at(-1)).toBe("l499");
});

test("VerifyRunner: timeout and exit 127", async () => {
  const workspace = tempDir("migent-vr-");
  const ends: number[] = [];
  const timed = await new VerifyRunner(1).run({
    commands: ["sleep 30", "echo after"],
    workspace,
    executionDirectory: workspace,
    turnDirectory: path.join(workspace, "t"),
    timeoutSec: 1,
    onEnd: () => ends.push(1),
  });
  expect(timed.commands.map((item) => item.status)).toEqual(["timed_out", "skipped"]);
  expect(ends).toHaveLength(1);
  const missing = await new VerifyRunner(1).run({
    commands: ["definitely-not-a-program-xyz"],
    workspace,
    executionDirectory: workspace,
    turnDirectory: path.join(workspace, "t2"),
    timeoutSec: null,
  });
  expect(missing.commands[0]?.status).toBe("fail");
  expect(missing.commands[0]?.exitCode).toBe(127);
  expect(missing.infraError).toBeNull();
}, 30_000);

test("workflow parsing and path check", () => {
  const dir = tempDir("migent-wfparse-");
  const load = (text: string) => {
    const file = path.join(dir, "w.yaml");
    writeFileSync(file, text, "utf8");
    return loadWorkflowDocument(file);
  };
  const base = (stage: string) =>
    `id: w\nstages:\n  - id: a\n    role: developer\n${stage}  - id: b\n    role: developer\n    depends_on: [a]\ncompletion:\n  stage: b\n`;
  const doc = load(base("    verify: pnpm gate\n"));
  expect(doc.stages.a?.verify).toEqual(["pnpm gate"]);
  expect(doc.stages.a?.maxVerify).toBe(3);
  expect(doc.stages.b?.verify).toEqual([]);
  expect(() => load(base("    verify: []\n"))).toThrow(/must not be empty/);
  expect(() => load(base('    verify: "a\\nb"\n'))).toThrow(/one shell line/);
  expect(() => load(base("    verify: x\n    max_verify: 0\n"))).toThrow(/max_verify/);
  expect(() => load(base("    max_verify: 2\n"))).toThrow(/requires verify/);
  expect(() => load(base("    verify: x\n    verify_timeout: 1.5\n"))).toThrow(/verify_timeout/);
  expect(() => load(base("    verify: x\n    produces:\n      artifact: verify.md\n"))).toThrow(/verify.md/);
  const skipping = `id: w\nstages:\n  - id: a\n    role: developer\n    verify: x\n  - id: b\n    role: developer\ncompletion:\n  stage: b\n`;
  expect(() => load(skipping)).toThrow(/not on every path to complete: b does not depend on a/);
});

test("prompt lists verify commands and dependency pass table", () => {
  const dir = tempDir("migent-wfprompt-");
  const file = path.join(dir, "w.yaml");
  writeFileSync(file, workflowText("pnpm gate"), "utf8");
  const workflow = loadWorkflowDocument(file);
  const prompt = buildStagePrompt({ workflow, stageId: "implement", snapshots: [], workspace: dir });
  expect(prompt).toContain("Verify commands:");
  expect(prompt).toContain("These commands must exit 0 before you report `status: complete`.");
  expect(prompt).not.toContain("after you report `status: complete`");
  expect(prompt).not.toContain("The first failure stops the run.");
  expect(prompt).toContain("- pnpm gate");
  const dependent = buildStagePrompt({
    workflow,
    stageId: "review",
    workspace: dir,
    snapshots: [
      {
        executionId: "e1",
        stageId: "implement",
        executionOrder: 1,
        status: "completed",
        outcomeStatus: "complete",
        artifactDirectory: dir,
        outcomeDecision: null,
      },
    ],
  });
  expect(dependent).toContain("implement verify:");
});

test("VerifyRunner: onEnd runs after a non-zero exit and an unspawnable shell is infra", async () => {
  const workspace = tempDir("migent-vr-");
  const ends: number[] = [];
  const red = await new VerifyRunner(1).run({
    commands: ["exit 2"],
    workspace,
    executionDirectory: workspace,
    turnDirectory: path.join(workspace, "t"),
    timeoutSec: null,
    onEnd: () => ends.push(1),
  });
  expect(red.commands[0]?.status).toBe("fail");
  expect(ends).toHaveLength(1);
  const infra = await new VerifyRunner(1, "/nonexistent/sh").run({
    commands: ["echo hi"],
    workspace,
    executionDirectory: workspace,
    turnDirectory: path.join(workspace, "t2"),
    timeoutSec: null,
  });
  expect(infra.passed).toBe(false);
  expect(infra.commands).toEqual([]);
  expect(infra.infraError).toMatch(/verify shell/);
}, 30_000);

test("passing verify lets the session move on to the next stage", async () => {
  const { workspace, sessionId } = setup(workflowText(`node -e "process.exit(0)"`));
  const provider = new ScriptedProvider([OK, OK], ["# n\n", null]);
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId },
    new AgentToolRunner({ fake: provider }, 10),
  );
  expect(provider.calls).toHaveLength(2);
  expect(result.status).toBe("completed");
});

test("the execution is running while the first verify command executes", async () => {
  const probe = `cat .migent/sessions/*/executions/*/execution.json | grep -Eq '"status": *"running"'`;
  const { workspace, sessionId } = setup(workflowText(probe));
  const runner = new AgentToolRunner({ fake: new ScriptedProvider([OK], ["# n\n"]) }, 10);
  const result = await runStage(runner, workspace, sessionId);
  const record = execution(workspace, sessionId, result.execution_id);
  expect(record.status).toBe("completed");
  expect((record.verify as Record<string, unknown>).red).toBe(0);
});

function outputsWorkflow(verify: string): string {
  return `\
id: wf
stages:
  - id: plan
    role: developer
    produces:
      artifact: plan.md
  - id: implement
    role: developer
    depends_on: [plan]
    produces:
      artifact: notes.md
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: implement
    verify: ${JSON.stringify(verify)}
    max_verify: 1
completion:
  stage: implement
  decision: approved
  outputs:
    - name: plan
      from_stage: plan
      artifact: plan.md
`;
}

async function runOutputs(verify: string) {
  const { workspace, sessionId } = setup(outputsWorkflow(verify));
  const provider = new ScriptedProvider([OK, "status: complete\ndecision: approved\n\nok"], ["# plan\n", "# n\n"]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  await runStage(runner, workspace, sessionId, { stageId: "plan" });
  const result = await runStage(runner, workspace, sessionId);
  const published = path.join(workspace, ".migent", "sessions", sessionId, "outputs", "plan.md");
  return { result, published };
}

test("outputs are published only after verify passes", async () => {
  const red = await runOutputs("exit 1");
  expect(red.result.session_status).toBe("active");
  expect(existsSync(red.published)).toBe(false);
  const green = await runOutputs("exit 0");
  expect(green.result.outcome_decision).toBe("approved");
  expect(existsSync(green.published)).toBe(true);
});

test("continue carries the artifact and completes once verify passes", async () => {
  const workspace0 = tempDir("migent-verify-c-");
  const command = counterScript(workspace0, "c", 2);
  const { workspace, sessionId } = setup(workflowText(command, "    max_verify: 2\n"));
  const provider = new ScriptedProvider([OK, OK, OK, OK], ["# kept\n", null, null, null]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, runner);
  expect(first.stopReason).toBe("verify_exhausted");
  await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId, resetRevisions: true }, runner);
  const store = new SessionStore(workspace);
  const [, resumed] = store.executionSnapshots(sessionId);
  expect(resumed?.status).toBe("completed");
  expect(readFileSync(path.join(resumed!.artifactDirectory, "notes.md"), "utf8")).toBe("# kept\n");
});

test("cancellation during a verify command marks the execution cancelled and kills the group", async () => {
  const workspace0 = tempDir("migent-verify-p-");
  const pidFile = path.join(workspace0, "pid");
  const script = path.join(workspace0, "hold.cjs");
  // Git Bash's $$ is an MSYS PID on Windows; process.kill needs the native PID.
  writeFileSync(
    script,
    `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30_000);`,
    "utf8",
  );
  const { workspace, sessionId } = setup(workflowText(`exec "${process.execPath}" "${script}"`));
  const runner = new AgentToolRunner({ fake: new ScriptedProvider([OK], ["# n\n"]) }, 10);
  const timer = setInterval(() => {
    if (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "") return;
    clearInterval(timer);
    try {
      raiseCancellation(15);
    } catch {
      // The waiters were woken; the throw is for signal handlers.
    }
  }, 100);
  try {
    await expect(runStage(runner, workspace, sessionId)).rejects.toThrow(/signal 15/);
    const executionsDirectory = path.join(workspace, ".migent", "sessions", sessionId, "executions");
    const [id] = readdirSync(executionsDirectory);
    expect(execution(workspace, sessionId, id!).status).toBe("cancelled");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await expect.poll(() => {
      try {
        process.kill(pid, 0);
        return "running";
      } catch (error) {
        return (error as NodeJS.ErrnoException).code;
      }
    }, { timeout: 5000 }).toBe("ESRCH");
  } finally {
    clearInterval(timer);
    // runStage does not go through executeNamedWorkflow, which clears the sticky flag.
    resetCancellation();
  }
}, 30_000);

test("an infra failure stops the stage and is not verify_exhausted", async () => {
  const { workspace, sessionId } = setup(workflowText("exit 0"));
  const provider = new ScriptedProvider([OK, OK, OK], ["# n\n", "# n\n", "# n\n"]);
  const runner = new AgentToolRunner({ fake: provider }, 10, new VerifyRunner(1, "/nonexistent/sh"));
  const result = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, runner);
  expect(result.stopReason).toBe("stage_failed");
  expect(result.stopReason).not.toBe("verify_exhausted");
  expect(provider.calls).toHaveLength(1);
  const snapshots = new SessionStore(workspace).executionSnapshots(sessionId);
  expect(snapshots).toHaveLength(1);
  expect(snapshots.every((item) => item.failureReason !== "verify_exhausted")).toBe(true);
});

test("a provider failure retries the same stage agent", async () => {
  const { workspace, sessionId } = setup(workflowText(`node -e "process.exit(0)"`));
  class ExitOnceProvider extends ScriptedProvider {
    private failures: number;

    constructor(failures: number, responses: string[], artifacts: Array<string | null>) {
      super(responses, artifacts);
      this.failures = failures;
    }

    override buildCommand(input: Parameters<ScriptedProvider["buildCommand"]>[0]) {
      const spec = super.buildCommand(input);
      if (this.failures <= 0) return spec;
      this.failures -= 1;
      return { argv: [process.execPath, "-e", "process.exit(1)"] };
    }
  }
  const provider = new ExitOnceProvider(
    1,
    ["status: complete\n\nignored", OK, "status: complete\n\nreviewed"],
    [null, "# n\n", null],
  );
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const result = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, runner);
  expect(result.stopReason).toBe("stage_failed");
  expect(provider.calls).toHaveLength(1);
  expect(provider.calls[0]?.agentId).toBeNull();
  const failed = new SessionStore(workspace).executionSnapshots(sessionId);
  expect(failed[0]?.status).toBe("failed");
  const continued = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, continueFailed: true },
    runner,
  );
  expect(continued.stopReason).toBe("completed");
  expect(provider.calls[1]?.agentId).toBe("native-session-1");
  const snapshots = new SessionStore(workspace).executionSnapshots(sessionId);
  expect(execution(workspace, sessionId, snapshots[1]!.executionId).resumes_execution_id).toBe(
    snapshots[0]?.executionId,
  );
});

test("a repair turn without an agent id receives the flattened history", async () => {
  const workspace0 = tempDir("migent-verify-c-");
  const command = counterScript(workspace0, "c", 1);
  const { workspace, sessionId } = setup(workflowText(command));
  class NoIdProvider extends ScriptedProvider {
    override parseResponse(): [string, string | null] {
      return [super.parseResponse()[0], null];
    }
  }
  const provider = new NoIdProvider([OK, OK], ["# n\n", null]);
  const result = await runStage(new AgentToolRunner({ fake: provider }, 10), workspace, sessionId);
  expect(execution(workspace, sessionId, result.execution_id).status).toBe("completed");
  const repair = provider.calls[1]?.prompt ?? "";
  expect(provider.calls[1]?.agentId).toBeNull();
  expect(repair).toContain("done");
  expect(repair).toContain("Verify failed (1 of 3 red runs)");
});

test("resume_from sends the stage prompt again when it rejoins the dependency", async () => {
  const workspace = tempDir("migent-resume-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), CONFIG, "utf8");
  writeFileSync(
    path.join(workspace, ".migent", "workflows", "wf.yaml"),
    `\
id: wf
stages:
  - id: draft
    role: developer
    instructions:
      - Write the draft.
    produces:
      artifact: draft.md
  - id: review
    role: developer
    depends_on: [draft]
    session:
      resume_from: draft
    instructions:
      - Review the draft.
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: draft
completion:
  stage: review
  decision: approved
`,
    "utf8",
  );
  const sessionId = createWorkflowSession(workspace, "wf", "task");
  const provider = new ScriptedProvider(
    [
      "status: complete\n\ndraft",
      "status: complete\ndecision: revise\n\nagain",
      "status: complete\n\ndraft v2",
      "status: complete\ndecision: approved\n\nok",
    ],
    ["# draft\n", null, "# draft v2\n", null],
  );
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId },
    new AgentToolRunner({ fake: provider }, 10),
  );
  expect(result.stopReason).toBe("completed");
  expect(provider.calls[1]?.prompt).toContain("Review the draft.");
  expect(provider.calls[1]?.agentId).toBe("native-session-1");
  expect(provider.calls[2]?.prompt).toContain("Continue this stage.");
  expect(provider.calls[2]?.prompt).not.toContain("Write the draft.");
  const rejoined = provider.calls[3]?.prompt ?? "";
  expect(rejoined).toContain("Stage: review (role: developer)");
  expect(rejoined).toContain("Review the draft.");
  expect(rejoined).not.toContain("Continue this stage.");
  const snapshots = new SessionStore(workspace).executionSnapshots(sessionId);
  expect(execution(workspace, sessionId, snapshots[3]!.executionId).resumes_execution_id).toBe(
    snapshots[2]?.executionId,
  );
});
