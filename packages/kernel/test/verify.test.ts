import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  AgentToolRunner,
  SessionStore,
  VerifyRunner,
  createWorkflowSession,
  executeNamedWorkflow,
  raiseCancellation,
  loadWorkflowDocument,
  buildStagePrompt,
} from "../src/index.ts";
import { ScriptedAdapter, tempDir } from "./support.ts";

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
  const runner = new AgentToolRunner({ fake: new ScriptedAdapter([OK], ["# notes\n"]) }, 10);
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
  const adapter = new ScriptedAdapter([OK, OK], ["# notes\n", null]);
  const runner = new AgentToolRunner({ fake: adapter }, 10);
  const result = await runStage(runner, workspace, sessionId);
  const record = execution(workspace, sessionId, result.execution_id);
  expect(record.status).toBe("completed");
  expect(record.turns).toBe(2);
  expect((record.verify as Record<string, unknown>).red).toBe(1);
  expect(adapter.calls).toHaveLength(2);
  expect(adapter.calls[1]?.newAgentId).toBeNull();
  expect(adapter.calls[1]?.prompt).toContain("Verify failed (1 of 3 red runs)");
  expect(adapter.calls[1]?.prompt).toContain("boom 1");
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
    { fake: new ScriptedAdapter(["status: blocked\nblocker: nope"]) },
    10,
  );
  const result = await runStage(runner, workspace, sessionId);
  expect(existsSync(path.join(workspace, "ran.flag"))).toBe(false);
  expect(result.session_status).toBe("blocked");
});

test("exhausted verify stops with exit 6 and continue resumes without --attempts", async () => {
  const { workspace, sessionId } = setup(workflowText(`echo bad; exit 1`, "    max_verify: 2\n"));
  const adapter = new ScriptedAdapter([OK, OK, OK, OK], ["# n\n", null, null, null]);
  const runner = new AgentToolRunner({ fake: adapter }, 10);
  const first = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, maxAttempts: 1 },
    runner,
  );
  expect(first.stopReason).toBe("verify_exhausted");
  expect(first.code).toBe(6);
  expect(first.status).toBe("active");
  expect(adapter.calls).toHaveLength(2);
  const store = new SessionStore(workspace);
  const [exhausted] = store.executionSnapshots(sessionId);
  expect(exhausted?.failureReason).toBe("verify_exhausted");
  expect(execution(workspace, sessionId, exhausted!.executionId).outcome).toBeUndefined();

  const second = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, maxAttempts: 1, resetRevisions: true },
    runner,
  );
  expect(second.stopReason).toBe("verify_exhausted");
  expect(adapter.calls).toHaveLength(4);
  expect(adapter.calls[2]?.agentId).toBe("native-session-1");
  expect(adapter.calls[2]?.prompt).toContain("bad");
  const records = store.executionSnapshots(sessionId);
  expect(records).toHaveLength(2);
  const resumed = execution(workspace, sessionId, records[1]!.executionId);
  expect(resumed.resumes_execution_id).toBe(exhausted!.executionId);
  // The carried artifact exists although the repair turns never rewrote it.
  expect(existsSync(path.join(records[1]!.artifactDirectory, "notes.md"))).toBe(true);

  const once = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId, once: true }, new AgentToolRunner({ fake: new ScriptedAdapter([OK, OK]) }, 10));
  expect(once.code).toBe(6);
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
    { fake: new ScriptedAdapter(["status: complete\ndecision: approved\n\nok"]) },
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
  const runner = new AgentToolRunner({ fake: new ScriptedAdapter([OK], ["# n\n"]) }, 10, verifyRunner);
  const result = await runStage(runner, workspace, sessionId);
  expect(raised).toMatch(/running|unverified|still/i);
  expect(execution(workspace, sessionId, result.execution_id).status).toBe("completed");
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
  const adapter = new ScriptedAdapter([OK, OK], ["# n\n", null]);
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId },
    new AgentToolRunner({ fake: adapter }, 10),
  );
  expect(adapter.calls).toHaveLength(2);
  expect(result.status).toBe("completed");
});

test("the execution is running while the first verify command executes", async () => {
  const probe = `cat .migent/sessions/*/executions/*/execution.json | grep -Eq '"status": *"running"'`;
  const { workspace, sessionId } = setup(workflowText(probe));
  const runner = new AgentToolRunner({ fake: new ScriptedAdapter([OK], ["# n\n"]) }, 10);
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
  const adapter = new ScriptedAdapter([OK, "status: complete\ndecision: approved\n\nok"], ["# plan\n", "# n\n"]);
  const runner = new AgentToolRunner({ fake: adapter }, 10);
  await runStage(runner, workspace, sessionId, { stageId: "plan" });
  const result = await runStage(runner, workspace, sessionId);
  const published = path.join(workspace, ".migent", "sessions", sessionId, "outputs", "plan");
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
  const adapter = new ScriptedAdapter([OK, OK, OK, OK], ["# kept\n", null, null, null]);
  const runner = new AgentToolRunner({ fake: adapter }, 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId, maxAttempts: 1 }, runner);
  expect(first.stopReason).toBe("verify_exhausted");
  await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId, maxAttempts: 1, resetRevisions: true }, runner);
  const store = new SessionStore(workspace);
  const [, resumed] = store.executionSnapshots(sessionId);
  expect(resumed?.status).toBe("completed");
  expect(readFileSync(path.join(resumed!.artifactDirectory, "notes.md"), "utf8")).toBe("# kept\n");
});

test("cancellation during a verify command marks the execution cancelled and kills the group", async () => {
  const workspace0 = tempDir("migent-verify-p-");
  const pidFile = path.join(workspace0, "pid");
  const { workspace, sessionId } = setup(workflowText(`echo $$ > "${pidFile}"; exec sleep 30`));
  const runner = new AgentToolRunner({ fake: new ScriptedAdapter([OK], ["# n\n"]) }, 10);
  const timer = setInterval(() => {
    if (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "") return;
    clearInterval(timer);
    try {
      raiseCancellation(15);
    } catch {
      // The waiters were woken; the throw is for signal handlers.
    }
  }, 100);
  await expect(runStage(runner, workspace, sessionId)).rejects.toThrow(/signal 15/);
  clearInterval(timer);
  const executionsDirectory = path.join(workspace, ".migent", "sessions", sessionId, "executions");
  const [id] = readdirSync(executionsDirectory);
  expect(execution(workspace, sessionId, id!).status).toBe("cancelled");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(() => process.kill(pid, 0)).toThrow();
}, 30_000);

test("an infra failure counts toward --attempts and is not verify_exhausted", async () => {
  const { workspace, sessionId } = setup(workflowText("exit 0"));
  const adapter = new ScriptedAdapter([OK, OK, OK], ["# n\n", "# n\n", "# n\n"]);
  const runner = new AgentToolRunner({ fake: adapter }, 10, new VerifyRunner(1, "/nonexistent/sh"));
  const result = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId, maxAttempts: 2 }, runner);
  expect(result.stopReason).not.toBe("verify_exhausted");
  expect(adapter.calls).toHaveLength(2);
  const snapshots = new SessionStore(workspace).executionSnapshots(sessionId);
  expect(snapshots.every((item) => item.failureReason !== "verify_exhausted")).toBe(true);
});

test("a repair turn without an agent id receives the flattened history", async () => {
  const workspace0 = tempDir("migent-verify-c-");
  const command = counterScript(workspace0, "c", 1);
  const { workspace, sessionId } = setup(workflowText(command));
  class NoIdAdapter extends ScriptedAdapter {
    override parseResponse(): [string, string | null] {
      return [super.parseResponse()[0], null];
    }
  }
  const adapter = new NoIdAdapter([OK, OK], ["# n\n", null]);
  const result = await runStage(new AgentToolRunner({ fake: adapter }, 10), workspace, sessionId);
  expect(execution(workspace, sessionId, result.execution_id).status).toBe("completed");
  const repair = adapter.calls[1]?.prompt ?? "";
  expect(adapter.calls[1]?.agentId).toBeNull();
  expect(repair).toContain("done");
  expect(repair).toContain("Verify failed (1 of 3 red runs)");
});
