import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { BuildCommandInput } from "../src/adapter.ts";
import { AgentToolRunner, SessionStore, createWorkflowSession, executeNamedWorkflow, raiseCancellation } from "../src/index.ts";
import type { CommandSpec } from "../src/command-executor.ts";
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

class HangFirstAdapter extends ScriptedAdapter {
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
  const adapter = new HangFirstAdapter(pidFile, [OK]);
  const runner = new AgentToolRunner({ fake: adapter }, 10);
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
  expect(adapter.calls).toHaveLength(1);
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
  expect(adapter.calls).toHaveLength(2);
  expect(adapter.calls[1]?.prompt).toContain(adapter.calls[0]?.prompt ?? "missing");
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
  const adapter = new ScriptedAdapter([OK], ["# notes\n"]);
  const runner = new AgentToolRunner({ fake: adapter }, 10);
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
  expect(adapter.calls).toHaveLength(1);
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
  expect(adapter.calls).toHaveLength(1);
  expect(new SessionStore(workspace).readSessionStatus(sessionId).status).toBe("completed");
}, 30_000);
