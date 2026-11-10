import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import {
  AgentToolRunner,
  type CliRunOutput,
  type FailureOrigin,
  type RawFailure,
  type ResponseSource,
  createWorkflowSession,
} from "../src/index.ts";
import { CommandExecutor } from "../src/command-executor.ts";
import { StreamSummarizer, observeTurn, renderProviderDiagnostics } from "../src/turn-diagnostics.ts";
import { ScriptedClient, tempDir, registryOf } from "./support.ts";

vi.setConfig({ testTimeout: 60_000 });

const PAYLOAD = "TOP-SECRET-PAYLOAD-7731";

interface Turn {
  reply: string;
  artifact?: string | null;
  exit: number;
  origin?: FailureOrigin;
  source?: ResponseSource;
  stderr?: string;
  /** A classification at exit 0, as a provider-reported error. */
  reportedError?: boolean;
}

class DiagProvider extends ScriptedClient {
  private readonly turns: Turn[];
  private current: Turn | null = null;

  constructor(turns: Turn[]) {
    super(turns.map((turn) => turn.reply), turns.map((turn) => turn.artifact ?? null));
    this.turns = [...turns];
  }

  override buildCommand(input: Parameters<ScriptedClient["buildCommand"]>[0]) {
    super.buildCommand(input);
    this.current = this.turns.shift() ?? null;
    const turn = this.current;
    const script = [
      `console.log(JSON.stringify({type:"text",text:${JSON.stringify(PAYLOAD)}}));`,
      `console.log(JSON.stringify({type:"result"}));`,
      `console.log("plain line");`,
      turn?.stderr ? `process.stderr.write(${JSON.stringify(turn.stderr)});` : "",
      `process.exit(${turn?.exit ?? 0});`,
    ].join("");
    return { argv: [process.execPath, "-e", script] };
  }

  override parseRun(_stdout: string): CliRunOutput {
    const [text, sessionId] = this.parseResponse();
    return { text, sessionId, source: this.current?.source ?? "none" };
  }

  eventLabel(line: string): string | null {
    try {
      const payload = JSON.parse(line) as { type?: string };
      return payload.type ?? null;
    } catch {
      return null;
    }
  }

  override extractFailure(_stdout: string, exitCode: number): RawFailure | null {
    if (exitCode === 0 && this.current?.reportedError !== true) return null;
    return {
      origin: this.current?.reportedError ? "provider-error" : (this.current?.origin ?? "exit-only"),
      message: `provider message ${exitCode}`,
      exitCode,
    };
  }
}

const OK = "status: complete\n\ndone";

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

function workflowText(ask = false): string {
  return `\
id: wf
stages:
  - id: implement
    role: developer
${ask ? "    ask: human\n" : ""}    produces:
      artifact: notes.md
  - id: review
    role: developer
    depends_on: [implement]
completion:
  stage: review
`;
}

function setup(ask = false): { workspace: string; sessionId: string } {
  const workspace = tempDir("migent-turn-diag-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), CONFIG, "utf8");
  writeFileSync(path.join(workspace, ".migent", "workflows", "wf.yaml"), workflowText(ask), "utf8");
  return { workspace, sessionId: createWorkflowSession(workspace, "wf", "task") };
}

async function run(provider: DiagProvider, workspace: string, sessionId: string) {
  return new AgentToolRunner(registryOf({ fake: provider }), 10).run({
    client: "fake", model: "m1", prompt: "go", workspace, sessionId, stageId: "implement",
  });
}

function executionDir(workspace: string, sessionId: string, executionId: string): string {
  return path.join(workspace, ".migent", "sessions", sessionId, "executions", executionId);
}

function diagnostics(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(dir, "diagnostics.json"), "utf8")) as Record<string, any>;
}

test("a non-zero exit with empty stderr still yields a process failure, with counts", async () => {
  const result = await new CommandExecutor(10).run(
    { argv: [process.execPath, "-e", "console.log('a'); console.log('bb'); process.exit(5)"] },
    process.cwd(),
  );
  expect(result.failure?.kind).toBe("provider-exit");
  expect(result.failure?.stderrTail).toBe("");
  expect(result.failure?.exitCode).toBe(5);
  expect(result.process).toMatchObject({ stdoutBytes: 5, stdoutLines: 2, drain: "closed", stderrTotalBytes: 0 });
});

test.skipIf(process.platform === "win32")("a provider killed by a signal keeps its signal identity", async () => {
  const result = await new CommandExecutor(10).run(
    { argv: [process.execPath, "-e", "process.kill(process.pid, 'SIGKILL')"] },
    process.cwd(),
  );
  expect(result.exitCode).toBe(137);
  expect(result.failure?.signal).toBe("SIGKILL");
  expect(result.process?.signal).toBe("SIGKILL");
});

test("a plain exit 137 is not recorded as a signal", async () => {
  const result = await new CommandExecutor(10).run(
    { argv: [process.execPath, "-e", "process.exit(137)"] },
    process.cwd(),
  );
  expect(result.exitCode).toBe(137);
  expect(result.failure?.signal).toBeNull();
  expect(result.process?.signal).toBeNull();
});

test("stderr written just before exit is read after close, with total and tail sizes", async () => {
  const big = "x".repeat(20_000);
  const result = await new CommandExecutor(10).run(
    { argv: [process.execPath, "-e", `process.stderr.write(${JSON.stringify(big)}); process.stderr.write("LAST\\n"); process.exit(3)`] },
    process.cwd(),
  );
  expect(result.failure?.stderrTail.endsWith("LAST\n")).toBe(true);
  expect(result.failure?.stderrTotalBytes).toBe(20_005);
  expect(result.failure?.stderrTail.length).toBeLessThan(20_005);
  expect(result.failure?.drain).toBe("closed");
});

test("an accepted exit-only turn leaves a record that says accepted", async () => {
  const { workspace, sessionId } = setup();
  const result = await run(new DiagProvider([{ reply: OK, artifact: "# n\n", exit: 1, source: "model" }]), workspace, sessionId);
  expect(result.execution_status).toBe("completed");
  const dir = executionDir(workspace, sessionId, result.execution_id);
  const doc = diagnostics(dir);
  expect(doc.schema_version).toBe(2);
  expect(doc.turn).toBe(1);
  expect(doc.failure).toMatchObject({ kind: "provider-exit", origin: "exit-only", exit_code: 1 });
  expect(doc.stderr_tail).toBe("");
  expect(doc.result_state).toMatchObject({
    turn_verdict: "accepted",
    reason: null,
    observed: {
      reply: { source: "model", status_header: { state: "present", status: "complete" } },
      artifact: { state: "present" },
      response_written: true,
      conversation_turns: 1,
    },
    gates: { outcome: { state: "passed", status: "complete" }, artifact: { state: "passed" } },
  });
  expect(doc.stream_summary).toMatchObject({ lines: 3, non_json_lines: 1, labelled: true, events: { text: 1, result: 1 } });
  expect(JSON.parse(readFileSync(path.join(dir, "execution.json"), "utf8")).final_turn).toBe(1);
});

test("a rejected exit leaves the cause in failure.md and no payload in the record", async () => {
  const { workspace, sessionId } = setup();
  const result = await run(
    new DiagProvider([{ reply: `no header ${PAYLOAD}`, exit: 2, source: "model", stderr: "boom\n" }, { reply: `no header ${PAYLOAD}`, exit: 2, source: "model", stderr: "boom\n" }]),
    workspace,
    sessionId,
  );
  expect(result.execution_status).toBe("failed");
  const dir = executionDir(workspace, sessionId, result.execution_id);
  const raw = readFileSync(path.join(dir, "diagnostics.json"), "utf8");
  expect(raw).not.toContain(PAYLOAD);
  const doc = JSON.parse(raw) as Record<string, any>;
  expect(doc.result_state.turn_verdict).toBe("failed");
  expect(doc.result_state.gates.outcome.state).toBe("failed");
  expect(doc.result_state.observed.reply.status_header).toEqual({ state: "absent" });
  expect(doc.stderr).toMatchObject({ total_bytes: 5, drain: "closed" });
  const report = readFileSync(path.join(dir, "failure.md"), "utf8");
  expect(report).toContain("## Provider failure");
  expect(report).toContain("diagnostics.json");
});

test("a provider error at exit 0 is recorded, with the contradiction visible", async () => {
  const { workspace, sessionId } = setup();
  const result = await run(
    new DiagProvider([{ reply: OK, artifact: "# n\n", exit: 0, source: "model", reportedError: true }]),
    workspace,
    sessionId,
  );
  expect(result.execution_status).toBe("failed");
  const dir = executionDir(workspace, sessionId, result.execution_id);
  const doc = diagnostics(dir);
  expect(doc.failure).toMatchObject({ kind: "provider-error", origin: "provider-error", exit_code: 0 });
  expect(doc.result_state.turn_verdict).toBe("failed");
  expect(doc.result_state.gates.outcome).toEqual({ state: "not-evaluated" });
  expect(doc.result_state.observed.reply.status_header).toEqual({ state: "present", status: "complete" });
  expect(doc.result_state.observed.artifact.state).toBe("present");
  expect(doc.result_state.observed.response_written).toBe(false);
  expect(doc.stream_summary.error_messages).toEqual(["provider message 0"]);
  expect(readFileSync(path.join(dir, "failure.md"), "utf8")).toContain("likely finished");
});

test("a clean exit-0 turn leaves no diagnostics", async () => {
  const { workspace, sessionId } = setup();
  const result = await run(new DiagProvider([{ reply: OK, artifact: "# n\n", exit: 0, source: "model" }]), workspace, sessionId);
  expect(existsSync(path.join(executionDir(workspace, sessionId, result.execution_id), "diagnostics.json"))).toBe(false);
});

test("an accepted anomaly followed by a failing correction turn is an earlier anomaly, not the cause", async () => {
  const { workspace, sessionId } = setup(true);
  const bad = "status: question\n\nasking\n<<FILE>>not json";
  const result = await run(
    new DiagProvider([
      { reply: bad, exit: 1, source: "model" },
      { reply: bad, exit: 0, source: "model" },
    ]),
    workspace,
    sessionId,
  );
  expect(result.failure_reason).toBe("question_file_invalid");
  const dir = executionDir(workspace, sessionId, result.execution_id);
  expect(JSON.parse(readFileSync(path.join(dir, "execution.json"), "utf8")).final_turn).toBe(2);
  expect(diagnostics(dir).turn).toBe(1);
  const report = readFileSync(path.join(dir, "failure.md"), "utf8");
  expect(report).toContain("## Earlier provider anomaly");
  expect(report).toContain("not the cause");
});

test("a later abnormal turn replaces the record and is rendered as the cause", async () => {
  const { workspace, sessionId } = setup(true);
  const bad = "status: question\n\nasking\n<<FILE>>not json";
  const result = await run(
    new DiagProvider([
      { reply: bad, exit: 1, source: "model" },
      { reply: "crash", exit: 9, source: "error" },
    ]),
    workspace,
    sessionId,
  );
  const dir = executionDir(workspace, sessionId, result.execution_id);
  expect(diagnostics(dir).turn).toBe(2);
  expect(readFileSync(path.join(dir, "failure.md"), "utf8")).toContain("## Provider failure");
});

test("without a recorded final turn the relation is stated as unknown", () => {
  const lines = renderProviderDiagnostics({
    diagnostics: { turn: 1, failure: { origin: "exit-only" }, result_state: { turn_verdict: "failed" } },
    finalTurn: null,
    failureReason: null,
    link: "diagnostics.json",
  }).join("\n");
  expect(lines).toContain("## Provider diagnostics");
  expect(lines).toContain("unknown");
  expect(lines).not.toContain("not the cause");
});

test("the stream summary caps labels and never keeps free text", () => {
  const summary = new StreamSummarizer(true);
  summary.add("{}", "text with spaces and payload");
  for (let index = 0; index < 60; index += 1) summary.add("{}", `kind${index}`);
  const out = summary.finish({ bytes: 10, lines: 61 }, ["x".repeat(1000)]);
  expect(Object.keys(out.events).length).toBeLessThanOrEqual(33);
  expect(out.events.other).toBeGreaterThan(0);
  expect(out.last_events).toHaveLength(10);
  expect(out.error_messages[0]?.length).toBeLessThanOrEqual(300);
});

test("observing a turn does not copy an unknown status token", () => {
  const observed = observeTurn({
    source: "model",
    responseText: `status: ${PAYLOAD}\n\nbody`,
    artifactPath: null,
    responseWritten: false,
    conversationTurns: 0,
  });
  expect(observed.reply.status_header).toEqual({ state: "invalid" });
  expect(observed.artifact).toEqual({ state: "not-applicable" });
});
