import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { ClaudeCodeClient } from "../../adapters/src/clients/claude-code-client.ts";
import { type BuildCommandInput, type FailureClassification, SessionStore, STATUS_PROVIDER_EVENTS, sessionMetrics, watchSnapshot } from "@nodeint/migent-kernel";
import { AgentToolRunner, executeNamedWorkflow } from "../src/index.ts";
import { ScriptedClient, tempDir, registryOf } from "./support.ts";

// Each stage spawns a wrapper and a provider process, which is slow on Windows CI.
vi.setConfig({ testTimeout: 60_000 });

const CONFIG = `\
agents:
  alpha:
    client:
      type: alpha
    model: m1
  beta:
    client:
      type: beta
    model: m1
roles:
  developer:
    agent: alpha
  reviewer:
    agent: beta
`;

const FUTURE = "2099-01-01T00:00:00.000Z";

class ClassifiedProvider extends ScriptedClient {
  private readonly kinds: Array<FailureClassification | null>;

  constructor(responses: string[], kinds: Array<FailureClassification | null>) {
    super(responses, responses.map(() => null));
    this.kinds = [...kinds];
    this.captureUsage = () => ({ result: { usage: { input_tokens: 0, output_tokens: 0 } } });
  }

  override extractFailure(_stdout: string, _exitCode: number): ReturnType<ScriptedClient["extractFailure"]> {
    const next = this.kinds.shift();
    if (next === undefined || next === null) return null;
    if (next.kind === "quota") {
      return {
        origin: "provider-error",
        message: next.message,
        exitCode: 1,
        rateLimit: { resetAt: next.resetAt, window: next.window },
      };
    }
    return { origin: "provider-error", message: next.message, exitCode: 1 };
  }
}

function quota(resetAt: string | null, message = "quota window"): FailureClassification {
  return { kind: "quota", message, resetAt, window: "five_hour" };
}

function workspaceFor(text: string, id = "wf"): string {
  const workspace = tempDir("migent-quota-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), CONFIG, "utf8");
  writeFileSync(path.join(workspace, ".migent", "workflows", `${id}.yaml`), text, "utf8");
  return workspace;
}

const SOLO = `\
schema_version: 2
id: wf
stages:
  - id: implement
    role: developer
    depends_on: []
`;

const PAIR = `\
schema_version: 2
id: wf
concurrency: 1
stages:
  - id: a
    role: developer
    depends_on: []
  - id: b
    role: reviewer
    depends_on: []
`;

function executionFile(workspace: string, sessionId: string): Record<string, unknown> {
  const store = new SessionStore(workspace);
  const latest = store.latestExecution(sessionId);
  if (latest === null) throw new Error("missing execution");
  return JSON.parse(readFileSync(path.join(latest.directory, "execution.json"), "utf8")) as Record<string, unknown>;
}

test("a provider failure is not retried, and continue dispatches once", async () => {
  const workspace = workspaceFor(SOLO);
  const provider = new ClassifiedProvider(
    ["status: complete\n\nnope", "status: complete\n\nagain"],
    [{ kind: "provider", message: "cli failed" }, { kind: "provider", message: "again" }],
  );
  const runner = new AgentToolRunner(registryOf({ alpha: provider }), 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: "wf", task: "Write" }, runner);
  expect(first.stopReason).toBe("stage_failed");
  expect(first.code).toBe(3);
  expect(provider.calls).toHaveLength(1);
  const sessionId = first.sessionId;
  const events = readFileSync(path.join(workspace, ".migent", "sessions", sessionId, "events.jsonl"), "utf8");
  const second = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, continueFailed: true },
    runner,
  );
  expect(provider.calls).toHaveLength(2);
  expect(second.stopReason).toBe("stage_failed");
  expect(second.code).toBe(3);
  const continued = readFileSync(path.join(workspace, ".migent", "sessions", sessionId, "events.jsonl"), "utf8");
  expect(continued).toContain('"from":"failed"');
  expect(continued.length).toBeGreaterThan(events.length);
});

test("a stage with no verify persists quota fields", async () => {
  const workspace = workspaceFor(SOLO);
  const provider = new ClassifiedProvider(["status: complete\n\nlimited"], [quota(FUTURE)]);
  const runner = new AgentToolRunner(registryOf({ alpha: provider }), 10);
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", task: "Write", once: true },
    runner,
  );
  expect(result.code).toBe(8);
  expect(result.stopReason).toBe("quota");
  const metadata = executionFile(workspace, result.sessionId);
  expect(metadata.status).toBe("failed");
  expect(metadata.failure_reason).toBe("quota");
  expect(metadata.retry_at).toBe(FUTURE);
  expect(result.stages[0]?.response_path === undefined).toBe(true);
});

test("an empty reset stops with stage_failed", async () => {
  const workspace = workspaceFor(SOLO);
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", task: "Write" },
    new AgentToolRunner(registryOf({ alpha: new ClassifiedProvider(["status: complete\n\nx"], [quota(null)]) }), 10),
  );
  expect(result.stopReason).toBe("stage_failed");
  expect(result.code).toBe(3);
});

test("--once on quota exits 8 and a non-continue --once on the failure does not call the agent", async () => {
  const workspace = workspaceFor(SOLO);
  const provider = new ClassifiedProvider(["status: complete\n\nx", "status: complete\n\ny"], [quota(FUTURE), null]);
  const runner = new AgentToolRunner(registryOf({ alpha: provider }), 10);
  const first = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", task: "Write", once: true },
    runner,
  );
  expect(first.code).toBe(8);
  expect(first.stages[0]?.reset_at).toBe(FUTURE);
  const sessionId = first.sessionId;
  const skipped = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, once: true },
    runner,
  );
  expect(skipped.code).toBe(3);
  expect(skipped.stopReason).toBe("stage_failed");
  expect(provider.calls).toHaveLength(1);
  const continued = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, once: true, continueFailed: true },
    runner,
  );
  expect(provider.calls).toHaveLength(2);
  expect(continued.code).toBe(0);
});

test("provider.quota names the execution and a zero capture is not uncaptured", async () => {
  expect(STATUS_PROVIDER_EVENTS.has("provider.quota")).toBe(true);
  const workspace = workspaceFor(SOLO);
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const provider = new ClassifiedProvider(["status: complete\n\nlimited"], [quota(FUTURE)]);
    const result = await executeNamedWorkflow(
      workspace,
      { workflowId: "wf", task: "Write" },
      new AgentToolRunner(registryOf({ alpha: provider }), 10),
    );
    const events = readFileSync(path.join(workspace, ".migent", "sessions", result.sessionId, "events.jsonl"), "utf8");
    expect(events).toContain("provider.quota");
    expect(events).toContain(FUTURE);
    expect(lines.join("")).toContain(FUTURE);
    const metrics = sessionMetrics(workspace, result.sessionId, registryOf({ alpha: provider }));
    const executions = metrics.executions as Array<{ uncaptured_turns: number }>;
    expect(executions[0]?.uncaptured_turns).toBe(0);
  } finally {
    process.stderr.write = write;
  }
});

test("a provider timeout stops with stage_failed", async () => {
  const workspace = workspaceFor(SOLO);
  class HangProvider extends ScriptedClient {
    override runCommand(input: Parameters<ScriptedClient["runCommand"]>[0]) {
      super.runCommand(input);
      return { argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"] };
    }
  }
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", task: "Write" },
    new AgentToolRunner(registryOf({ alpha: new HangProvider(["status: complete\n\nunused"]) }), 1),
  );
  expect(result.stopReason).toBe("stage_failed");
  expect(result.code).toBe(3);
});

test("an exit-0 claude is_error result fails the execution", async () => {
  const workspace = workspaceFor(SOLO);
  const fixture = '{"type":"result","is_error":true,"subtype":"success","result":"claude failed closed","session_id":"sess-1"}\n';
  class ExitZeroClaude extends ClaudeCodeClient {
    override runCommand() {
      return { argv: [process.execPath, "-e", "process.stdout.write(process.argv[1])", fixture] };
    }
  }
  const runner = new AgentToolRunner(registryOf({ alpha: new ExitZeroClaude() }), 10);
  const result = await executeNamedWorkflow(workspace, { workflowId: "wf", task: "Write" }, runner);
  expect(result.stopReason).toBe("stage_failed");
  const metadata = executionFile(workspace, result.sessionId);
  expect(metadata.status).toBe("failed");
  expect(metadata.failure_reason).not.toBe("quota");
});


test("a quota failure fails the stage, keeps its facts, and is not retried", async () => {
  const workspace = workspaceFor(SOLO);
  const provider = new ClassifiedProvider(["status: complete\n\nlimited", "status: complete\n\nunused"], [quota(FUTURE, "five hour limit"), null]);
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", task: "Write" },
    new AgentToolRunner(registryOf({ alpha: provider }), 10),
  );
  expect(result.stopReason).toBe("stage_failed");
  expect(result.code).toBe(3);
  expect(provider.calls).toHaveLength(1);
  const metadata = executionFile(workspace, result.sessionId);
  expect(metadata.status).toBe("failed");
  expect(metadata.failure_reason).toBe("quota");
  expect(metadata.retry_at).toBe(FUTURE);
  const events = readFileSync(path.join(workspace, ".migent", "sessions", result.sessionId, "events.jsonl"), "utf8");
  expect(events).toContain("provider.quota");
  expect(events).toContain("five hour limit");
  expect(metadata.quota_window).toBe("five_hour");
  const quotaLine = events.split("\n").find((line) => line.includes('"provider.quota"')) ?? "";
  expect(quotaLine).toContain("five_hour");
  expect(quotaLine).toContain(FUTURE);
  const sessionDirectory = path.join(workspace, ".migent", "sessions", result.sessionId);
  const latest = new SessionStore(workspace).latestExecution(result.sessionId)!;
  const report = readFileSync(path.join(latest.directory, "failure.md"), "utf8");
  expect(report).toContain(`Quota resets at: ${FUTURE}`);
  expect(report).toContain("five_hour");
  expect(report).toContain("five hour limit");
  expect(watchSnapshot(sessionDirectory).quota_failures).toEqual([
    { stage_id: "implement", execution_id: latest.executionId, message: "five hour limit", reset_at: FUTURE, window: "five_hour" },
  ]);
});

test("a quota failure with a past reset is not retried either", async () => {
  const workspace = workspaceFor(SOLO);
  const provider = new ClassifiedProvider(["status: complete\n\nfirst", "status: complete\n\nsecond"], [quota("2000-01-01T00:00:00.000Z"), null]);
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", task: "Write" },
    new AgentToolRunner(registryOf({ alpha: provider }), 10),
  );
  expect(provider.calls).toHaveLength(1);
  expect(result.stopReason).toBe("stage_failed");
});

test("a quota failure stops its branch and another client's stage still runs", async () => {
  const workspace = workspaceFor(PAIR);
  const alpha = new ClassifiedProvider(["status: complete\n\na"], [quota(FUTURE)]);
  const beta = new ClassifiedProvider(["status: complete\n\nb"], [null]);
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", task: "Write" },
    new AgentToolRunner(registryOf({ alpha, beta }), 10),
  );
  expect(alpha.calls).toHaveLength(1);
  expect(beta.calls).toHaveLength(1);
  expect(result.stopReason).toBe("stage_failed");
  // Stage b completed after a failed on quota; inspection still reports a.
  const sessionDirectory = path.join(workspace, ".migent", "sessions", result.sessionId);
  const failures = watchSnapshot(sessionDirectory).quota_failures as Array<Record<string, unknown>>;
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ stage_id: "a", reset_at: FUTURE, window: "five_hour" });
  expect(watchSnapshot(sessionDirectory, "").latest_execution_id).not.toBe(failures[0]!.execution_id);
  // A successful continuation resolves it.
  const recovered = new ClassifiedProvider(["status: complete\n\na2"], [null]);
  await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId: result.sessionId, continueFailed: true },
    new AgentToolRunner(registryOf({ alpha: recovered, beta }), 10),
  );
  expect(recovered.calls).toHaveLength(1);
  expect(watchSnapshot(sessionDirectory).quota_failures).toBeUndefined();
});

test("session continue reruns a quota-failed stage", async () => {
  const workspace = workspaceFor(SOLO);
  const provider = new ClassifiedProvider(["status: complete\n\nlimited", "status: complete\n\nok"], [quota(FUTURE), null]);
  const runner = new AgentToolRunner(registryOf({ alpha: provider }), 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: "wf", task: "Write" }, runner);
  expect(first.stopReason).toBe("stage_failed");
  const continued = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId: first.sessionId, continueFailed: true },
    runner,
  );
  expect(provider.calls).toHaveLength(2);
  expect(continued.stopReason).toBe("completed");
});
