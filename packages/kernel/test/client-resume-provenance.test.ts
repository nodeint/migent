import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { AgentToolRunner, SessionStore } from "../src/index.ts";
import { readExecutionClient } from "../src/legacy-provider.ts";
import { readExecutions } from "../src/session-fold.ts";
import { FakeClient, registryOf, tempDir } from "./support.ts";

const ID = "0001-work--attempt-01";

function fixture(commands: string[], status = "failed") {
  const workspace = tempDir("migent-provenance-");
  const directory = path.join(workspace, ".migent", "sessions", "s1");
  const execution = path.join(directory, "executions", ID);
  mkdirSync(execution, { recursive: true });
  writeFileSync(path.join(directory, "manifest.yaml"), "session_id: s1\nworkflow_id: wf\ncreated_at: 2026-11-01T00:00:00Z\nstatus: active\n");
  writeFileSync(path.join(directory, "status.json"), JSON.stringify({ session_id: "s1", workflow_id: "wf", status: status === "cancelled" ? "cancelled" : "active" }));
  const metadata = { schema_version: 1, execution_id: ID, execution_order: 1, stage_id: "work", stage_attempt: 1, provider: "codex", model: "m1", options: {}, agent_id: "native-latest", status, completed_at: "2026-11-01T00:00:01Z" };
  writeFileSync(path.join(execution, "execution.json"), JSON.stringify(metadata));
  writeFileSync(path.join(execution, "conversation.json"), JSON.stringify({ provider: "codex", model: "m1", options: {}, agent_id: "native-latest", history: [] }));
  writeFileSync(path.join(directory, "events.jsonl"), commands.map((command, index) => JSON.stringify({ v: 2, seq: index + 1, event: "provider.turn_completed", execution_id: ID, stage_id: "work", provider: "codex", details: { turn: index + 1, argv: [command], agent_id: "native-latest" } })).join("\n") + "\n");
  return { workspace, directory, execution, metadata };
}

function snapshot(directory: string): Record<string, string> {
  return Object.fromEntries(readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(directory, file), readFileSync(file, "utf8")];
    }));
}

test.each([
  { commands: [], requested: "opencode", frozen: false, reason: /no execution record/ },
  { commands: ["opencode", "codex"], requested: "opencode", frozen: false, reason: /conflicting CLIs/ },
  { commands: ["opencode"], requested: "codex", frozen: false, reason: /different client/ },
  { commands: ["opencode"], requested: "opencode", frozen: true, reason: /frozen target names codex/ },
])("refused resume leaves all session files untouched: $commands/$requested/$frozen", async ({ commands, requested, frozen, reason }) => {
  const { workspace, directory } = fixture(commands);
  const client = new FakeClient();
  try {
    if (frozen) writeFileSync(path.join(directory, "workflow.frozen.yaml"), "source_sha256: null\nworkflow:\n  schema_version: 5\n  id: wf\n  stages:\n    - id: work\n      role: developer\nroles:\n  developer: []\ntargets:\n  work:\n    provider: codex\n    model: m1\n    options: {}\n");
    const before = snapshot(directory);
    const onExecution = vi.fn();
    const runner = new AgentToolRunner(registryOf({ opencode: client, codex: client }));
    await expect(runner.run({ client: requested, model: "m1", prompt: "retry", workspace, sessionId: "s1", stageId: "work", resumeExecutionId: ID, onExecution })).rejects.toThrow(reason);
    expect(snapshot(directory)).toEqual(before);
    expect(onExecution).not.toHaveBeenCalled();
    expect(client.calls).toHaveLength(0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("cancelled batch is validated before reopening any execution", () => {
  const { workspace, directory, execution } = fixture(["opencode"], "cancelled");
  try {
    const second = path.join(directory, "executions", "0002-other--attempt-01");
    mkdirSync(second);
    writeFileSync(path.join(second, "execution.json"), JSON.stringify({ provider: "codex", stage_id: "other", execution_order: 2, status: "cancelled", model: "m1" }));
    writeFileSync(path.join(second, "conversation.json"), readFileSync(path.join(execution, "conversation.json")));
    const before = snapshot(directory);
    expect(() => new SessionStore(workspace).reopenCancelledExecutions("s1")).toThrow(/no execution record/);
    expect(snapshot(directory)).toEqual(before);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test.each([
  { commands: ["opencode"], expected: "opencode" },
  { commands: [], expected: null },
  { commands: ["opencode", "codex"], expected: null },
])("legacy client evidence uses every turn: $commands", ({ commands, expected }) => {
  const { workspace, directory, metadata } = fixture(commands);
  try {
    const client = readExecutionClient(directory, ID, metadata).client;
    expect(client).toBe(expected);
    expect(readExecutions(directory)[0]?.client).toBe(client ?? "");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a valid legacy override resumes with its native identity", async () => {
  const { workspace, directory } = fixture(["opencode"]);
  const client = new FakeClient();
  try {
    const runner = new AgentToolRunner(registryOf({ opencode: client }), 10);
    await runner.run({ client: "opencode", model: "m1", prompt: "retry", workspace, sessionId: "s1", stageId: "work", resumeExecutionId: ID });
    expect(client.calls[0]?.agentId).toBe("native-latest");
    expect(existsSync(path.join(directory, "executions", "0002-work--attempt-02", "conversation.json"))).toBe(true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
