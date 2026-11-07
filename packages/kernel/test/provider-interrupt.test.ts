import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { BuildCommandInput, CliRunOutput, InterruptOutcome } from "../src/cli-client.ts";
import { interruptSession } from "../src/provider-interrupt.ts";
import { AgentToolRunner, createWorkflowSession, executeNamedWorkflow, raiseCancellation } from "../src/index.ts";
import type { CommandSpec } from "../src/command-executor.ts";
import { FakeClient, tempDir, registryOf } from "./support.ts";

const CONFIG = `\
agents:
  fake:
    client:
      type: fake
    model: m1
roles:
  developer:
    agent: fake
`;

const WORKFLOW = `\
id: wf
stages:
  - id: implement
    role: developer
completion:
  stage: implement
`;

const PRE_ID = "ses_0123456789abABCDEFGHIJKLMN";
const OTHER_ID = "ses_otherOtherOther000000";

function setup(): { workspace: string; sessionId: string } {
  const workspace = tempDir("migent-interrupt-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), CONFIG, "utf8");
  writeFileSync(path.join(workspace, ".migent", "workflows", "wf.yaml"), WORKFLOW, "utf8");
  return { workspace, sessionId: createWorkflowSession(workspace, "wf", "Finish the notes") };
}

/** Hangs like a client of a shared server; the interrupt command logs whether the client still lives. */
class ServerProvider extends FakeClient {
  readonly pidFile: string;
  readonly interruptLog: string;
  outcomes: InterruptOutcome[] = [];
  reportedId: string | null = null;
  hang = true;

  constructor(root: string) {
    super();
    this.pidFile = path.join(root, "pid");
    this.interruptLog = path.join(root, "interrupts.log");
  }

  newSessionId(): string | null {
    return PRE_ID;
  }

  override runCommand(input: BuildCommandInput): CommandSpec {
    if (!this.hang) return super.runCommand(input);
    this.calls.push({ ...input, options: { ...input.options } });
    const announce =
      this.reportedId === null ? "" : `console.log(JSON.stringify({sessionID:${JSON.stringify(this.reportedId)}}));`;
    // Announce first and publish the pid later: the test cancels as soon as the pid file exists, and the
    // parent must have read the announced id by then (a slow runner otherwise cancels before it does).
    const writePid = `require("fs").writeFileSync(${JSON.stringify(this.pidFile)}, String(process.pid));`;
    const code =
      announce === ""
        ? writePid + "setInterval(() => {}, 1000);"
        : announce + `setTimeout(() => {${writePid}}, 1000);setInterval(() => {}, 1000);`;
    return { argv: [process.execPath, "-e", code] };
  }

  override parseRun(stdout: string, lastMessageFile: string): CliRunOutput {
    return this.hang ? { text: stdout, sessionId: null, source: "model" } : super.parseRun(stdout, lastMessageFile);
  }

  interruptCommand(agentId: string): CommandSpec {
    const code =
      `const fs=require("fs");let alive="unknown";` +
      `try{process.kill(Number(fs.readFileSync(${JSON.stringify(this.pidFile)},"utf8")),0);alive="alive"}catch(e){alive="dead"}` +
      `fs.appendFileSync(${JSON.stringify(this.interruptLog)}, process.argv[1]+" "+alive+"\\n");`;
    return { argv: [process.execPath, "-e", code, agentId] };
  }

  classifyInterrupt(_stdout: string, _exitCode: number | null): InterruptOutcome {
    return this.outcomes.shift() ?? "interrupted";
  }

  sessionIdFromLine(line: string): string | null {
    try {
      const id = (JSON.parse(line) as { sessionID?: unknown }).sessionID;
      return typeof id === "string" ? id : null;
    } catch {
      return null;
    }
  }

  interrupts(): string[] {
    return existsSync(this.interruptLog) ? readFileSync(this.interruptLog, "utf8").trim().split("\n") : [];
  }
}

function fastRunner(provider: ServerProvider, timeoutSec: number | null = 30): AgentToolRunner {
  const runner = new AgentToolRunner(registryOf({ fake: provider }), timeoutSec);
  runner.executor.interruptExitGraceMs = 100;
  runner.interruptPolicy = { attempts: 3, retryDelayMs: 20, commandTimeoutMs: 5000 };
  return runner;
}

function cancelWhenStarted(provider: ServerProvider): () => void {
  const timer = setInterval(() => {
    if (!existsSync(provider.pidFile) || readFileSync(provider.pidFile, "utf8").trim() === "") return;
    clearInterval(timer);
    try {
      raiseCancellation(15);
    } catch {
      // The waiters were woken; the throw is for signal handlers.
    }
  }, 50);
  return () => clearInterval(timer);
}

interface Saved {
  execution: Record<string, unknown>;
  conversation: Record<string, unknown>;
  events: Record<string, unknown>[];
}

function savedExecution(workspace: string, sessionId: string): Saved {
  const base = path.join(workspace, ".migent", "sessions", sessionId);
  const executionId = readdirSync(path.join(base, "executions"))[0]!;
  const read = (name: string) =>
    JSON.parse(readFileSync(path.join(base, "executions", executionId, name), "utf8")) as Record<string, unknown>;
  const events = readFileSync(path.join(base, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { execution: read("execution.json"), conversation: read("conversation.json"), events };
}

const named = (saved: Saved, event: string) => saved.events.filter((item) => item.event === event);

test("a new execution persists the preallocated id and passes it to the first command", async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir("migent-interrupt-id-"));
  provider.hang = false;
  const result = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, fastRunner(provider));
  expect(result.stopReason).toBe("completed");
  expect(provider.calls[0]?.newAgentId).toBe(PRE_ID);
  expect(provider.calls[0]?.agentId).toBeNull();
});

test("cancel interrupts the server-side turn before the client is killed and keeps the id", async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir("migent-interrupt-cancel-"));
  const stop = cancelWhenStarted(provider);
  const result = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, fastRunner(provider));
  stop();
  expect(result.status).toBe("cancelled");
  // The first interrupt runs while the client is still alive.
  expect(provider.interrupts()[0]).toBe(`${PRE_ID} alive`);
  const saved = savedExecution(workspace, sessionId);
  expect(saved.execution.status).toBe("cancelled");
  expect(saved.conversation.agent_id).toBe(PRE_ID);
  expect(named(saved, "provider.interrupt")).not.toHaveLength(0);
  expect(named(saved, "provider.warning")).toHaveLength(0);
}, 30_000);

test("cancel before the server created the session retries a bounded number of times and warns", async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir("migent-interrupt-race-"));
  provider.outcomes = Array.from({ length: 20 }, () => "not-found" as const);
  const stop = cancelWhenStarted(provider);
  const result = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, fastRunner(provider));
  stop();
  expect(result.status).toBe("cancelled");
  // 3 attempts before the kill and 3 more after it; never unbounded.
  expect(provider.interrupts()).toHaveLength(6);
  const saved = savedExecution(workspace, sessionId);
  expect(saved.conversation.agent_id).toBe(PRE_ID);
  const warning = named(saved, "provider.warning")[0];
  expect(String(warning?.summary)).toContain("could not confirm");
  expect(String(warning?.summary)).toContain(PRE_ID);
  expect(named(saved, "provider.interrupt")).toHaveLength(0);
}, 30_000);

test("a session the server creates late is caught by the check after the client stops", async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir("migent-interrupt-late-"));
  provider.outcomes = ["not-found", "not-found", "not-found", "interrupted"];
  const stop = cancelWhenStarted(provider);
  await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, fastRunner(provider));
  stop();
  const saved = savedExecution(workspace, sessionId);
  expect(named(saved, "provider.interrupt")).not.toHaveLength(0);
  expect(named(saved, "provider.warning")).toHaveLength(0);
}, 30_000);

test("an interrupt that fails does not hang or claim the turn stopped", async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir("migent-interrupt-fail-"));
  provider.outcomes = ["failed", "failed"];
  const stop = cancelWhenStarted(provider);
  const result = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, fastRunner(provider));
  stop();
  expect(result.status).toBe("cancelled");
  expect(provider.interrupts()).toHaveLength(2);
  const saved = savedExecution(workspace, sessionId);
  expect(named(saved, "provider.interrupt")).toHaveLength(0);
  expect(named(saved, "provider.warning")).not.toHaveLength(0);
  expect(saved.conversation.agent_id).toBe(PRE_ID);
}, 30_000);

test("an already idle session is reported as idle, not as a failure", async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir("migent-interrupt-idle-"));
  provider.outcomes = ["idle", "idle"];
  const stop = cancelWhenStarted(provider);
  const result = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, fastRunner(provider));
  stop();
  expect(result.status).toBe("cancelled");
  const saved = savedExecution(workspace, sessionId);
  expect(String(named(saved, "provider.interrupt")[0]?.summary)).toContain("idle");
  expect(named(saved, "provider.warning")).toHaveLength(0);
}, 30_000);

test("a different id reported by the provider is warned about and interrupted too", async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir("migent-interrupt-mismatch-"));
  provider.reportedId = OTHER_ID;
  const stop = cancelWhenStarted(provider);
  await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, fastRunner(provider));
  stop();
  const targets = new Set(provider.interrupts().map((line) => line.split(" ")[0]));
  expect(targets).toEqual(new Set([PRE_ID, OTHER_ID]));
  const saved = savedExecution(workspace, sessionId);
  expect(named(saved, "provider.warning").some((event) => String(event.summary).includes("not the expected"))).toBe(true);
}, 30_000);

test("timeout interrupts the server-side turn and keeps the timeout outcome", async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir("migent-interrupt-timeout-"));
  const result = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, fastRunner(provider, 2));
  expect(result.status).not.toBe("cancelled");
  expect(provider.interrupts()[0]).toBe(`${PRE_ID} alive`);
  const saved = savedExecution(workspace, sessionId);
  expect(saved.execution.status).toBe("failed");
  expect(JSON.stringify(saved.execution)).toContain("timed out");
}, 30_000);

test("a provider without an interrupt command keeps its lifecycle", async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir("migent-interrupt-none-"));
  (provider as { interruptCommand?: unknown }).interruptCommand = undefined;
  const stop = cancelWhenStarted(provider);
  const result = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, fastRunner(provider));
  stop();
  expect(result.status).toBe("cancelled");
  expect(provider.interrupts()).toEqual([]);
}, 30_000);

test("an interrupt command that hangs is killed at its timeout and reported failed", async () => {
  const root = tempDir("migent-interrupt-hang-");
  const pidFile = path.join(root, "hang.pid");
  const provider = new ServerProvider(root);
  provider.interruptCommand = () => ({
    argv: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000)`],
  });
  const startedAt = Date.now();
  const report = await interruptSession(provider, PRE_ID, root, { attempts: 3, retryDelayMs: 10, commandTimeoutMs: 500 });
  expect(report?.outcome).toBe("failed");
  expect(report?.attempts).toBe(1);
  expect(Date.now() - startedAt).toBeLessThan(10_000);
  const pid = Number(readFileSync(pidFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(() => process.kill(pid, 0)).toThrow();
}, 30_000);

test("a provider without an interrupt command is stopped without the exit grace period", async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir("migent-interrupt-nograce-"));
  (provider as { interruptCommand?: unknown }).interruptCommand = undefined;
  // Production grace setting, not the shortened one the other tests use.
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 30);
  expect(runner.executor.interruptExitGraceMs).toBe(3000);
  const stop = cancelWhenStarted(provider);
  const startedAt = Date.now();
  let cancelledAt = 0;
  const timer = setInterval(() => {
    if (cancelledAt === 0 && existsSync(provider.pidFile)) cancelledAt = Date.now();
  }, 10);
  const result = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, runner);
  clearInterval(timer);
  stop();
  expect(result.status).toBe("cancelled");
  // Killing the group takes well under the 3s grace; the grace must not be added on top.
  expect(Date.now() - Math.max(cancelledAt, startedAt)).toBeLessThan(2900);
}, 30_000);
