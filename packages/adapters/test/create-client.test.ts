import { createProviderResolver, loadModelTarget } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { AgyProvider, ByteplusProvider, ClaudeProvider, createClient } from "../src/index.ts";

test("createClient maps an id to its client and rejects unknown ids", () => {
  expect(createClient("codex").id).toBe("codex");
  expect(() => createClient("nope")).toThrow(/Unknown CLI client: nope/);
});

test("withClient keeps the provider policy and swaps the CLI client", () => {
  const provider = new AgyProvider();
  const swapped = provider.withClient("codex");
  expect(swapped).toBeInstanceOf(AgyProvider);
  expect(swapped.command).toBe("codex");
  expect(provider.withClient("agy")).toBe(provider);
  expect(new ClaudeProvider().withClient("grok").command).toBe("grok");
});

test("byteplus has no default client and is bound through withClient", () => {
  const provider = new ByteplusProvider();
  expect(provider.requiresClient).toBe(true);
  expect(() => provider.validateOptions({})).toThrow(/no default CLI client/);
  const bound = provider.withClient("codex");
  expect(bound).toBeInstanceOf(ByteplusProvider);
  expect(bound.command).toBe("codex");
});

test("byteplus has no default client and is bound through withClient", () => {
  const provider = new ByteplusProvider();
  expect(provider.requiresClient).toBe(true);
  expect(() => provider.validateOptions({})).toThrow(/no default CLI client/);
  const bound = provider.withClient("codex");
  expect(bound).toBeInstanceOf(ByteplusProvider);
  expect(bound.command).toBe("codex");
});


test("model effort follows the bound client through to Grok command arguments", () => {
  const provider = new ClaudeProvider().withClient("grok");
  const resolveProvider = createProviderResolver({ custom: provider });
  const target = loadModelTarget({ models: { fast: { provider: "custom", model: "test", effort: "high" } } }, "fast", resolveProvider);
  const command = provider.buildCommand({
    model: target.model, options: target.options, workspace: ".", prompt: "test",
    agentId: null, newAgentId: null, promptFile: "prompt.md", lastMessageFile: "last.md",
  });
  const index = command.argv.indexOf("--reasoning-effort");
  expect(index).toBeGreaterThan(0);
  expect(command.argv[index + 1]).toBe("high");
  expect(command.argv).not.toContain("--effort");
  expect(provider.withClient("opencode").effortOption).toBe("variant");
});
