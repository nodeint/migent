import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { ClaudeProvider } from "../../adapters/src/providers/claude-provider.ts";
import {
  AgentToolRunner,
  type FailureClassification,
  SessionStore,
  STATUS_PROVIDER_EVENTS,
  executeNamedWorkflow,
  raiseCancellation,
  requestSessionCancel,
  resetCancellation,
  sessionMetrics,
  waitUntil,
} from "../src/index.ts";
import { ScriptedProvider, tempDir } from "./support.ts";

const CONFIG = `\
models:
  alpha:
    provider: alpha
    model: m1
  beta:
    provider: beta
    model: m1
roles:
  developer:
    default_model: alpha
  reviewer:
    default_model: beta
`;

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";
const LATER = "2099-06-01T00:00:00.000Z";

class ClassifiedProvider extends ScriptedProvider {
  private readonly kinds: Array<FailureClassification | null>;

  constructor(responses: string[], kinds: Array<FailureClassification | null>) {
    super(responses, responses.map(() => null));
    this.kinds = [...kinds];
    this.captureUsage = () => ({ result: { usage: { input_tokens: 0, output_tokens: 0 } } });
  }

  override classifyFailure(): FailureClassification | null {
    const next = this.kinds.shift();
    return next === undefined ? null : next;
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

test("waitUntil reaches, replaces, and cancels", async () => {
  const reached = waitUntil(PAST, { now: () => Date.parse(FUTURE), sleep: async () => { throw new Error("slept"); } });
  expect(await reached.promise).toBe("reached");

  let slept = false;
  const replaced = waitUntil(FUTURE, {
    now: () => Date.parse(PAST),
    sleep: async () => {
      slept = true;
    },
  });
  replaced.replace(LATER);
  expect(await replaced.promise).toBe("replaced");
  expect(slept).toBe(true);

  resetCancellation();
  const cancelled = waitUntil(FUTURE, {
    now: () => Date.parse(PAST),
    sleep: async () => {
      raiseCancellation(2);
    },
  });
  await expect(cancelled.promise).rejects.toThrow(/signal 2/);
  resetCancellation();
});

test("a provider failure does not wait, and continue dispatches once", async () => {
  const workspace = workspaceFor(SOLO);
  const provider = new ClassifiedProvider(
    ["status: complete\n\nnope", "status: complete\n\nagain"],
    [{ kind: "provider", message: "cli failed" }, { kind: "provider", message: "again" }],
  );
  let slept = 0;
  const hooks = { now: () => Date.parse(PAST), sleep: async () => { slept += 1; } };
  const runner = new AgentToolRunner({ alpha: provider }, 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: "wf", task: "Write", waitHooks: hooks }, runner);
  expect(first.stopReason).toBe("stage_failed");
  expect(first.code).toBe(3);
  expect(slept).toBe(0);
  expect(provider.calls).toHaveLength(1);
  const sessionId = first.sessionId;
  const events = readFileSync(path.join(workspace, ".migent", "sessions", sessionId, "events.jsonl"), "utf8");
  const second = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", sessionId, continueFailed: true, waitHooks: hooks },
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
  const runner = new AgentToolRunner({ alpha: provider }, 10);
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", task: "Write", once: true, waitHooks: { sleep: async () => { throw new Error("waited"); } } },
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

test("a past quota dispatches once and a repeat that is not later stops", async () => {
  const workspace = workspaceFor(SOLO);
  const provider = new ClassifiedProvider(
    ["status: complete\n\nfirst", "status: complete\n\nsecond"],
    [quota(PAST), quota(PAST)],
  );
  let slept = 0;
  const result = await executeNamedWorkflow(
    workspace,
    {
      workflowId: "wf",
      task: "Write",
      maxDispatches: 5,
      waitHooks: { now: () => Date.parse("2020-01-01T00:00:00.000Z"), sleep: async () => { slept += 1; } },
    },
    new AgentToolRunner({ alpha: provider }, 10),
  );
  expect(slept).toBe(0);
  expect(provider.calls).toHaveLength(2);
  expect(result.stopReason).toBe("stage_failed");
  expect(result.code).toBe(3);
});

test("an empty reset stops with stage_failed", async () => {
  const workspace = workspaceFor(SOLO);
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", task: "Write", waitHooks: { sleep: async () => { throw new Error("waited"); } } },
    new AgentToolRunner({ alpha: new ClassifiedProvider(["status: complete\n\nx"], [quota(null)]) }, 10),
  );
  expect(result.stopReason).toBe("stage_failed");
  expect(result.code).toBe(3);
});

test("quota at the dispatch ceiling does not wait", async () => {
  const workspace = workspaceFor(SOLO);
  let slept = 0;
  const result = await executeNamedWorkflow(
    workspace,
    {
      workflowId: "wf",
      task: "Write",
      maxDispatches: 1,
      waitHooks: { now: () => Date.parse(PAST), sleep: async () => { slept += 1; } },
    },
    new AgentToolRunner({ alpha: new ClassifiedProvider(["status: complete\n\nx"], [quota(FUTURE)]) }, 10),
  );
  expect(result.stopReason).toBe("dispatch_limit");
  expect(result.code).toBe(5);
  expect(slept).toBe(0);
});

test("--once on quota exits 8 and a non-continue --once on the failure does not call the agent", async () => {
  const workspace = workspaceFor(SOLO);
  const provider = new ClassifiedProvider(["status: complete\n\nx", "status: complete\n\ny"], [quota(FUTURE), null]);
  const runner = new AgentToolRunner({ alpha: provider }, 10);
  const first = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", task: "Write", once: true, waitHooks: { sleep: async () => { throw new Error("waited"); } } },
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
    { workflowId: "wf", sessionId, once: true, continueFailed: true, waitHooks: { sleep: async () => { throw new Error("waited"); } } },
    runner,
  );
  expect(provider.calls).toHaveLength(2);
  expect(continued.code).toBe(0);
});

test("the parked provider waits and another provider can start", async () => {
  const workspace = workspaceFor(PAIR);
  const alpha = new ClassifiedProvider(["status: complete\n\na", "status: complete\n\na2"], [quota(FUTURE), null]);
  const beta = new ClassifiedProvider(["status: complete\n\nb"], [null]);
  let now = Date.parse(PAST);
  let sawBetaDuringWait = false;
  const result = await executeNamedWorkflow(
    workspace,
    {
      workflowId: "wf",
      task: "Write",
      waitHooks: {
        now: () => now,
        sleep: async () => {
          for (let attempt = 0; attempt < 50 && beta.calls.length === 0; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          sawBetaDuringWait = beta.calls.length >= 1;
          now = Date.parse(FUTURE);
        },
      },
    },
    new AgentToolRunner({ alpha, beta }, 10),
  );
  expect(sawBetaDuringWait).toBe(true);
  expect(alpha.calls.length).toBeGreaterThanOrEqual(1);
  expect(result.code).toBe(0);
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
    const provider = new ClassifiedProvider(["status: complete\n\nlimited", "status: complete\n\ndone"], [quota(FUTURE), null]);
    let now = Date.parse(PAST);
    const result = await executeNamedWorkflow(
      workspace,
      {
        workflowId: "wf",
        task: "Write",
        waitHooks: {
          now: () => now,
          sleep: async () => {
            now = Date.parse(FUTURE);
          },
        },
      },
      new AgentToolRunner({ alpha: provider }, 10),
    );
    const events = readFileSync(path.join(workspace, ".migent", "sessions", result.sessionId, "events.jsonl"), "utf8");
    expect(events).toContain("provider.quota");
    expect(events).toContain(FUTURE);
    expect(lines.join("")).toContain(FUTURE);
    const metrics = sessionMetrics(workspace, result.sessionId, { alpha: provider });
    const executions = metrics.executions as Array<{ uncaptured_turns: number }>;
    expect(executions[0]?.uncaptured_turns).toBe(0);
  } finally {
    process.stderr.write = write;
  }
});

test("a provider timeout stops with stage_failed and does not wait", async () => {
  const workspace = workspaceFor(SOLO);
  class HangProvider extends ScriptedProvider {
    override buildCommand(input: Parameters<ScriptedProvider["buildCommand"]>[0]) {
      super.buildCommand(input);
      return { argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"] };
    }
  }
  let slept = 0;
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", task: "Write", waitHooks: { sleep: async () => { slept += 1; } } },
    new AgentToolRunner({ alpha: new HangProvider(["status: complete\n\nunused"]) }, 1),
  );
  expect(result.stopReason).toBe("stage_failed");
  expect(result.code).toBe(3);
  expect(slept).toBe(0);
});

test("an exit-0 claude is_error result fails the execution", async () => {
  const workspace = workspaceFor(SOLO);
  const fixture = '{"type":"result","is_error":true,"subtype":"success","result":"claude failed closed","session_id":"sess-1"}\n';
  class ExitZeroClaude extends ClaudeProvider {
    override buildCommand() {
      return { argv: [process.execPath, "-e", "process.stdout.write(process.argv[1])", fixture] };
    }
  }
  const runner = new AgentToolRunner({ alpha: new ExitZeroClaude() }, 10);
  const result = await executeNamedWorkflow(workspace, { workflowId: "wf", task: "Write" }, runner);
  expect(result.stopReason).toBe("stage_failed");
  const metadata = executionFile(workspace, result.sessionId);
  expect(metadata.status).toBe("failed");
  expect(metadata.failure_reason).not.toBe("quota");
});

test("cancel during a wait leaves the session active and the execution failed", async () => {
  const workspace = workspaceFor(SOLO);
  resetCancellation();
  const result = await executeNamedWorkflow(
    workspace,
    {
      workflowId: "wf",
      task: "Write",
      waitHooks: {
        now: () => Date.parse(PAST),
        sleep: async () => {
          raiseCancellation(15);
        },
      },
    },
    new AgentToolRunner({ alpha: new ClassifiedProvider(["status: complete\n\nx"], [quota(FUTURE)]) }, 10),
  );
  expect(result.code).toBe(130);
  expect(result.status).toBe("active");
  const metadata = executionFile(workspace, result.sessionId);
  expect(metadata.status).toBe("failed");
  expect(metadata.failure_reason).toBe("quota");
  resetCancellation();
  const continued = await executeNamedWorkflow(
    workspace,
    {
      workflowId: "wf",
      sessionId: result.sessionId,
      continueFailed: true,
      waitHooks: { sleep: async () => { throw new Error("waited"); } },
    },
    new AgentToolRunner({ alpha: new ClassifiedProvider(["status: complete\n\nok"], [null]) }, 10),
  );
  expect(continued.stopReason).toBe("completed");
});

test("a cancel marker wakes a quota wait and stops the session", async () => {
  const workspace = workspaceFor(SOLO);
  const sessions = path.join(workspace, ".migent", "sessions");
  const timer = setInterval(() => {
    if (!existsSync(sessions)) return;
    for (const id of readdirSync(sessions)) {
      const events = path.join(sessions, id, "events.jsonl");
      if (!existsSync(events) || !readFileSync(events, "utf8").includes("quota")) continue;
      clearInterval(timer);
      requestSessionCancel(path.join(sessions, id));
    }
  }, 50);
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "wf", task: "Write" },
    new AgentToolRunner({ alpha: new ClassifiedProvider(["status: complete\n\nlimited"], [quota(FUTURE)]) }, 10),
  );
  clearInterval(timer);
  expect(result.stopReason).toBe("cancelled");
  expect(existsSync(path.join(sessions, result.sessionId, "session.lock"))).toBe(false);
}, 30_000);
