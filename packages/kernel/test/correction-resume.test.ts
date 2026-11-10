import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { BuildCommandInput } from "../src/cli-client.ts";
import { AgentToolRunner, createWorkflowSession, executeNamedWorkflow, raiseCancellation } from "../src/index.ts";
import type { CommandSpec } from "../src/command-executor.ts";
import { ScriptedClient, tempDir, registryOf } from "./support.ts";

class HangFirstProvider extends ScriptedClient {
  private hung = false;
  constructor(private readonly pidFile: string, responses: string[]) { super(responses); }

  override buildCommand(input: BuildCommandInput): CommandSpec {
    if (this.hung) return super.buildCommand(input);
    this.hung = true;
    this.calls.push({
      model: input.model, workspace: input.workspace, prompt: input.prompt, agentId: input.agentId,
      newAgentId: input.newAgentId, promptFile: input.promptFile, options: { ...input.options },
    });
    const code = `require("fs").writeFileSync(${JSON.stringify(this.pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    return { argv: [process.execPath, "-e", code] };
  }
}

/** Run a stage with a required artifact, cancel its first provider turn, and return the reopened execution. */
async function cancelledStage(responses: string[], protocol = 2) {
  const root = tempDir("migent-question-resume-");
  const pidFile = path.join(root, "pid");
  const workspace = tempDir("migent-question-ws-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), [
    "schema_version: 7", "roles:", "  planner:", "    agent: { client: { type: fake }, model: fake }", "",
  ].join("\n"));
  writeFileSync(path.join(workspace, ".migent", "workflows", "wf.yaml"), [
    "schema_version: 7", "id: wf", "artifacts:", "  plan: { file: plan.md }", "stages:", "  - { id: plan, role: planner, artifacts: [plan] }", "",
  ].join("\n"));
  const sessionId = createWorkflowSession(workspace, "wf", "Finish the notes");
  const provider = new HangFirstProvider(pidFile, responses);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  // An authentic conversation: the first prompt and history are rendered under the requested protocol.
  runner.newConversationProtocol = protocol;
  const timer = setInterval(() => {
    if (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "") return;
    clearInterval(timer);
    try { raiseCancellation(15); } catch { /* waiters were woken */ }
  }, 50);
  const first = await executeNamedWorkflow(workspace, { workflowId: "wf", sessionId }, runner);
  clearInterval(timer);
  expect(first.status).toBe("cancelled");
  const directory = path.join(workspace, ".migent", "sessions", sessionId, "executions");
  const executionDirectory = path.join(directory, readdirSync(directory)[0]!);
  const resume = () => executeNamedWorkflow(workspace, { workflowId: "wf", sessionId, resetRevisions: true }, runner);
  const execution = () => JSON.parse(readFileSync(path.join(executionDirectory, "execution.json"), "utf8")) as Record<string, unknown>;
  const patchExecution = (fields: Record<string, unknown>) => writeFileSync(
    path.join(executionDirectory, "execution.json"), JSON.stringify({ ...execution(), ...fields }),
  );
  /** Pretend the agent answered before the stop: record its response in the history. */
  const saveAssistant = (text: string, requestFile: string | null) => {
    const file = path.join(executionDirectory, "conversation.json");
    const conversation = JSON.parse(readFileSync(file, "utf8")) as { history: unknown[] };
    conversation.history.push({ role: "assistant", content: text });
    writeFileSync(file, JSON.stringify(conversation));
    writeFileSync(path.join(executionDirectory, "response.md"), text);
    if (requestFile !== null) writeFileSync(path.join(executionDirectory, "question-request.json"), requestFile);
  };
  return { provider, resume, execution, patchExecution, saveAssistant, executionDirectory };
}


const COMPLETE = "status: complete\n\nplanned";

test("a saved complete reply with its required artifact absent gets the output correction on resume", async () => {
  const run = await cancelledStage([COMPLETE]);
  run.saveAssistant(COMPLETE, null);
  const result = await run.resume();
  expect(result.code).not.toBe(0);
  expect(run.provider.calls).toHaveLength(2);
  expect(run.provider.calls[1]?.prompt).toContain("## Stage output missing");
  expect(run.execution()).toMatchObject({ status: "failed", failure_reason: "stage_output_missing" });
}, 30_000);

test("a saved reply with a contract violation resumes into the full-contract correction", async () => {
  const run = await cancelledStage([COMPLETE]);
  run.saveAssistant("no header", null);
  await run.resume();
  expect(run.provider.calls[1]?.prompt).toContain("## Invalid response");
  expect(run.provider.calls[1]?.prompt).toContain("## Response contract");
}, 30_000);

test("a queued response correction resumes with the full contract and its recorded turn", async () => {
  const run = await cancelledStage([COMPLETE]);
  const file = path.join(run.executionDirectory, "conversation.json");
  const conversation = JSON.parse(readFileSync(file, "utf8")) as { history: unknown[]; agent_id?: string };
  conversation.history.push({ role: "user", content: "## Invalid response\n\nsend it again" });
  writeFileSync(file, JSON.stringify({ ...conversation, agent_id: "native-session-1" }));
  run.patchExecution({
    response_protocol: 2, turn_kind: "response_correction", pending_turn: 2,
    corrections: { response_contract: { turn: 1, error_kind: "contract", error_detail: "no header" } },
  });
  await run.resume();
  const prompt = run.provider.calls[1]?.prompt ?? "";
  expect(prompt).toContain("## Response contract");
  expect(prompt).not.toContain("Finish the notes");
}, 30_000);

test("an empty reply that spent the correction does not grant a second one after resume", async () => {
  const run = await cancelledStage(["", ""]);
  const file = path.join(run.executionDirectory, "conversation.json");
  const conversation = JSON.parse(readFileSync(file, "utf8")) as { history: unknown[] };
  conversation.history.push({ role: "user", content: "## Invalid response\n\nsend it again" });
  writeFileSync(file, JSON.stringify(conversation));
  run.patchExecution({
    turn_kind: "response_correction", pending_turn: 2,
    corrections: { response_contract: { turn: 1, error_kind: "contract", error_detail: "empty" } },
  });
  await run.resume();
  // The pending correction runs as turn 2; its failure exhausts the budget with no third turn.
  expect(run.provider.calls[1]?.prompt).toContain("## Invalid response");
  expect(run.provider.calls[1]?.prompt).not.toContain("Finish the notes");
  expect(run.provider.calls).toHaveLength(2);
  expect(run.execution()).toMatchObject({ status: "failed", failure_reason: "response_contract_invalid" });
}, 30_000);

test("cancelling after an invalid correction reply was saved grants no second correction", async () => {
  const run = await cancelledStage(["", ""]);
  const file = path.join(run.executionDirectory, "conversation.json");
  const conversation = JSON.parse(readFileSync(file, "utf8")) as { history: unknown[] };
  // Turn 1 was empty (no history entry); the correction ran as turn 2 and its reply was saved.
  conversation.history.push({ role: "user", content: "## Invalid response\n\nsend it again" });
  conversation.history.push({ role: "assistant", content: "still no header" });
  writeFileSync(file, JSON.stringify(conversation));
  writeFileSync(path.join(run.executionDirectory, "response.md"), "still no header");
  run.patchExecution({
    turn_kind: "response_correction", pending_turn: 2,
    corrections: { response_contract: { turn: 1, error_kind: "contract", error_detail: "empty" } },
  });
  await run.resume();
  expect(run.provider.calls).toHaveLength(1);
  expect(run.execution()).toMatchObject({ status: "failed", failure_reason: "response_contract_invalid" });
}, 30_000);

test("resuming after a verify repair reads the repair turn's outcome, not the correction turn's", async () => {
  const run = await cancelledStage(["", ""]);
  const dir = run.executionDirectory;
  const file = path.join(dir, "conversation.json");
  const conversation = JSON.parse(readFileSync(file, "utf8")) as { history: unknown[] };
  // Turn 1 empty; correction ran as turn 2 (outcome saved); the repair ran as turn 3 and its reply was saved.
  conversation.history.push({ role: "user", content: "## Invalid response\n\nsend it again" });
  conversation.history.push({ role: "assistant", content: "status: complete\ndecision: stale\n\nfirst" });
  conversation.history.push({ role: "user", content: "## Verify failed\n\nfix it" });
  conversation.history.push({ role: "assistant", content: "status: complete\n\nrepaired" });
  writeFileSync(file, JSON.stringify(conversation));
  writeFileSync(path.join(dir, "response.md"), "status: complete\n\nrepaired");
  mkdirSync(path.join(dir, "turns", "02"), { recursive: true });
  writeFileSync(path.join(dir, "turns", "02", "outcome.json"), JSON.stringify({ status: "complete", decision: "stale" }));
  mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  writeFileSync(path.join(dir, "artifacts", "plan.md"), "# Plan\n");
  run.patchExecution({
    turn_kind: "repair", pending_turn: 3,
    corrections: { response_contract: { turn: 1, error_kind: "contract", error_detail: "empty" } },
  });
  await run.resume();
  expect(run.provider.calls).toHaveLength(1);
  expect(run.execution().outcome).toMatchObject({ status: "complete" });
  expect((run.execution().outcome as Record<string, unknown>).decision).toBeUndefined();
}, 30_000);

test("a resumed handoff correction keeps the invalid handoff file for the agent to repair", async () => {
  const run = await cancelledStage(["fixed"], 3);
  const file = path.join(run.executionDirectory, "conversation.json");
  const conversation = JSON.parse(readFileSync(file, "utf8")) as { history: unknown[] };
  conversation.history.push({ role: "user", content: "## Invalid handoff file\n\nrewrite it" });
  writeFileSync(file, JSON.stringify({ ...conversation, agent_id: "native-session-1" }));
  const handoff = path.join(run.executionDirectory, "handoff.json");
  writeFileSync(handoff, "{broken");
  run.patchExecution({
    turn_kind: "handoff_correction", pending_turn: 2,
    corrections: { handoff: { turn: 1, error_kind: "invalid_json", error_detail: "bad" } },
  });
  // The provider sees the file as it is when the correction turn starts.
  let seen: string | null | undefined;
  const build = run.provider.buildCommand.bind(run.provider);
  run.provider.buildCommand = (input) => {
    if (seen === undefined) seen = existsSync(handoff) ? readFileSync(handoff, "utf8") : null;
    return build(input);
  };
  await run.resume();
  expect(seen).toBe("{broken");
}, 30_000);

test("a protocol 3 pending handoff correction resumes with the full protocol 3 contract and grants no second one", async () => {
  const run = await cancelledStage(["not a handoff", "still none"], 3);
  expect(run.execution().response_protocol).toBe(3);
  const file = path.join(run.executionDirectory, "conversation.json");
  const conversation = JSON.parse(readFileSync(file, "utf8")) as { history: unknown[]; agent_id?: string };
  conversation.history.push({ role: "user", content: "## Invalid handoff file\n\nrewrite it" });
  writeFileSync(file, JSON.stringify({ ...conversation, agent_id: "native-session-1" }));
  run.patchExecution({
    turn_kind: "handoff_correction", pending_turn: 2,
    corrections: { handoff: { turn: 1, error_kind: "missing", error_detail: "the file was not written" } },
  });
  await run.resume();
  const prompt = run.provider.calls[1]?.prompt ?? "";
  expect(prompt).toContain("## Response contract\n\nWrite one JSON document");
  expect(prompt).toContain("## Do\n\nRewrite the whole handoff file");
  expect(prompt).not.toContain("Start the response with a status header");
  // The pending correction runs as turn 2; its failure exhausts the budget with no third turn.
  expect(run.provider.calls).toHaveLength(2);
  expect(run.execution()).toMatchObject({ status: "failed", failure_reason: "handoff_file_invalid" });
}, 30_000);

test("a protocol 2 pending response correction resumes with the protocol 2 contract after the default moved to 3", async () => {
  const run = await cancelledStage([COMPLETE]);
  expect(run.execution().response_protocol).toBe(2);
  const file = path.join(run.executionDirectory, "conversation.json");
  const conversation = JSON.parse(readFileSync(file, "utf8")) as { history: unknown[] };
  conversation.history.push({ role: "user", content: "## Invalid response\n\nsend it again" });
  writeFileSync(file, JSON.stringify({ ...conversation, agent_id: "native-session-1" }));
  run.patchExecution({
    turn_kind: "response_correction", pending_turn: 2,
    corrections: { response_contract: { turn: 1, error_kind: "contract", error_detail: "no header" } },
  });
  await run.resume();
  const prompt = run.provider.calls[1]?.prompt ?? "";
  expect(prompt).toContain("## Response contract\n\nStart the response with a status header");
  expect(prompt).toContain("## Invalid response");
  expect(prompt).not.toContain("Write one JSON document");
  expect(prompt).not.toContain("Handoff file");
  expect(run.execution().response_protocol).toBe(2);
}, 30_000);

test("a protocol 2 pending question-file correction resumes with the protocol 2 reminder and keeps the invalid request file", async () => {
  const run = await cancelledStage([COMPLETE]);
  const file = path.join(run.executionDirectory, "conversation.json");
  const conversation = JSON.parse(readFileSync(file, "utf8")) as { history: unknown[] };
  conversation.history.push({ role: "user", content: "## Invalid question file\n\nrewrite it" });
  writeFileSync(file, JSON.stringify({ ...conversation, agent_id: "native-session-1" }));
  const request = path.join(run.executionDirectory, "question-request.json");
  writeFileSync(request, "{broken");
  run.patchExecution({
    turn_kind: "correction", pending_turn: 2,
    corrections: { question_file: { turn: 1, error_kind: "invalid_json", error_detail: "bad" } },
  });
  // Only the first turn after the resume is the correction turn that must still see the file.
  let seen: string | null | undefined;
  const build = run.provider.buildCommand.bind(run.provider);
  run.provider.buildCommand = (input) => {
    if (seen === undefined) seen = existsSync(request) ? readFileSync(request, "utf8") : null;
    return build(input);
  };
  await run.resume();
  expect(seen).toBe("{broken");
  const prompt = run.provider.calls[1]?.prompt ?? "";
  expect(prompt).toContain("Rewrite the whole question file");
  expect(prompt).not.toContain("Write one JSON document");
  expect(prompt).not.toContain("Handoff file");
}, 30_000);
