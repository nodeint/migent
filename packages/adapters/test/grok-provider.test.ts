import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseStageOutcome } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { GrokProvider, providerCommands } from "../src/index.ts";

function usageFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/usage/${name}`, import.meta.url)), "utf8");
}

function stream(...events: Record<string, unknown>[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

test("keeps text after the last tool event", () => {
  const [text, sessionId] = new GrokProvider().parseResponse(
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
  const [text] = new GrokProvider().parseResponse(
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
  const [text] = new GrokProvider().parseResponse(
    stream(
      { type: "text", data: "I'll write the plan next.\nstatus: complete\n\n# Plan\n" },
      { type: "end", sessionId: "sess-trim" },
    ),
    "/tmp/unused",
  );
  expect(text).toBe("status: complete\n\n# Plan");
});

test("trims a status header glued to preamble", () => {
  const [text] = new GrokProvider().parseResponse(
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
  const catalog = new GrokProvider().parseModelCatalog(
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
  expect(new GrokProvider().modelCatalogCommand()).toEqual(["grok", "models"]);
});

test("reads effort values for the selected model", () => {
  const provider = new GrokProvider();
  const text =
    "--effort/--reasoning-effort: unknown effort level 'migent-probe'; " +
    "use one of: high, medium, low\n";
  expect(provider.parseOptionValues("reasoning-effort", text, "grok-4.5")).toEqual([
    "high",
    "medium",
    "low",
  ]);
  expect(provider.optionValuesCommand("reasoning-effort", "grok-4.5")).toEqual([
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
  expect(() => provider.parseOptionValues("reasoning-effort", "not logged in", "grok-4.5")).toThrow(
    /not logged in/,
  );
});

test("rejects an unknown option", () => {
  const provider = new GrokProvider();
  expect(() => provider.validateOptions({ temperature: "0.2" })).toThrow(
    /temperature is not a grok option/,
  );
  provider.validateOptions({ "reasoning-effort": "ultra" });
  expect(() => provider.validateOptions({ max_turns: "0" })).toThrow(/max_turns must be an integer/);
});

test("maps options onto grok flags", () => {
  const spec = new GrokProvider().buildCommand({
    model: "grok-4",
    workspace: "/work",
    prompt: "prompt",
    agentId: null,
    newAgentId: null,
    promptFile: "/tmp/prompt.txt",
    lastMessageFile: "/tmp/last.txt",
    options: { "reasoning-effort": "medium", max_turns: "4" },
  });
  expect(providerCommands().grok).toBe(new GrokProvider().command);
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

test("normalizes grok usage from the resume fixtures", () => {
  const provider = new GrokProvider();
  const captures = [1, 2, 3].map((turn) => provider.captureUsage(usageFixture(`grok-resume-${turn}.jsonl`)));
  expect(captures[0]).toHaveProperty("end");
  expect(captures[0]).not.toHaveProperty("usage_event");
  const usages = captures.map((capture) => provider.normalizeUsage(capture!, null));
  expect(usages.map((usage) => usage.input_tokens)).toEqual([7750, 240, 159]);
  expect(usages[0]?.cost_usd).toBeCloseTo(0.00705, 5);
  expect(usages[1]?.cost_usd).toBeCloseTo(0.00325, 5);
  expect(usages[2]?.cost_usd).toBeCloseTo(0.00322, 5);
  expect(provider.captureUsage('{"type":"text","data":"hi"}\n')).toBeNull();
  const streamed = provider.captureUsage(
    `${JSON.stringify({ type: "usage", usage: { input_tokens: 5, output_tokens: "1", reasoning_tokens: -3, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } })}\n`,
  );
  expect(streamed).toEqual({
    usage_event: { input_tokens: 5, output_tokens: "1", reasoning_tokens: -3, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 },
  });
  const partial = provider.normalizeUsage(streamed!, null);
  expect(partial.cost_usd).toBeNull();
  expect(partial.input_tokens).toBe(5);
  expect(partial.output_tokens).toBeNull();
  expect(partial.reasoning_tokens).toBeNull();
  expect(provider.versionCommand()).toEqual(["grok", "--version"]);
  expect(provider.parseVersion("codex-cli 0.163.0\n")).toBe("codex-cli 0.163.0");
  expect(provider.parseVersion("")).toBeNull();
});
