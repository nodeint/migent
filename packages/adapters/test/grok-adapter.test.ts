import { parseStageOutcome } from "@migent/kernel";
import { expect, test } from "vitest";
import { GrokAdapter, providerCommands } from "../src/index.ts";

function stream(...events: Record<string, unknown>[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

test("keeps text after the last tool event", () => {
  const [text, sessionId] = new GrokAdapter().parseResponse(
    stream(
      { type: "text", data: "I'll load the docs.\n" },
      {
        type: "tool_call",
        toolCallId: "call_1",
        toolName: "read_file",
        rawInput: { path: "README.md" },
      },
      { type: "tool_call_update", toolCallId: "call_1", status: "completed" },
      { type: "text", data: "status: complete\n\n# Plan\n" },
      { type: "end", sessionId: "sess-final" },
    ),
    "/tmp/unused",
  );
  expect(text).toBe("status: complete\n\n# Plan");
  expect(sessionId).toBe("sess-final");
  expect(parseStageOutcome(text, true)?.status).toBe("complete");
});

test("keeps a status header before a later thought segment", () => {
  const [text] = new GrokAdapter().parseResponse(
    stream(
      { type: "text", data: "status: complete\n\n# Plan\n" },
      {
        type: "tool_call",
        toolCallId: "call_1",
        toolName: "read_file",
        rawInput: { path: "README.md" },
      },
      { type: "tool_call_update", toolCallId: "call_1", status: "completed" },
      { type: "text", data: "checking the tree once more" },
      { type: "end", sessionId: "sess-thought" },
    ),
    "/tmp/unused",
  );
  expect(text).toBe("status: complete\n\n# Plan");
  expect(parseStageOutcome(text, true)?.status).toBe("complete");
});

test("trims preamble before a status header", () => {
  const [text] = new GrokAdapter().parseResponse(
    stream(
      { type: "text", data: "I'll write the plan next.\nstatus: complete\n\n# Plan\n" },
      { type: "end", sessionId: "sess-trim" },
    ),
    "/tmp/unused",
  );
  expect(text).toBe("status: complete\n\n# Plan");
});

test("trims a status header glued to preamble", () => {
  const [text] = new GrokAdapter().parseResponse(
    stream(
      { type: "text", data: "Next I'll write the plan.status: complete\n\n# Plan\n" },
      { type: "end", sessionId: "sess-glue" },
    ),
    "/tmp/unused",
  );
  expect(text).toBe("status: complete\n\n# Plan");
  expect(parseStageOutcome(text, true)?.status).toBe("complete");
});

test("reads models from grok models output", () => {
  const catalog = new GrokAdapter().parseModelCatalog(
    "You are logged in with grok.com.\n" +
      "\n" +
      "Default model: grok-4.7\n" +
      "\n" +
      "Available models:\n" +
      "  * grok-4.7 (default)\n" +
      "  - grok-4.6\n",
  );
  expect(catalog.ids).toEqual(["grok-4.7", "grok-4.6"]);
  expect(catalog.valuesFor("grok-4.7", "reasoning-effort")).toBeNull();
  expect(catalog.defaultId).toBe("grok-4.7");
  expect(new GrokAdapter().modelCatalogCommand()).toEqual(["grok", "models"]);
});

test("reads effort values for the selected model", () => {
  const adapter = new GrokAdapter();
  const text =
    "--effort/--reasoning-effort: unknown effort level 'migent-probe'; " +
    "use one of: high, medium, low\n";
  expect(adapter.parseOptionValues("reasoning-effort", text, "grok-4.5")).toEqual([
    "high",
    "medium",
    "low",
  ]);
  expect(adapter.optionValuesCommand("reasoning-effort", "grok-4.5")).toEqual([
    "grok",
    "-m",
    "grok-4.5",
    "--reasoning-effort",
    "migent-probe",
    "-p",
    "x",
    "--output-format",
    "plain",
  ]);
  expect(() => adapter.parseOptionValues("reasoning-effort", "not logged in", "grok-4.5")).toThrow(
    /not logged in/,
  );
});

test("rejects an unknown option", () => {
  const adapter = new GrokAdapter();
  expect(() => adapter.validateOptions({ temperature: "0.2" })).toThrow(
    /temperature is not a grok option/,
  );
  adapter.validateOptions({ "reasoning-effort": "ultra" });
  expect(() => adapter.validateOptions({ max_turns: "0" })).toThrow(/max_turns must be an integer/);
});

test("maps options onto grok flags", () => {
  const spec = new GrokAdapter().buildCommand({
    model: "grok-4",
    workspace: "/work",
    prompt: "prompt",
    agentId: null,
    newAgentId: null,
    promptFile: "/tmp/prompt.txt",
    lastMessageFile: "/tmp/last.txt",
    options: { "reasoning-effort": "medium", max_turns: "4" },
  });
  expect(providerCommands().grok).toBe(new GrokAdapter().command);
  expect(spec.argv).toEqual([
    "grok",
    "--prompt-file",
    "/tmp/prompt.txt",
    "-m",
    "grok-4",
    "--cwd",
    "/work",
    "--output-format",
    "streaming-json",
    "--always-approve",
    "--verbatim",
    "--reasoning-effort",
    "medium",
    "--max-turns",
    "4",
  ]);
});
