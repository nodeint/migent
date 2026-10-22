import { expect, test } from "vitest";
import { AgyProvider, ClaudeProvider, createClient } from "../src/index.ts";

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
