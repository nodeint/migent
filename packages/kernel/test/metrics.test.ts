import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  AgentToolRunner,
  createAgentSession,
  executeNamedWorkflow,
  listSealedMetrics,
  listSessionMetrics,
  readSealedMetrics,
  sealedMetricsPath,
  sessionMetrics,
} from "../src/index.ts";
import type { TurnUsage, UsageCapture } from "../src/provider-contract.ts";
import { FakeProvider, ScriptedProvider, tempDir } from "./support.ts";

const PLAN = `\
id: plan
stages:
  - id: plan
    role: planner
    max_revisions: 3
    depends_on: []
    produces:
      artifact: plan.md
  - id: review
    role: reviewer
    depends_on:
      - plan
    decision:
      values:
        - approved
        - revise
      routes:
        approved: complete
        revise: plan
completion:
  stage: review
  decision: approved
  outputs:
    - name: plan
      from_stage: plan
      artifact: plan.md
`;

const ONCE = `\
id: once
stages:
  - id: implement
    role: developer
    depends_on: []
    produces:
      artifact: notes.md
completion:
  stage: implement
`;

const CHECK = `\
id: check
stages:
  - id: implement
    role: developer
    depends_on: []
    produces:
      artifact: notes.md
    verify:
      - pnpm gate
completion:
  stage: implement
`;

function at(second: number): string {
  return `2026-10-20T00:00:${String(second).padStart(2, "0")}.000+00:00`;
}

function blank(): TurnUsage {
  return {
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_usd: null,
  };
}

function cumulative(current: UsageCapture, previous: UsageCapture | null): TurnUsage {
  const total = typeof current.total === "number" ? current.total : 0;
  const prior = previous !== null && typeof previous.total === "number" ? previous.total : 0;
  const delta = total - prior;
  return { ...blank(), input_tokens: delta < 0 ? null : delta };
}

interface ExecInput {
  id: string;
  order: number;
  stage: string;
  status: string;
  provider?: string;
  createdAt?: string;
  completedAt?: string | null;
  outcome?: Record<string, unknown> | null;
}

function writeSession(
  workspace: string,
  sessionId: string,
  status: Record<string, unknown>,
  executions: ExecInput[],
  events: Record<string, unknown>[],
): void {
  const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
  mkdirSync(path.join(sessionDirectory, "executions"), { recursive: true });
  writeFileSync(path.join(sessionDirectory, "status.json"), JSON.stringify(status));
  const lines = events.map((event) => JSON.stringify(event));
  writeFileSync(path.join(sessionDirectory, "events.jsonl"), lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  for (const execution of executions) {
    const directory = path.join(sessionDirectory, "executions", execution.id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "execution.json"),
      JSON.stringify({
        execution_id: execution.id,
        execution_order: execution.order,
        stage_id: execution.stage,
        stage_attempt: execution.order,
        provider: execution.provider ?? "fake",
        model: "m1",
        agent_id: "agent-1",
        resumes_execution_id: null,
        status: execution.status,
        created_at: execution.createdAt ?? at(0),
        completed_at: execution.completedAt === undefined ? at(10) : execution.completedAt,
        outcome: execution.outcome === undefined ? { status: "complete" } : execution.outcome,
        error: null,
        failure_reason: null,
      }),
    );
  }
}

function event(
  seq: number,
  name: string,
  executionId: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 2,
    seq,
    event: name,
    timestamp: at(0),
    ...(executionId === null ? {} : { execution_id: executionId }),
    provider: "fake",
    data: {},
    ...extra,
  };
}

function turn(
  seq: number,
  executionId: string,
  usage: Record<string, unknown> | null,
  provider = "fake",
  agentId = "agent-1",
): Record<string, unknown> {
  const details: Record<string, unknown> = { turn: 1, agent_id: agentId, argv: [provider] };
  if (usage !== null) details.usage = usage;
  return event(seq, "provider.turn_completed", executionId, { provider, details });
}

function workspaceWith(name: string, text: string): string {
  const workspace = tempDir("migent-metrics-");
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workflows, name), text, "utf8");
  return workspace;
}

test("counts a revision and keeps routed_from across a failed retry", () => {
  const workspace = workspaceWith("plan.yaml", PLAN);
  const sessionId = "revise";
  writeSession(
    workspace,
    sessionId,
    {
      session_id: sessionId,
      workflow_id: "plan",
      workflow_path: ".migent/workflows/plan.yaml",
      status: "completed",
      latest_decision: "approved",
      task_sha256: "task",
      prior_session_id: null,
      created_at: at(0),
      updated_at: at(40),
    },
    [
      { id: "0001-plan--attempt-01", order: 1, stage: "plan", status: "completed", outcome: { status: "complete" } },
      {
        id: "0002-review--attempt-01",
        order: 2,
        stage: "review",
        status: "completed",
        outcome: { status: "complete", decision: "revise" },
      },
      { id: "0003-plan--attempt-02", order: 3, stage: "plan", status: "failed", outcome: null },
      { id: "0004-plan--attempt-03", order: 4, stage: "plan", status: "completed", outcome: { status: "complete" } },
      {
        id: "0005-review--attempt-02",
        order: 5,
        stage: "review",
        status: "completed",
        outcome: { status: "complete", decision: "approved" },
      },
    ],
    [
      event(1, "session.created", null, { data: { hash: "abc123" } }),
      event(2, "revisions.reset", null),
    ],
  );
  const metrics = sessionMetrics(workspace, sessionId, { fake: new FakeProvider() });
  const stages = metrics.stages as Record<string, Record<string, unknown>>;
  const executions = metrics.executions as Array<Record<string, unknown>>;
  expect(Object.keys(stages)).toEqual(["plan", "review"]);
  expect(stages.plan).toMatchObject({ executions: 3, revisions: 1, failed: 1, blocked: 0 });
  expect(stages.review).toMatchObject({ executions: 2, revisions: 0, failed: 0 });
  expect(executions[2]?.routed_from).toBe("0002-review--attempt-01");
  expect(executions[3]?.routed_from).toBe("0002-review--attempt-01");
  expect(executions[0]?.routed_from).toBeNull();
  expect(executions[0]?.role).toBe("planner");
  expect(executions[1]?.role).toBe("reviewer");
  expect((metrics.totals as Record<string, unknown>).revisions).toBe(1);
  expect((metrics.totals as Record<string, unknown>).revisions_reset).toBe(1);
  expect(metrics.workflow_hash).toBe("abc123");
});

test("a failed attempt then a success is not a revision", () => {
  const workspace = workspaceWith("once.yaml", ONCE);
  writeSession(
    workspace,
    "retry",
    { workflow_id: "once", workflow_path: ".migent/workflows/once.yaml", status: "completed", updated_at: at(1) },
    [
      { id: "0001-implement--attempt-01", order: 1, stage: "implement", status: "failed", outcome: null },
      { id: "0002-implement--attempt-02", order: 2, stage: "implement", status: "completed" },
    ],
    [event(1, "session.created", null, { data: {} })],
  );
  const metrics = sessionMetrics(workspace, "retry", {});
  const stage = (metrics.stages as Record<string, Record<string, unknown>>).implement;
  expect(stage).toMatchObject({ failed: 1, revisions: 0, executions: 2 });
});

test("verify red then red then pass", () => {
  const workspace = workspaceWith("check.yaml", CHECK);
  const executionId = "0001-implement--attempt-01";
  writeSession(
    workspace,
    "verify",
    { workflow_id: "check", workflow_path: ".migent/workflows/check.yaml", status: "completed", updated_at: at(1) },
    [{ id: executionId, order: 1, stage: "implement", status: "completed", createdAt: at(0), completedAt: at(20) }],
    [
      event(1, "verify.started", executionId, { timestamp: at(0) }),
      event(2, "verify.failed", executionId, { timestamp: at(2), details: { command: "pnpm gate" } }),
      event(3, "verify.started", executionId, { timestamp: at(2) }),
      event(4, "verify.failed", executionId, { timestamp: at(3), details: { command: "pnpm gate" } }),
      event(5, "verify.started", executionId, { timestamp: at(3) }),
      event(6, "verify.passed", executionId, { timestamp: at(5) }),
    ],
  );
  const metrics = sessionMetrics(workspace, "verify", {});
  const execution = (metrics.executions as Array<Record<string, unknown>>)[0];
  expect(execution?.verify).toEqual({
    runs: 3,
    red: 2,
    first_pass: false,
    failed_commands: ["pnpm gate", "pnpm gate"],
  });
  expect(execution?.verify_seconds).toBe(5);
  expect((metrics.totals as Record<string, unknown>).verify_seconds).toBe(5);
  expect((metrics.totals as Record<string, unknown>).verify_red).toBe(2);
});

test("a cumulative provider deltas across executions that share an agent", () => {
  const workspace = tempDir("migent-metrics-");
  const provider = new FakeProvider();
  provider.normalizeUsage = cumulative;
  writeSession(
    workspace,
    "cost",
    { workflow_id: "agent", status: "completed", updated_at: at(2), role: "developer" },
    [
      { id: "0001", order: 1, stage: "agent", status: "completed" },
      { id: "0002", order: 2, stage: "agent", status: "completed" },
    ],
    [turn(1, "0001", { total: 100 }), turn(2, "0002", { total: 140 })],
  );
  const metrics = sessionMetrics(workspace, "cost", { fake: provider });
  const executions = metrics.executions as Array<Record<string, unknown>>;
  expect((executions[0]?.usage as TurnUsage).input_tokens).toBe(100);
  expect((executions[1]?.usage as TurnUsage).input_tokens).toBe(40);
  expect((metrics.totals as { usage: TurnUsage }).usage.input_tokens).toBe(140);
  expect(executions[0]?.role).toBe("developer");
});

test("a cancelled turn's spend is in the next delta", () => {
  const workspace = tempDir("migent-metrics-");
  const provider = new FakeProvider();
  provider.normalizeUsage = cumulative;
  writeSession(
    workspace,
    "cancel",
    { workflow_id: "agent", status: "completed", updated_at: at(2) },
    [
      { id: "0001", order: 1, stage: "agent", status: "completed" },
      { id: "0002", order: 2, stage: "agent", status: "completed" },
    ],
    [
      turn(1, "0001", { total: 100 }),
      event(2, "provider.cancelled", "0001"),
      turn(3, "0002", { total: 180 }),
    ],
  );
  const metrics = sessionMetrics(workspace, "cancel", { fake: provider });
  const executions = metrics.executions as Array<Record<string, unknown>>;
  const totals = metrics.totals as Record<string, unknown>;
  expect((executions[1]?.usage as TurnUsage).input_tokens).toBe(80);
  expect(executions[0]?.uncaptured_turns).toBe(1);
  expect(totals.uncaptured_turns).toBe(1);
  expect(totals.turns).toBe(2);
});

test("cost totals keep the known sum and count the gap", () => {
  const workspace = tempDir("migent-metrics-");
  const priced = new FakeProvider();
  priced.normalizeUsage = () => ({ ...blank(), input_tokens: 10, cost_usd: 1.5 });
  const free = new FakeProvider();
  free.normalizeUsage = () => ({ ...blank(), input_tokens: 4 });
  writeSession(
    workspace,
    "mix",
    { workflow_id: "agent", status: "completed", updated_at: at(2) },
    [
      { id: "0001", order: 1, stage: "agent", status: "completed", provider: "priced" },
      { id: "0002", order: 2, stage: "agent", status: "completed", provider: "free" },
    ],
    [turn(1, "0001", { ok: true }, "priced"), turn(2, "0002", { ok: true }, "free")],
  );
  const totals = sessionMetrics(workspace, "mix", { priced, free }).totals as {
    usage: TurnUsage;
    usage_missing: Record<string, number>;
  };
  expect(totals.usage.cost_usd).toBe(1.5);
  expect(totals.usage.input_tokens).toBe(14);
  expect(totals.usage_missing.cost_usd).toBe(1);
  expect(totals.usage_missing.input_tokens).toBe(0);
});

test("a progress turn_failed does not count as a turn", () => {
  const workspace = tempDir("migent-metrics-");
  writeSession(
    workspace,
    "dup",
    { workflow_id: "agent", status: "completed", updated_at: at(1) },
    [{ id: "0001", order: 1, stage: "agent", status: "completed" }],
    [
      event(1, "provider.turn_failed", "0001", { details: { summary: "boom" } }),
      turn(2, "0001", null),
    ],
  );
  const totals = sessionMetrics(workspace, "dup", { fake: new FakeProvider() }).totals as Record<string, unknown>;
  expect(totals.turns).toBe(1);
  expect(totals.uncaptured_turns).toBe(1);
});

test("a session recorded before usage captures still has a row", () => {
  const workspace = workspaceWith("once.yaml", ONCE);
  writeSession(
    workspace,
    "old",
    {
      workflow_id: "once",
      workflow_path: ".migent/workflows/once.yaml",
      status: "completed",
      updated_at: at(1),
      created_at: at(0),
    },
    [{ id: "0001", order: 1, stage: "implement", status: "completed", createdAt: at(0), completedAt: at(10) }],
    [event(1, "provider.turn_completed", "0001")],
  );
  const metrics = sessionMetrics(workspace, "old", { fake: new FakeProvider() });
  const totals = metrics.totals as { turns: number; wall_seconds: number; usage: TurnUsage; usage_missing: Record<string, number> };
  expect(totals.turns).toBe(1);
  expect(totals.wall_seconds).toBe(10);
  expect(totals.usage).toEqual(blank());
  expect(totals.usage_missing).toEqual({
    input_tokens: 1,
    output_tokens: 1,
    reasoning_tokens: 1,
    cache_read_tokens: 1,
    cache_write_tokens: 1,
    cost_usd: 1,
  });
  expect(metrics).toHaveProperty("executions");
  expect(metrics).toHaveProperty("stages");
  expect((metrics.totals as Record<string, unknown>).revisions).toBe(0);
});

test("a missing workflow leaves revisions null", () => {
  const workspace = tempDir("migent-metrics-");
  writeSession(
    workspace,
    "gone",
    { workflow_id: "plan", workflow_path: ".migent/workflows/missing.yaml", status: "completed", updated_at: at(1) },
    [{ id: "0001", order: 1, stage: "plan", status: "completed", createdAt: at(0), completedAt: at(10) }],
    [event(1, "session.created", null, { data: { hash: "abc" } })],
  );
  const metrics = sessionMetrics(workspace, "gone", {});
  expect(metrics.workflow_id).toBe("plan");
  expect((metrics.totals as Record<string, unknown>).revisions).toBeNull();
  expect((metrics.stages as Record<string, Record<string, unknown>>).plan?.revisions).toBeNull();
  expect((metrics.executions as Array<Record<string, unknown>>)[0]?.role).toBeNull();
  expect((metrics.totals as Record<string, unknown>).wall_seconds).toBe(10);
});

test("a running execution has no wall time", () => {
  const workspace = tempDir("migent-metrics-");
  writeSession(
    workspace,
    "run",
    { workflow_id: "agent", status: "active", updated_at: at(1) },
    [{ id: "0001", order: 1, stage: "agent", status: "running", createdAt: at(0), completedAt: null }],
    [],
  );
  const metrics = sessionMetrics(workspace, "run", {});
  const execution = (metrics.executions as Array<Record<string, unknown>>)[0];
  expect(execution?.completed_at).toBeNull();
  expect(execution?.wall_seconds).toBeNull();
  expect((metrics.totals as Record<string, unknown>).wall_seconds).toBeNull();
  expect((metrics.totals as Record<string, unknown>).active_seconds).toBe(0);
});

test("corrupt sessions are a short row and a directory without status is skipped", () => {
  const workspace = tempDir("migent-metrics-");
  const sessions = path.join(workspace, ".migent", "sessions");
  mkdirSync(path.join(sessions, "broken"), { recursive: true });
  writeFileSync(path.join(sessions, "broken", "status.json"), "{");
  writeFileSync(path.join(sessions, "broken", "events.jsonl"), `${JSON.stringify(event(1, "session.created", null))}\n`);
  const badExecution = path.join(sessions, "bad-exec");
  mkdirSync(path.join(badExecution, "executions", "0001"), { recursive: true });
  writeFileSync(
    path.join(badExecution, "status.json"),
    JSON.stringify({ workflow_id: "agent", status: "completed", updated_at: at(3) }),
  );
  writeFileSync(path.join(badExecution, "events.jsonl"), "");
  writeFileSync(path.join(badExecution, "executions", "0001", "execution.json"), "not-json");
  mkdirSync(path.join(sessions, "nostatus"), { recursive: true });
  writeFileSync(path.join(sessions, "nostatus", "events.jsonl"), `${JSON.stringify(event(1, "session.created", null))}\n`);
  writeSession(
    workspace,
    "newer",
    { workflow_id: "agent", status: "completed", updated_at: at(9) },
    [],
    [event(1, "session.created", null)],
  );
  writeSession(
    workspace,
    "older",
    { workflow_id: "other", status: "completed", updated_at: at(1) },
    [],
    [event(1, "session.created", null)],
  );
  expect(sessionMetrics(workspace, "broken", {})).toEqual({ session_id: "broken", status: "corrupt" });
  expect(sessionMetrics(workspace, "bad-exec", {})).toEqual({ session_id: "bad-exec", status: "corrupt" });
  const listed = listSessionMetrics(workspace, {}, { workflow: null, status: null, limit: null });
  expect(listed.map((row) => row.session_id)).toEqual(["newer", "bad-exec", "older", "broken"]);
  expect(listed.some((row) => row.session_id === "nostatus")).toBe(false);
  const filtered = listSessionMetrics(workspace, {}, { workflow: "agent", status: "completed", limit: 1 });
  expect(filtered.map((row) => row.session_id)).toEqual(["newer"]);
});

const SEAL_CONFIG = `\
models:
  fake:
    provider: fake
    model: m1
roles:
  developer:
    default_model: fake
`;

test("a completed session seals metrics and later normalization leaves the file", async () => {
  const workspace = tempDir("migent-metrics-seal-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), SEAL_CONFIG, "utf8");
  writeFileSync(path.join(workspace, ".migent", "workflows", "once.yaml"), ONCE, "utf8");
  const provider = new ScriptedProvider(["status: complete\n\ndone"], ["# notes\n"]);
  provider.captureUsage = () => ({ total: 4 });
  provider.normalizeUsage = () => ({ ...blank(), input_tokens: 4 });
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "once", task: "write notes" },
    new AgentToolRunner({ fake: provider }, 10),
  );
  expect(result.status).toBe("completed");
  const file = sealedMetricsPath(workspace, result.sessionId);
  const sealed = JSON.parse(readFileSync(file, "utf8")) as {
    status: string;
    totals: { usage: TurnUsage };
  };
  expect(sealed.status).toBe("completed");
  expect(sealed.totals.usage.input_tokens).toBe(4);
  expect(readSealedMetrics(workspace, result.sessionId)).toEqual({ state: "ok", metrics: sealed });

  provider.normalizeUsage = () => ({ ...blank(), input_tokens: 99 });
  const derived = sessionMetrics(workspace, result.sessionId, { fake: provider });
  expect((derived.totals as { usage: TurnUsage }).usage.input_tokens).toBe(99);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(sealed);
  expect(listSealedMetrics(workspace, { workflow: "once", status: "completed", limit: null })).toEqual([sealed]);
});

test("an agent session does not seal metrics", async () => {
  const workspace = tempDir("migent-metrics-agent-");
  const sessionId = createAgentSession(workspace, "reviewer", "review the plan");
  const result = await new AgentToolRunner({ fake: new FakeProvider() }, 10).run({
    provider: "fake",
    model: "m1",
    prompt: "review",
    workspace,
    sessionId,
    stageId: "reviewer",
  });
  expect(result.session_status).toBe("completed");
  expect(existsSync(sealedMetricsPath(workspace, sessionId))).toBe(false);
});

test("a blocked session has no sealed metrics and is omitted from the list", async () => {
  const workspace = tempDir("migent-metrics-blocked-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), SEAL_CONFIG, "utf8");
  writeFileSync(path.join(workspace, ".migent", "workflows", "once.yaml"), ONCE, "utf8");
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "once", task: "write notes" },
    new AgentToolRunner({ fake: new ScriptedProvider(["status: blocked\nblocker: gate"]) }, 10),
  );
  expect(result.status).toBe("blocked");
  expect(existsSync(sealedMetricsPath(workspace, result.sessionId))).toBe(false);
  expect(readSealedMetrics(workspace, result.sessionId)).toEqual({ state: "missing" });
  expect(listSealedMetrics(workspace, { workflow: null, status: null, limit: null })).toEqual([]);
});

test("a corrupt metrics file is reported and left in place", () => {
  const workspace = tempDir("migent-metrics-corrupt-");
  const sessions = path.join(workspace, ".migent", "sessions", "kept");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(path.join(sessions, "status.json"), JSON.stringify({ workflow_id: "once", status: "completed", updated_at: at(1) }));
  const file = path.join(sessions, "metrics.json");
  writeFileSync(file, "not-json");
  expect(readSealedMetrics(workspace, "kept")).toEqual({ state: "corrupt" });
  expect(readFileSync(file, "utf8")).toBe("not-json");
  expect(listSealedMetrics(workspace, { workflow: null, status: null, limit: null })).toEqual([]);
});
