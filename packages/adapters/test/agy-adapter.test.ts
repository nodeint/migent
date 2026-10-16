import { parseStageOutcome } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { AgyAdapter, providerCommands } from "../src/index.ts";

function stream(...events: Record<string, unknown>[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

const toolActive = {
  event: "step_update",
  conversation_id: "conv-1",
  step_update: {
    conversation_id: "conv-1",
    step_index: 4,
    state: "ACTIVE",
    step_type: "tool",
    tool_name: "run_command",
    tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" } },
  },
};

const toolDone = {
  event: "step_update",
  conversation_id: "conv-1",
  step_update: {
    conversation_id: "conv-1",
    step_index: 4,
    state: "DONE",
    step_type: "tool",
    tool_name: "run_command",
    tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" }, output: "hi\n" },
  },
};

test("reads the final result and conversation id from stream-json", () => {
  const [text, sessionId] = new AgyAdapter().parseResponse(
    stream(
      { event: "init", conversation_id: "conv-1", init: { cwd: "/work" } },
      toolActive,
      toolDone,
      {
        event: "step_update",
        step_update: { step_index: 5, state: "DONE", step_type: "agent_response", text_delta: "draft" },
      },
      {
        event: "result",
        result: {
          conversation_id: "conv-1",
          status: "SUCCESS",
          response: "status: complete\n\n# Plan\n",
        },
      },
    ),
    "/tmp/unused",
  );
  expect(text).toBe("status: complete\n\n# Plan");
  expect(sessionId).toBe("conv-1");
  expect(parseStageOutcome(text, true)?.status).toBe("complete");
});

test("reports a failed result", () => {
  const adapter = new AgyAdapter();
  const failed = {
    event: "result",
    result: {
      conversation_id: "",
      status: "ERROR",
      response: "",
      error: "invalid model selection",
    },
  };
  expect(adapter.parseResponse(stream(failed), "/tmp/unused")).toEqual([
    "invalid model selection",
    null,
  ]);
  expect(adapter.parseProgressEvent(JSON.stringify(failed))).toEqual({
    event: "provider.turn_failed",
    summary: "invalid model selection",
  });
});

test("reads a single json envelope", () => {
  const [text, sessionId] = new AgyAdapter().parseResponse(
    JSON.stringify({
      conversation_id: "conv-2",
      status: "SUCCESS",
      response: "status: blocked\n",
    }),
    "/tmp/unused",
  );
  expect(text).toBe("status: blocked");
  expect(sessionId).toBe("conv-2");
});

test("reports tool progress", () => {
  const adapter = new AgyAdapter();
  expect(adapter.parseProgressEvent(JSON.stringify(toolActive))).toEqual({
    event: "provider.item_started",
    summary: "command started: echo hi",
    details: { item_type: "run_command" },
  });
  expect(adapter.parseProgressEvent(JSON.stringify(toolDone))).toEqual({
    event: "provider.item_completed",
    summary: "command completed: echo hi",
    details: { item_type: "run_command" },
  });
  expect(adapter.parseProgressEvent("not json")).toBeNull();
  expect(adapter.parseProgressEvent(JSON.stringify({ event: "init", conversation_id: "conv-1" }))).toBeNull();
});

test("marks a finished tool failed when tool_info has an error", () => {
  const adapter = new AgyAdapter();
  const failed = {
    event: "step_update",
    step_update: {
      step_index: 2,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "false" },
        error: { type: "exit", message: "exit 1" },
      },
    },
  };
  expect(adapter.parseProgressEvent(JSON.stringify(failed))).toEqual({
    event: "provider.item_completed",
    summary: "command failed: false",
    details: { item_type: "run_command" },
  });
});

test("lists model slugs and effort levels", () => {
  const adapter = new AgyAdapter();
  const catalog = adapter.parseModelCatalog(
    "Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-3.8-flash-high  Gemini 3.8 Flash (High)\n",
  );
  expect(catalog.ids).toEqual(["gemini-3.8-flash-low", "gemini-3.8-flash-high"]);
  expect(catalog.defaultId).toBeNull();
  expect(catalog.valuesFor("gemini-3.8-flash-low", "effort")).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  expect(adapter.modelCatalogCommand()).toEqual(["agy", "models"]);
  expect(adapter.optionValuesCommand("effort", "gemini-3.8-flash-low")).toEqual(["agy", "models"]);
  expect(adapter.optionValuesCommand("mode", "gemini-3.8-flash-low")).toBeNull();
  expect(() => adapter.parseModelCatalog("Fetching available models...\n")).toThrow(/empty/);
});

test("rejects an unknown option", () => {
  const adapter = new AgyAdapter();
  expect(() => adapter.validateOptions({ temperature: "0.2" })).toThrow(/temperature is not an agy option/);
  expect(() => adapter.validateOptions({ mode: "yolo" })).toThrow(/mode must be one of/);
  expect(() => adapter.validateOptions({ effort: "turbo" })).toThrow(/effort must be one of/);
  expect(() => adapter.validateOptions({ sandbox: "yes" })).toThrow(/sandbox must be true or false/);
  adapter.validateOptions({ effort: "high", mode: "plan", sandbox: "true", skip_permissions: "false" });
});

test("maps a prompt onto a stream-json agy command", () => {
  const adapter = new AgyAdapter();
  expect(adapter.createNewSession()).toEqual({});
  expect(adapter.profileOptions({ effort: "high", mode: "plan" })).toEqual({ effort: "high" });
  const spec = adapter.buildCommand({
    model: "gemini-3.8-flash-low",
    workspace: "/work",
    prompt: "status: complete\n\n# Plan",
    agentId: null,
    newAgentId: null,
    promptFile: "/tmp/prompt.txt",
    lastMessageFile: "/tmp/last.txt",
    options: { effort: "high", mode: "accept-edits", agent: "reviewer" },
  });
  expect(providerCommands().agy).toBe(adapter.command);
  expect(spec.argv).toEqual([
    "agy",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--model",
    "gemini-3.8-flash-low",
    "--add-dir",
    "/work",
    "--disable-slash-commands",
    "--dangerously-skip-permissions",
    "--effort",
    "high",
    "--mode",
    "accept-edits",
    "--agent",
    "reviewer",
  ]);
  expect(JSON.parse(spec.stdin ?? "")).toEqual({
    event: "user",
    message: { content: "status: complete\n\n# Plan" },
  });
  const resumed = adapter.buildCommand({
    model: "gemini-3.8-flash-low",
    workspace: "/work",
    prompt: "again",
    agentId: "conv-1",
    newAgentId: null,
    promptFile: "/tmp/prompt.txt",
    lastMessageFile: "/tmp/last.txt",
    options: { skip_permissions: "false", sandbox: "true" },
  });
  expect(resumed.argv).not.toContain("--dangerously-skip-permissions");
  expect(resumed.argv.slice(-3)).toEqual(["--sandbox", "--conversation", "conv-1"]);
});
