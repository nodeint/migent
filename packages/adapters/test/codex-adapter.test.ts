import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { CodexAdapter, providerCommands } from "../src/index.ts";

function usageFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/usage/${name}`, import.meta.url)), "utf8");
}

test("reads listed models and their effort from the codex catalog", () => {
  const catalog = new CodexAdapter().parseModelCatalog(
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
  expect(new CodexAdapter().modelCatalogCommand()).toEqual(["codex", "debug", "models"]);
  expect(
    new CodexAdapter().parseOptionValues(
      "model_reasoning_effort",
      '{"models":[{"slug":"gpt-5","visibility":"list",' +
        '"supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]}]}',
      "gpt-5",
    ),
  ).toEqual(["low", "high"]);
});

test("accepts any non-empty effort value", () => {
  expect(() => new CodexAdapter().validateOptions({ "1bad": "x" })).toThrow(
    /1bad is not a codex option/,
  );
  expect(() => new CodexAdapter().validateOptions({ model_reasoning_effort: " " })).toThrow(
    /model_reasoning_effort is empty/,
  );
  new CodexAdapter().validateOptions({ model_reasoning_effort: "max", temperature: "0.2" });
});

test("maps options onto codex config overrides", () => {
  const spec = new CodexAdapter().buildCommand({
    model: "gpt-5",
    workspace: "/work",
    prompt: "prompt",
    agentId: null,
    newAgentId: null,
    promptFile: "/tmp/prompt.txt",
    lastMessageFile: "/tmp/last.txt",
    options: { model_reasoning_effort: "medium", temperature: "0.2" },
  });
  expect(spec.argv[0]).toBe(new CodexAdapter().command);
  expect(providerCommands().codex).toBe(new CodexAdapter().command);
  expect(spec.argv).toContain("-c");
  const overrides = spec.argv.flatMap((arg, index) => (arg === "-c" ? [spec.argv[index + 1]] : []));
  expect(overrides).toEqual(['model_reasoning_effort="medium"', "temperature=0.2"]);
  expect(spec.stdin).toBe("prompt");
});

test("normalizes codex usage from the resume fixtures", () => {
  const adapter = new CodexAdapter();
  const captures = [1, 2, 3].map((turn) => adapter.captureUsage(usageFixture(`codex-resume-${turn}.jsonl`)));
  expect(Array.isArray(captures[0]?.turn_completed)).toBe(true);
  const first = adapter.normalizeUsage(captures[0]!, null);
  const second = adapter.normalizeUsage(captures[1]!, captures[0]!);
  const third = adapter.normalizeUsage(captures[2]!, captures[1]!);
  expect([first.input_tokens, second.input_tokens, third.input_tokens]).toEqual([14302, 241, 260]);
  expect([first.output_tokens, second.output_tokens, third.output_tokens]).toEqual([5, 5, 5]);
  expect([first.cache_read_tokens, second.cache_read_tokens, third.cache_read_tokens]).toEqual([0, 14080, 14080]);
  expect(first.cost_usd).toBeNull();
  expect(adapter.captureUsage('{"type":"thread.started"}\n')).toBeNull();
  const regressed = adapter.normalizeUsage(
    { turn_completed: [{ input_tokens: 3, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, cache_write_input_tokens: 0 }] },
    { turn_completed: [{ input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, cache_write_input_tokens: 0 }] },
  );
  expect(regressed.input_tokens).toBeNull();
  const missingCache = adapter.normalizeUsage({ turn_completed: [{ input_tokens: 10, output_tokens: 2 }] }, null);
  expect(missingCache.input_tokens).toBeNull();
  expect(missingCache.output_tokens).toBe(2);
  const negative = adapter.normalizeUsage({ turn_completed: [{ input_tokens: -1, cached_input_tokens: 0, output_tokens: "5" }] }, null);
  expect(negative.input_tokens).toBeNull();
  expect(negative.output_tokens).toBeNull();
  expect(adapter.versionCommand()).toEqual(["codex", "--version"]);
  expect(adapter.parseVersion("codex-cli 0.163.0\n")).toBe("codex-cli 0.163.0");
  expect(adapter.parseVersion("")).toBeNull();
});
