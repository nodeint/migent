import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { CodexProvider, providerCommands } from "../src/index.ts";

function usageFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/usage/${name}`, import.meta.url)), "utf8");
}

test("reads listed models and their effort from the codex catalog", () => {
  const catalog = new CodexProvider().parseModelCatalog(
    '{"models":[' +
      '{"slug":"gpt-5","visibility":"list","supported_reasoning_levels":' +
      '[{"effort":"low"},{"effort":"high"}]},' +
      '{"slug":"gpt-5-pro","visibility":"list","supported_reasoning_levels":' +
      '[{"effort":"max"}]},' +
      '{"slug":"internal","visibility":"hide","supported_reasoning_levels":' +
      '[{"effort":"low"}]}' +
      "]}",
  );
  expect(catalog.ids).toEqual(["gpt-5", "gpt-5-pro"]);
  expect(catalog.valuesFor("gpt-5", "model_reasoning_effort")).toEqual(["low", "high"]);
  expect(catalog.valuesFor("gpt-5-pro", "model_reasoning_effort")).toEqual(["max"]);
  expect(catalog.valuesFor("internal", "model_reasoning_effort")).toBeNull();
  expect(catalog.defaultId).toBeNull();
  expect(new CodexProvider().modelCatalogCommand()).toEqual(["codex", "debug", "models"]);
  expect(
    new CodexProvider().parseOptionValues(
      "model_reasoning_effort",
      '{"models":[{"slug":"gpt-5","visibility":"list",' +
        '"supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]}]}',
      "gpt-5",
    ),
  ).toEqual(["low", "high"]);
});

test("accepts any non-empty effort value", () => {
  expect(() => new CodexProvider().validateOptions({ "1bad": "x" })).toThrow(
    /1bad is not a codex option/,
  );
  expect(() => new CodexProvider().validateOptions({ model_reasoning_effort: " " })).toThrow(
    /model_reasoning_effort is empty/,
  );
  new CodexProvider().validateOptions({ model_reasoning_effort: "max", temperature: "0.2" });
});

test("maps options onto codex config overrides", () => {
  const spec = new CodexProvider().buildCommand({
    model: "gpt-5",
    workspace: "/work",
    prompt: "prompt",
    agentId: null,
    newAgentId: null,
    promptFile: "/tmp/prompt.txt",
    lastMessageFile: "/tmp/last.txt",
    options: { model_reasoning_effort: "medium", temperature: "0.2" },
  });
  expect(spec.argv[0]).toBe(new CodexProvider().command);
  expect(providerCommands().codex).toBe(new CodexProvider().command);
  expect(spec.argv).toContain("-c");
  const overrides = spec.argv.flatMap((arg, index) => (arg === "-c" ? [spec.argv[index + 1]] : []));
  expect(overrides).toEqual(['model_reasoning_effort="medium"', "temperature=0.2"]);
  expect(spec.stdin).toBe("prompt");
});

test("normalizes codex usage from the resume fixtures", () => {
  const provider = new CodexProvider();
  const captures = [1, 2, 3].map((turn) => provider.captureUsage(usageFixture(`codex-resume-${turn}.jsonl`)));
  expect(Array.isArray(captures[0]?.turn_completed)).toBe(true);
  const first = provider.normalizeUsage(captures[0]!, null);
  const second = provider.normalizeUsage(captures[1]!, captures[0]!);
  const third = provider.normalizeUsage(captures[2]!, captures[1]!);
  expect([first.input_tokens, second.input_tokens, third.input_tokens]).toEqual([14302, 241, 260]);
  expect([first.output_tokens, second.output_tokens, third.output_tokens]).toEqual([5, 5, 5]);
  expect([first.cache_read_tokens, second.cache_read_tokens, third.cache_read_tokens]).toEqual([0, 14080, 14080]);
  expect(first.cost_usd).toBeNull();
  expect(provider.captureUsage('{"type":"thread.started"}\n')).toBeNull();
  const regressed = provider.normalizeUsage(
    { turn_completed: [{ input_tokens: 3, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, cache_write_input_tokens: 0 }] },
    { turn_completed: [{ input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, cache_write_input_tokens: 0 }] },
  );
  expect(regressed.input_tokens).toBeNull();
  const missingCache = provider.normalizeUsage({ turn_completed: [{ input_tokens: 10, output_tokens: 2 }] }, null);
  expect(missingCache.input_tokens).toBeNull();
  expect(missingCache.output_tokens).toBe(2);
  const negative = provider.normalizeUsage({ turn_completed: [{ input_tokens: -1, cached_input_tokens: 0, output_tokens: "5" }] }, null);
  expect(negative.input_tokens).toBeNull();
  expect(negative.output_tokens).toBeNull();
  expect(provider.versionCommand()).toEqual(["codex", "--version"]);
  expect(provider.parseVersion("codex-cli 0.163.0\n")).toBe("codex-cli 0.163.0");
  expect(provider.parseVersion("")).toBeNull();
});
