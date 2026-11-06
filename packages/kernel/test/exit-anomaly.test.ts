import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { ClaudeProvider } from "../../adapters/src/providers/claude-provider.ts";
import { CodexProvider } from "../../adapters/src/providers/codex-provider.ts";
import {
  AgentToolRunner,
  type FailureClassification,
  type FailureOrigin,
  type ResponseSource,
  createWorkflowSession,
} from "../src/index.ts";
import { ScriptedProvider, tempDir } from "./support.ts";

vi.setConfig({ testTimeout: 60_000 });

const CONFIG = `\
agents:
  fake:
    provider: fake
    model: m1
roles:
  developer:
    agent: fake
`;

interface Turn {
  reply: string;
  artifact?: string | null;
  exit: number;
  origin?: FailureOrigin;
  source?: ResponseSource;
}

/** A provider whose process exits with a scripted code and whose classifier reports a scripted origin. */
class ExitProvider extends ScriptedProvider {
  private readonly turns: Turn[];
  private current: Turn | null = null;

  constructor(turns: Turn[]) {
    super(turns.map((turn) => turn.reply), turns.map((turn) => turn.artifact ?? null));
    this.turns = [...turns];
  }

  override buildCommand(input: Parameters<ScriptedProvider["buildCommand"]>[0]) {
    const spec = super.buildCommand(input);
    this.current = this.turns.shift() ?? null;
    const code = this.current?.exit ?? 0;
    return { argv: [process.execPath, "-e", `process.exit(${code})`] };
  }

  override parseResponse(): [string, string | null, ResponseSource?] {
    const [text, id] = super.parseResponse();
    const source = this.current?.source;
    return source === undefined ? [text, id] : [text, id, source];
  }

  classifyFailure(_stdout: string, exitCode: number): FailureClassification | null {
    if (exitCode === 0) return null;
    return {
      kind: "provider",
      origin: this.current?.origin ?? "exit-only",
      message: `provider message ${exitCode}`,
    };
  }
}

const OK = "status: complete\n\ndone";

function workflowText(verify: string | null = null, ask = false): string {
  return `\
id: wf
stages:
  - id: implement
    role: developer
${ask ? "    ask: human\n" : ""}    produces:
      artifact: notes.md
${verify === null ? "" : `    verify:\n      - ${JSON.stringify(verify)}\n`}  - id: review
    role: developer
    depends_on: [implement]
completion:
  stage: review
`;
}

function setup(workflow: string): { workspace: string; sessionId: string } {
  const workspace = tempDir("migent-anomaly-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), CONFIG, "utf8");
  writeFileSync(path.join(workspace, ".migent", "workflows", "wf.yaml"), workflow, "utf8");
  return { workspace, sessionId: createWorkflowSession(workspace, "wf", "task") };
}

async function runStage(provider: ExitProvider, workspace: string, sessionId: string, extra = {}) {
  const runner = new AgentToolRunner({ fake: provider }, 10);
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

function events(workspace: string, sessionId: string): Array<Record<string, unknown>> {
  const text = readFileSync(path.join(workspace, ".migent", "sessions", sessionId, "events.jsonl"), "utf8");
  return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function named(list: Array<Record<string, unknown>>, kind: string): Array<Record<string, unknown>> {
  return list.filter((item) => item.event === kind);
}

function details(item: Record<string, unknown> | undefined): Record<string, unknown> {
  return (item?.details ?? {}) as Record<string, unknown>;
}

function execution(workspace: string, sessionId: string, executionId: string): Record<string, unknown> {
  const file = path.join(workspace, ".migent", "sessions", sessionId, "executions", executionId, "execution.json");
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function responseFile(artifactDirectory: string): string {
  return path.join(artifactDirectory, "..", "response.md");
}

test("AC1/AC7: an exit-1 turn with a valid reply and artifact is completed and logged once", async () => {
  const { workspace, sessionId } = setup(workflowText());
  const provider = new ExitProvider([{ reply: OK, artifact: "# notes\n", exit: 1, source: "model" }]);
  const result = await runStage(provider, workspace, sessionId);
  expect(result.execution_status).toBe("completed");
  expect(result.failure_reason).toBe("");
  expect(result.failure_kind).toBe("");
  expect(result.reset_at).toBe("");
  expect(readFileSync(responseFile(result.artifact_directory), "utf8")).toContain("done");
  const list = events(workspace, sessionId);
  expect(named(list, "provider.turn_completed")).toHaveLength(1);
  expect(named(list, "provider.turn_failed")).toHaveLength(0);
  const anomalies = named(list, "provider.exit_anomaly");
  expect(anomalies).toHaveLength(1);
  expect(details(anomalies[0])).toMatchObject({
    turn: 1, exit_code: 1, signal: null, origin: "exit-only", accepted: true, reason: null,
  });
  expect(existsSync(path.join(result.artifact_directory, "notes.md"))).toBe(true);
});

test("AC2: a provider error with a reply persists nothing and logs no anomaly", async () => {
  const { workspace, sessionId } = setup(workflowText());
  const provider = new ExitProvider([
    { reply: OK, artifact: "# notes\n", exit: 1, origin: "provider-error", source: "model" },
  ]);
  const result = await runStage(provider, workspace, sessionId);
  expect(result.execution_status).toBe("failed");
  expect(existsSync(responseFile(result.artifact_directory))).toBe(false);
  const list = events(workspace, sessionId);
  expect(named(list, "provider.turn_failed")).toHaveLength(1);
  expect(named(list, "provider.exit_anomaly")).toHaveLength(0);
});

test("AC3: an exit-1 reply with no outcome fails with the model text and is logged as rejected", async () => {
  const { workspace, sessionId } = setup(workflowText());
  const text = "I finished but forgot the header";
  const provider = new ExitProvider([{ reply: text, exit: 1, source: "model" }]);
  const result = await runStage(provider, workspace, sessionId);
  expect(result.execution_status).toBe("failed");
  const record = execution(workspace, sessionId, result.execution_id);
  expect(record.error).toBe(text);
  expect(readFileSync(responseFile(result.artifact_directory), "utf8")).toContain(text);
  const list = events(workspace, sessionId);
  expect(named(list, "provider.turn_failed")).toHaveLength(1);
  const anomaly = details(named(list, "provider.exit_anomaly")[0]);
  expect(anomaly.accepted).toBe(false);
  expect(typeof anomaly.reason).toBe("string");
});

test("AC3: an exit-only turn whose text is not model output fails with that text and no response", async () => {
  const { workspace, sessionId } = setup(workflowText());
  const provider = new ExitProvider([{ reply: "segfault", exit: 2, source: "error" }]);
  const result = await runStage(provider, workspace, sessionId);
  expect(result.execution_status).toBe("failed");
  expect(execution(workspace, sessionId, result.execution_id).error).toBe("segfault");
  expect(existsSync(responseFile(result.artifact_directory))).toBe(false);
  expect(details(named(events(workspace, sessionId), "provider.exit_anomaly")[0]).accepted).toBe(false);
});

test("a provider that does not attest its source is never accepted after a failed exit", async () => {
  const { workspace, sessionId } = setup(workflowText());
  const provider = new ExitProvider([{ reply: OK, artifact: "# notes\n", exit: 1 }]);
  const result = await runStage(provider, workspace, sessionId);
  expect(result.execution_status).toBe("failed");
  expect(existsSync(responseFile(result.artifact_directory))).toBe(false);
});

test("AC4: a complete reply with a missing artifact is rejected", async () => {
  const { workspace, sessionId } = setup(workflowText());
  const provider = new ExitProvider([{ reply: OK, artifact: null, exit: 1, source: "model" }]);
  const result = await runStage(provider, workspace, sessionId);
  expect(result.execution_status).toBe("failed");
  const anomaly = details(named(events(workspace, sessionId), "provider.exit_anomaly")[0]);
  expect(anomaly.accepted).toBe(false);
  expect(String(anomaly.reason)).toContain("notes.md");
});

test("AC4: an exit-only blocked reply is accepted like an exit-0 one", async () => {
  const { workspace, sessionId } = setup(workflowText());
  const provider = new ExitProvider([
    { reply: "status: blocked\nblocker: missing design", exit: 1, source: "model" },
  ]);
  const result = await runStage(provider, workspace, sessionId);
  expect(result.outcome_status).toBe("blocked");
  expect(result.execution_status).toBe("completed");
  expect(details(named(events(workspace, sessionId), "provider.exit_anomaly")[0]).accepted).toBe(true);
});

test("AC4: an unusable question file after an exit-only turn gets the single correction turn", async () => {
  const { workspace, sessionId } = setup(workflowText(null, true));
  const bad = "status: question\n\nasking\n<<FILE>>not json";
  const provider = new ExitProvider([
    { reply: bad, exit: 1, source: "model" },
    { reply: bad, exit: 0, source: "model" },
  ]);
  const result = await runStage(provider, workspace, sessionId);
  expect(provider.calls).toHaveLength(2);
  expect(result.failure_reason).toBe("question_file_invalid");
  const anomalies = named(events(workspace, sessionId), "provider.exit_anomaly");
  expect(anomalies).toHaveLength(1);
  expect(details(anomalies[0]).accepted).toBe(true);
});

test("AC9: an accepted exit-only turn followed by a red verify keeps one anomaly and one verdict per turn", async () => {
  const workspace0 = tempDir("migent-anomaly-c-");
  const script = path.join(workspace0, "check.cjs");
  const counter = path.join(workspace0, "check.count");
  writeFileSync(
    script,
    `const fs=require("fs");const f=${JSON.stringify(counter)};let n=0;try{n=+fs.readFileSync(f,"utf8")}catch{}
fs.writeFileSync(f,String(n+1));if(n<1){console.error("boom");process.exit(1);}`,
    "utf8",
  );
  const { workspace, sessionId } = setup(workflowText(`"${process.execPath}" "${script}"`));
  const provider = new ExitProvider([
    { reply: OK, artifact: "# notes\n", exit: 1, source: "model" },
    { reply: OK, artifact: null, exit: 0, source: "model" },
  ]);
  const result = await runStage(provider, workspace, sessionId);
  expect(result.execution_status).toBe("completed");
  const list = events(workspace, sessionId);
  expect(named(list, "provider.turn_completed")).toHaveLength(2);
  const anomalies = named(list, "provider.exit_anomaly");
  expect(anomalies).toHaveLength(1);
  expect(details(anomalies[0])).toMatchObject({ turn: 1, accepted: true });
});

test("a signal-like exit code is never accepted on its reply", async () => {
  const { workspace, sessionId } = setup(workflowText());
  const provider = new ExitProvider([{ reply: OK, artifact: "# notes\n", exit: 137, source: "model" }]);
  const result = await runStage(provider, workspace, sessionId);
  expect(result.execution_status).toBe("failed");
  expect(existsSync(responseFile(result.artifact_directory))).toBe(false);
  expect(named(events(workspace, sessionId), "provider.exit_anomaly")).toHaveLength(0);
});

test("a provider that kills itself with a signal is never accepted, end to end", async () => {
  const { workspace, sessionId } = setup(workflowText());
  class Killed extends ExitProvider {
    override buildCommand(input: Parameters<ScriptedProvider["buildCommand"]>[0]) {
      super.buildCommand(input);
      return { argv: [process.execPath, "-e", "process.stdout.write('hi\\n');process.kill(process.pid,'SIGKILL')"] };
    }
  }
  const provider = new Killed([{ reply: OK, artifact: "# notes\n", exit: 1, source: "model" }]);
  const result = await runStage(provider, workspace, sessionId);
  expect(result.execution_status).toBe("failed");
  expect(existsSync(responseFile(result.artifact_directory))).toBe(false);
  expect(named(events(workspace, sessionId), "provider.exit_anomaly")).toHaveLength(0);
});

test("error-sourced text is not persisted even on a clean exit", async () => {
  const { workspace, sessionId } = setup(workflowText());
  const provider = new ExitProvider([{ reply: OK, artifact: "# notes\n", exit: 0, source: "error" }]);
  const result = await runStage(provider, workspace, sessionId);
  expect(existsSync(responseFile(result.artifact_directory))).toBe(false);
});

const SOLO = `\
id: wf
stages:
  - id: implement
    role: developer
  - id: review
    role: developer
    depends_on: [implement]
completion:
  stage: review
`;

test("AC9, real codex: turn.failed yields one turn verdict plus a diagnostic error event", async () => {
  const { workspace, sessionId } = setup(SOLO);
  const fixture = '{"type":"turn.failed","error":{"message":"stream broke"}}\n';
  class FailingCodex extends CodexProvider {
    override buildCommand() {
      return { argv: [process.execPath, "-e", "process.stdout.write(process.argv[1]);process.exit(1)", fixture] };
    }
  }
  const runner = new AgentToolRunner({ fake: new FailingCodex() }, 10);
  const result = await runner.run({ provider: "fake", model: "m1", prompt: "go", workspace, sessionId, stageId: "implement" });
  expect(result.execution_status).toBe("failed");
  const list = events(workspace, sessionId);
  expect(named(list, "provider.turn_failed")).toHaveLength(1);
  expect(typeof details(named(list, "provider.turn_failed")[0]).turn).toBe("number");
  expect(named(list, "provider.error")).toHaveLength(1);
  expect(named(list, "provider.exit_anomaly")).toHaveLength(0);
});

test("AC9, real claude: an exit-1 reply is one completed verdict and one anomaly", async () => {
  const { workspace, sessionId } = setup(SOLO);
  const fixture = '{"type":"result","is_error":false,"result":"status: complete\\n\\ndone","session_id":"s1"}\n';
  class ExitOneClaude extends ClaudeProvider {
    override buildCommand() {
      return { argv: [process.execPath, "-e", "process.stdout.write(process.argv[1]);process.exit(1)", fixture] };
    }
  }
  const runner = new AgentToolRunner({ fake: new ExitOneClaude() }, 10);
  const result = await runner.run({ provider: "fake", model: "m1", prompt: "go", workspace, sessionId, stageId: "implement" });
  expect(result.execution_status).toBe("completed");
  const list = events(workspace, sessionId);
  expect(named(list, "provider.turn_completed")).toHaveLength(1);
  expect(named(list, "provider.turn_failed")).toHaveLength(0);
  expect(named(list, "provider.exit_anomaly")).toHaveLength(1);
});
