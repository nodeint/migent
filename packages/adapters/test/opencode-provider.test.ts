import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyProviderError, createProviderResolver, loadModelTarget } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { OpencodeProvider, defaultProviders, providerCommands } from "../src/index.ts";

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
  const spec = new OpencodeProvider().buildCommand(input({ newAgentId: "ses_new" }));
  expect(spec.argv).toEqual(["opencode", "run", "--format", "json", "--auto", "-m", "anthropic/claude-sonnet-4"]);
  expect(spec.stdin).toBe("do the thing");
  expect(spec.argv).not.toContain("--cwd");
  expect(spec.argv.join(" ")).not.toContain("/work/space");
  expect(spec.argv.join(" ")).not.toContain("do the thing");
});

test("buildCommand resumes, and maps agent and thinking", () => {
  const provider = new OpencodeProvider();
  expect(provider.buildCommand(input({ agentId: "ses_x" })).argv.slice(-2)).toEqual(["-s", "ses_x"]);
  const argv = provider.buildCommand(input({ options: { agent: "build", thinking: "true" } })).argv;
  expect(argv).toContain("--thinking");
  expect(argv.slice(argv.indexOf("--agent"), argv.indexOf("--agent") + 2)).toEqual(["--agent", "build"]);
  expect(provider.buildCommand(input({ options: { thinking: "false" } })).argv).not.toContain("--thinking");
});

test("buildCommand validates options first", () => {
  const provider = new OpencodeProvider();
  expect(() => provider.buildCommand(input({ options: { thinking: "maybe" } }))).toThrow(
    "thinking must be true or false.",
  );
  expect(() => provider.buildCommand(input({ options: { nope: "x" } }))).toThrow("nope is not an opencode option.");
  expect(() => provider.buildCommand(input({ options: { agent: "  " } }))).toThrow("agent is empty.");
});

test("session, profile options, and option values", () => {
  const provider = new OpencodeProvider();
  expect(provider.createNewSession()).toEqual({});
  expect(provider.profileOptions({ agent: "build" })).toEqual({});
  expect(provider.optionValuesCommand("agent", "m")).toBeNull();
  expect(provider.optionValuesCommand("thinking", "m")).toBeNull();
  expect(() => provider.parseOptionValues("agent", "", "m")).toThrow("opencode does not list values for agent.");
});

test("parseModelCatalog keeps order, skips blanks, and has no default", () => {
  const provider = new OpencodeProvider();
  expect(provider.modelCatalogCommand()).toEqual(["opencode", "models"]);
  const catalog = provider.parseModelCatalog(fixture("models.txt"));
  expect(catalog.ids).toEqual(["anthropic/claude-sonnet-4", "openai/gpt-5", "opencode/big-pickle"]);
  expect(catalog.defaultId).toBeNull();
  expect(() => provider.parseModelCatalog("\n  \n")).toThrow("opencode model catalog is empty.");
});

test("parseVersion strips the product prefix", () => {
  const provider = new OpencodeProvider();
  expect(provider.versionCommand()).toEqual(["opencode", "--version"]);
  expect(provider.parseVersion("opencode v2.1.2\n")).toBe("2.1.2");
  expect(provider.parseVersion("\n")).toBeNull();
});

test("parseResponse reads text after a tool and the session id", () => {
  const [text, sessionId] = new OpencodeProvider().parseResponse(fixture("success.jsonl"), "/tmp/unused");
  expect(text).toBe("status: complete\n\n# Done");
  expect(sessionId).toBe("ses_abc");
});

test("parseResponse trims to the status header", () => {
  const [text] = new OpencodeProvider().parseResponse(fixture("status-header.jsonl"), "");
  expect(text).toBe("status: complete\n\n# Plan");
});

test("a later thought segment does not displace a status header segment", () => {
  const [text] = new OpencodeProvider().parseResponse(
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
  const provider = new OpencodeProvider();
  expect(provider.parseResponse(fixture("error-exit0.jsonl"), "")).toEqual(["Invalid API key", "ses_er"]);
  const typeOnly = stream({ type: "error", sessionID: "s", error: { type: "provider.auth" } });
  expect(provider.parseResponse(typeOnly, "")).toEqual(["provider.auth", "s"]);
  expect(provider.parseResponse(stream({ type: "error" }), "")).toEqual(["opencode reported an error.", null]);
  expect(provider.parseResponse(stream({ type: "step_start", sessionID: "s" }), "")).toEqual(["", "s"]);
  expect(provider.parseResponse("  plain output \n", "")).toEqual(["plain output", null]);
});

test("classifyFailure treats any error event as a provider failure", () => {
  const provider = new OpencodeProvider();
  expect(provider.classifyFailure(fixture("error-exit0.jsonl"), 0)).toEqual({
    kind: "provider",
    message: "Invalid API key",
  });
  expect(provider.classifyFailure(fixture("error-exit0.jsonl"), 1)?.kind).toBe("provider");
  expect(provider.classifyFailure("", 1)).toEqual({ kind: "provider", message: "CLI exited with code 1." });
  expect(provider.classifyFailure(fixture("success.jsonl"), 0)).toBeNull();
  const twice = stream({ type: "error", message: "first" }, { type: "error", message: "second" });
  expect(provider.classifyFailure(twice, 0)).toEqual({ kind: "provider", message: "second" });
});

test("parseProgressEvent maps tool statuses", () => {
  const provider = new OpencodeProvider();
  for (const status of ["running", "pending"]) {
    expect(provider.parseProgressEvent(toolUse(status))).toEqual({
      event: "provider.item_started",
      summary: "command started: ls -la",
      details: { item_type: "bash" },
    });
  }
  expect(provider.parseProgressEvent(toolUse("completed"))).toMatchObject({
    event: "provider.item_completed",
    summary: "command completed: ls -la",
  });
  expect(provider.parseProgressEvent(toolUse("error"))).toMatchObject({
    event: "provider.item_completed",
    summary: "command failed: ls -la",
  });
  expect(provider.parseProgressEvent(toolUse("weird"))).toBeNull();
  expect(provider.parseProgressEvent(toolUse(undefined))).toBeNull();
});

test("parseProgressEvent falls back to the tool name and handles other events", () => {
  const provider = new OpencodeProvider();
  const noCommand = JSON.stringify({ type: "tool_use", part: { tool: "read", state: { status: "completed" } } });
  expect(provider.parseProgressEvent(noCommand)).toEqual({
    event: "provider.item_completed",
    summary: "read completed",
    details: { item_type: "read" },
  });
  const noTool = JSON.stringify({ type: "tool_use", part: { state: { status: "running" } } });
  expect(provider.parseProgressEvent(noTool)).toEqual({
    event: "provider.item_started",
    summary: "tool started",
    details: {},
  });
  expect(provider.parseProgressEvent(JSON.stringify({ type: "error", message: "boom" }))).toEqual(
    classifyProviderError("boom"),
  );
  for (const type of ["text", "step_start", "step_finish"]) {
    expect(provider.parseProgressEvent(JSON.stringify({ type, part: {} }))).toBeNull();
  }
  expect(provider.parseProgressEvent("not json")).toBeNull();
});

test("usage sums every step without reducing input by cache reads", () => {
  const provider = new OpencodeProvider();
  const capture = provider.captureUsage(fixture("success.jsonl"));
  expect(capture).not.toBeNull();
  const usage = provider.normalizeUsage(capture!, null);
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
  const provider = new OpencodeProvider();
  const good = { tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }, cost: 0.5 };
  for (const bad of [-1, Number.NaN, "x", undefined]) {
    const usage = provider.normalizeUsage(
      { steps: [good, { ...good, tokens: { ...good.tokens, output: bad } }] },
      null,
    );
    expect(usage.output_tokens).toBeNull();
    expect(usage.input_tokens).toBe(2);
    expect(usage.cost_usd).toBe(1);
  }
});

test("usage covers only the steps present and is null with none", () => {
  const provider = new OpencodeProvider();
  const capture = provider.captureUsage(fixture("no-final-step.jsonl"));
  expect(provider.normalizeUsage(capture!, null)).toMatchObject({ input_tokens: 10, cost_usd: 0.01 });
  expect(provider.captureUsage(stream({ type: "text", part: { text: "x" } }))).toBeNull();
});

test("the provider is registered", () => {
  expect(providerCommands().opencode).toBe("opencode");
  expect(defaultProviders().opencode).toBeInstanceOf(OpencodeProvider);
});


test("model effort becomes an OpenCode V2 model variant on new and resumed runs", () => {
  const provider = new OpencodeProvider();
  const target = loadModelTarget({ models: { fast: {
    provider: "opencode", model: "openai/test", effort: "high",
    options: { agent: "build", thinking: "true" },
  } } }, "fast", createProviderResolver({ opencode: provider }));
  expect(target.options).toEqual({ variant: "high", agent: "build", thinking: "true" });
  for (const agentId of [null, "ses_x"]) {
    const command = provider.buildCommand(input({ model: target.model, options: target.options, agentId }));
    expect(command.argv[command.argv.indexOf("-m") + 1]).toBe("openai/test#high");
    expect(command.argv).toContain("--thinking");
    expect(command.argv).not.toContain("--variant");
  }
  expect(provider.profileOptions(target.options)).toEqual({ variant: "high" });
});

test("native variants and existing model suffixes work independently", () => {
  const provider = new OpencodeProvider();
  expect(provider.buildCommand(input({ model: "openai/test#max" })).argv).toContain("openai/test#max");
  expect(provider.buildCommand(input({ options: { variant: "custom-level" } })).argv)
    .toContain("anthropic/claude-sonnet-4#custom-level");
  expect(() => provider.buildCommand(input({ model: "openai/test#low", options: { variant: "high" } })))
    .toThrow(/already selects a #variant/);
});

test.each(["", " ", "high#low", "high low", "high\nlow"])("rejects malformed variant %s", (variant) => {
  expect(() => new OpencodeProvider().buildCommand(input({ options: { variant } }))).toThrow(/variant/);
});


test("lists OpenCode V2 variants for the exact provider and model", () => {
  const provider = new OpencodeProvider();
  expect(provider.optionValuesCommand("variant", "custom/test")).toEqual(["opencode", "api", "model.list"]);
  const catalog = JSON.stringify({ data: [
    { providerID: "other", id: "test", variants: [{ id: "wrong" }] },
    { providerID: "custom", id: "test", variants: [{ id: "low" }, { id: "high" }, { id: "high" }] },
    { providerID: "custom", id: "plain", variants: [] },
  ] });
  expect(provider.parseOptionValues("variant", catalog, "custom/test")).toEqual(["low", "high"]);
  expect(provider.parseOptionValues("variant", catalog, "custom/plain")).toEqual([]);
  expect(() => provider.parseOptionValues("variant", catalog, "custom/missing")).toThrow(/does not list variants/);
  expect(() => provider.parseOptionValues("variant", "{}", "custom/test")).toThrow(/did not report/);
  expect(() => provider.parseOptionValues("variant", JSON.stringify({ data: [
    { providerID: "custom", id: "test", variants: [{}] },
  ] }), "custom/test")).toThrow(/invalid variant/);
});
