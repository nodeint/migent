import { expect, test } from "vitest";
import { CodexAdapter, providerCommands } from "../src/index.ts";

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
