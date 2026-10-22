import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyProviderError } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { OpencodeAdapter, defaultAdapters, providerCommands } from "../src/index.ts";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/opencode/${name}`, import.meta.url)), "utf8");
}

function stream(...events: Record<string, unknown>[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    model: "anthropic/claude-sonnet-4",
    workspace: "/work/space",
    prompt: "do the thing",
    agentId: null,
    newAgentId: null,
    promptFile: "/tmp/prompt.md",
    lastMessageFile: "/tmp/last.md",
    options: {},
    ...overrides,
  };
}

function toolUse(status: unknown): string {
  return JSON.stringify({
    type: "tool_use",
    sessionID: "ses_x",
    part: { tool: "bash", state: { status, input: { command: "ls  -la" } } },
  });
}

test("buildCommand sends the prompt on stdin and relies on the process cwd", () => {
  const spec = new OpencodeAdapter().buildCommand(input({ newAgentId: "ses_new" }));
  expect(spec.argv).toEqual(["opencode", "run", "--format", "json", "--auto", "-m", "anthropic/claude-sonnet-4"]);
  expect(spec.stdin).toBe("do the thing");
  expect(spec.argv).not.toContain("--cwd");
  expect(spec.argv.join(" ")).not.toContain("/work/space");
  expect(spec.argv.join(" ")).not.toContain("do the thing");
});

test("buildCommand resumes, and maps agent and thinking", () => {
  const adapter = new OpencodeAdapter();
  expect(adapter.buildCommand(input({ agentId: "ses_x" })).argv.slice(-2)).toEqual(["-s", "ses_x"]);
  const argv = adapter.buildCommand(input({ options: { agent: "build", thinking: "true" } })).argv;
  expect(argv).toContain("--thinking");
  expect(argv.slice(argv.indexOf("--agent"), argv.indexOf("--agent") + 2)).toEqual(["--agent", "build"]);
  expect(adapter.buildCommand(input({ options: { thinking: "false" } })).argv).not.toContain("--thinking");
});

test("buildCommand validates options first", () => {
  const adapter = new OpencodeAdapter();
  expect(() => adapter.buildCommand(input({ options: { thinking: "maybe" } }))).toThrow(
    "thinking must be true or false.",
  );
  expect(() => adapter.buildCommand(input({ options: { nope: "x" } }))).toThrow("nope is not an opencode option.");
  expect(() => adapter.buildCommand(input({ options: { agent: "  " } }))).toThrow("agent is empty.");
});

test("session, profile options, and option values", () => {
  const adapter = new OpencodeAdapter();
  expect(adapter.createNewSession()).toEqual({});
  expect(adapter.profileOptions({ agent: "build" })).toEqual({});
  expect(adapter.optionValuesCommand("agent", "m")).toBeNull();
  expect(adapter.optionValuesCommand("thinking", "m")).toBeNull();
  expect(() => adapter.parseOptionValues("agent", "", "m")).toThrow("opencode does not list values for agent.");
});

test("parseModelCatalog keeps order, skips blanks, and has no default", () => {
  const adapter = new OpencodeAdapter();
  expect(adapter.modelCatalogCommand()).toEqual(["opencode", "models"]);
  const catalog = adapter.parseModelCatalog(fixture("models.txt"));
  expect(catalog.ids).toEqual(["anthropic/claude-sonnet-4", "openai/gpt-5", "opencode/big-pickle"]);
  expect(catalog.defaultId).toBeNull();
  expect(() => adapter.parseModelCatalog("\n  \n")).toThrow("opencode model catalog is empty.");
});

test("parseVersion strips the product prefix", () => {
  const adapter = new OpencodeAdapter();
  expect(adapter.versionCommand()).toEqual(["opencode", "--version"]);
  expect(adapter.parseVersion("opencode v2.1.2\n")).toBe("2.1.2");
  expect(adapter.parseVersion("\n")).toBeNull();
});

test("parseResponse reads text after a tool and the session id", () => {
  const [text, sessionId] = new OpencodeAdapter().parseResponse(fixture("success.jsonl"), "/tmp/unused");
  expect(text).toBe("status: complete\n\n# Done");
  expect(sessionId).toBe("ses_abc");
});

test("parseResponse trims to the status header", () => {
  const [text] = new OpencodeAdapter().parseResponse(fixture("status-header.jsonl"), "");
  expect(text).toBe("status: complete\n\n# Plan");
});

test("a later thought segment does not displace a status header segment", () => {
  const [text] = new OpencodeAdapter().parseResponse(
    stream(
      { type: "text", part: { text: "status: complete\n\n# Plan\n" } },
      { type: "tool_use", part: { tool: "bash" } },
      { type: "text", part: { text: "thinking afterwards" } },
    ),
    "",
  );
  expect(text).toBe("status: complete\n\n# Plan");
});

test("parseResponse falls back to the error string, then to raw stdout", () => {
  const adapter = new OpencodeAdapter();
  expect(adapter.parseResponse(fixture("error-exit0.jsonl"), "")).toEqual(["Invalid API key", "ses_er"]);
  const typeOnly = stream({ type: "error", sessionID: "s", error: { type: "provider.auth" } });
  expect(adapter.parseResponse(typeOnly, "")).toEqual(["provider.auth", "s"]);
  expect(adapter.parseResponse(stream({ type: "error" }), "")).toEqual(["opencode reported an error.", null]);
  expect(adapter.parseResponse(stream({ type: "step_start", sessionID: "s" }), "")).toEqual(["", "s"]);
  expect(adapter.parseResponse("  plain output \n", "")).toEqual(["plain output", null]);
});

test("classifyFailure treats any error event as a provider failure", () => {
  const adapter = new OpencodeAdapter();
  expect(adapter.classifyFailure(fixture("error-exit0.jsonl"), 0)).toEqual({
    kind: "provider",
    message: "Invalid API key",
  });
  expect(adapter.classifyFailure(fixture("error-exit0.jsonl"), 1)?.kind).toBe("provider");
  expect(adapter.classifyFailure("", 1)).toEqual({ kind: "provider", message: "CLI exited with code 1." });
  expect(adapter.classifyFailure(fixture("success.jsonl"), 0)).toBeNull();
  const twice = stream({ type: "error", message: "first" }, { type: "error", message: "second" });
  expect(adapter.classifyFailure(twice, 0)).toEqual({ kind: "provider", message: "second" });
});

test("parseProgressEvent maps tool statuses", () => {
  const adapter = new OpencodeAdapter();
  for (const status of ["running", "pending"]) {
    expect(adapter.parseProgressEvent(toolUse(status))).toEqual({
      event: "provider.item_started",
      summary: "command started: ls -la",
      details: { item_type: "bash" },
    });
  }
  expect(adapter.parseProgressEvent(toolUse("completed"))).toMatchObject({
    event: "provider.item_completed",
    summary: "command completed: ls -la",
  });
  expect(adapter.parseProgressEvent(toolUse("error"))).toMatchObject({
    event: "provider.item_completed",
    summary: "command failed: ls -la",
  });
  expect(adapter.parseProgressEvent(toolUse("weird"))).toBeNull();
  expect(adapter.parseProgressEvent(toolUse(undefined))).toBeNull();
});

test("parseProgressEvent falls back to the tool name and handles other events", () => {
  const adapter = new OpencodeAdapter();
  const noCommand = JSON.stringify({ type: "tool_use", part: { tool: "read", state: { status: "completed" } } });
  expect(adapter.parseProgressEvent(noCommand)).toEqual({
    event: "provider.item_completed",
    summary: "read completed",
    details: { item_type: "read" },
  });
  const noTool = JSON.stringify({ type: "tool_use", part: { state: { status: "running" } } });
  expect(adapter.parseProgressEvent(noTool)).toEqual({
    event: "provider.item_started",
    summary: "tool started",
    details: {},
  });
  expect(adapter.parseProgressEvent(JSON.stringify({ type: "error", message: "boom" }))).toEqual(
    classifyProviderError("boom"),
  );
  for (const type of ["text", "step_start", "step_finish"]) {
    expect(adapter.parseProgressEvent(JSON.stringify({ type, part: {} }))).toBeNull();
  }
  expect(adapter.parseProgressEvent("not json")).toBeNull();
});

test("usage sums every step without reducing input by cache reads", () => {
  const adapter = new OpencodeAdapter();
  const capture = adapter.captureUsage(fixture("success.jsonl"));
  expect(capture).not.toBeNull();
  const usage = adapter.normalizeUsage(capture!, null);
  expect(usage).toMatchObject({
    input_tokens: 300,
    output_tokens: 50,
    reasoning_tokens: 5,
    cache_read_tokens: 200,
    cache_write_tokens: 10,
  });
  expect(usage.cost_usd).toBeCloseTo(0.03);
});

test("usage with a bad step nulls only that metric", () => {
  const adapter = new OpencodeAdapter();
  const good = { tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }, cost: 0.5 };
  for (const bad of [-1, Number.NaN, "x", undefined]) {
    const usage = adapter.normalizeUsage(
      { steps: [good, { ...good, tokens: { ...good.tokens, output: bad } }] },
      null,
    );
    expect(usage.output_tokens).toBeNull();
    expect(usage.input_tokens).toBe(2);
    expect(usage.cost_usd).toBe(1);
  }
});

test("usage covers only the steps present and is null with none", () => {
  const adapter = new OpencodeAdapter();
  const capture = adapter.captureUsage(fixture("no-final-step.jsonl"));
  expect(adapter.normalizeUsage(capture!, null)).toMatchObject({ input_tokens: 10, cost_usd: 0.01 });
  expect(adapter.captureUsage(stream({ type: "text", part: { text: "x" } }))).toBeNull();
});

test("the adapter is registered", () => {
  expect(providerCommands().opencode).toBe("opencode");
  expect(defaultAdapters().opencode).toBeInstanceOf(OpencodeAdapter);
});
