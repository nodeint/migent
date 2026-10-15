import { parseStageOutcome } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { ClaudeAdapter, providerCommands } from "../src/index.ts";

function stream(...events: Record<string, unknown>[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

const toolUse = {
  type: "assistant",
  message: {
    content: [
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } },
    ],
  },
  parent_tool_use_id: null,
  session_id: "sess-1",
};

const toolResult = {
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hi" }] },
  parent_tool_use_id: null,
  session_id: "sess-1",
};

test("reads the final result and session id from stream-json", () => {
  const [text, sessionId] = new ClaudeAdapter().parseResponse(
    stream(
      { type: "system", subtype: "init", session_id: "sess-1" },
      toolUse,
      toolResult,
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "status: complete\n\n# Plan" }] },
        parent_tool_use_id: null,
        session_id: "sess-1",
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "status: complete\n\n# Plan",
        session_id: "sess-1",
      },
    ),
    "/tmp/unused",
  );
  expect(text).toBe("status: complete\n\n# Plan");
  expect(sessionId).toBe("sess-1");
  expect(parseStageOutcome(text, true)?.status).toBe("complete");
});

test("falls back to the last assistant text without a result", () => {
  const [text, sessionId] = new ClaudeAdapter().parseResponse(
    stream(
      { type: "system", subtype: "init", session_id: "sess-2" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "status: blocked" }] },
        parent_tool_use_id: null,
        session_id: "sess-2",
      },
    ),
    "/tmp/unused",
  );
  expect(text).toBe("status: blocked");
  expect(sessionId).toBe("sess-2");
});

test("reports a failed result", () => {
  const adapter = new ClaudeAdapter();
  const failed = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["API overloaded"],
    session_id: "sess-3",
  };
  expect(adapter.parseResponse(stream(failed), "/tmp/unused")).toEqual([
    "API overloaded",
    "sess-3",
  ]);
  expect(adapter.parseProgressEvent(JSON.stringify(failed))).toEqual({
    event: "provider.turn_failed",
    summary: "API overloaded",
  });
});

test("reports tool progress", () => {
  const adapter = new ClaudeAdapter();
  expect(adapter.parseProgressEvent(JSON.stringify(toolUse))).toEqual({
    event: "provider.item_started",
    summary: "command started: echo hi",
    details: { item_type: "Bash" },
  });
  expect(adapter.parseProgressEvent(JSON.stringify(toolResult))).toEqual({
    event: "provider.item_completed",
    summary: "command completed: echo hi",
    details: { item_type: "Bash" },
  });
  expect(adapter.parseProgressEvent("not json")).toBeNull();
});

test("lists aliases and effort levels", () => {
  const adapter = new ClaudeAdapter();
  const catalog = adapter.parseModelCatalog("2.1.300 (Claude Code)\n");
  expect(catalog.ids).toContain("opus");
  expect(catalog.ids).toContain("claude-sonnet-5-5");
  expect(catalog.valuesFor("opus", "effort")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(adapter.modelCatalogCommand()).toEqual(["claude", "--version"]);
  expect(() => adapter.parseModelCatalog("command not found")).toThrow(/command not found/);
});

test("rejects an unknown option", () => {
  const adapter = new ClaudeAdapter();
  expect(() => adapter.validateOptions({ temperature: "0.2" })).toThrow(
    /temperature is not a claude option/,
  );
  expect(() => adapter.validateOptions({ permission_mode: "yolo" })).toThrow(
    /permission_mode must be one of/,
  );
  expect(() => adapter.validateOptions({ max_budget_usd: "-1" })).toThrow(/max_budget_usd/);
  adapter.validateOptions({ effort: "high", max_budget_usd: "2.5" });
});

test("maps options onto claude flags", () => {
  const adapter = new ClaudeAdapter();
  const newSession = adapter.createNewSession();
  expect(newSession.agentId).toMatch(/^[0-9a-f-]{36}$/);
  const spec = adapter.buildCommand({
    model: "opus",
    workspace: "/work",
    prompt: "prompt",
    agentId: null,
    newAgentId: "11111111-2222-3333-4444-555555555555",
    promptFile: "/tmp/prompt.txt",
    lastMessageFile: "/tmp/last.txt",
    options: { effort: "high", allowed_tools: "Bash Edit" },
  });
  expect(providerCommands().claude).toBe(adapter.command);
  expect(spec.argv).toEqual([
    "claude",
    "-p",
    "--model",
    "opus",
    "--output-format",
    "stream-json",
    "--verbose",
    "--effort",
    "high",
    "--allowed-tools",
    "Bash Edit",
    "--permission-mode",
    "bypassPermissions",
    "--session-id",
    "11111111-2222-3333-4444-555555555555",
  ]);
  expect(spec.stdin).toBe("prompt");
  const resumed = adapter.buildCommand({
    model: "opus",
    workspace: "/work",
    prompt: "again",
    agentId: "sess-1",
    newAgentId: null,
    promptFile: "/tmp/prompt.txt",
    lastMessageFile: "/tmp/last.txt",
    options: { permission_mode: "acceptEdits" },
  });
  expect(resumed.argv.slice(-4)).toEqual(["--permission-mode", "acceptEdits", "--resume", "sess-1"]);
});
