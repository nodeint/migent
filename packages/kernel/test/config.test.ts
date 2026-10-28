import { defaultProviders as adapterProviders } from "@nodeint/migent-adapters";
import { createProviderResolver } from "../src/provider-contract.ts";
import { stringify } from "yaml";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  ConfigurationError,
  loadRoleInstructions,
  loadModelTarget,
  loadWorkspaceConfig,
  loadYamlMapping,
  mergeConfig,
  resolveRoleTarget,
  resolveStageTarget,
} from "../src/index.ts";
import { STAGE_CONFIG, writeConfig, writeRoleWorkspace, writeStageWorkspace } from "./support.ts";

const resolveProvider = createProviderResolver(adapterProviders());

test("resolves role default, stage override, and cli override", () => {
  const workspace = writeStageWorkspace();
  const roleDefault = resolveStageTarget(workspace, "plan-implement", "implement", undefined, resolveProvider);
  const stageOverride = resolveStageTarget(workspace, "plan-implement", "review-work", undefined, resolveProvider);
  const cliOverride = resolveStageTarget(workspace, "plan-implement", "implement", {
    provider: "codex",
    model: "gpt-5.6-terra",
    options: { model_reasoning_effort: "medium" },
  }, resolveProvider);
  expect([roleDefault.provider, roleDefault.model, roleDefault.options["reasoning-effort"]]).toEqual([
    "grok",
    "grok-4.6",
    "high",
  ]);
  expect([
    stageOverride.provider,
    stageOverride.model,
    stageOverride.options.model_reasoning_effort,
  ]).toEqual(["codex", "gpt-5.6-terra", "high"]);
  expect(stageOverride.options.temperature).toBe("0.2");
  expect([
    cliOverride.provider,
    cliOverride.model,
    cliOverride.options.model_reasoning_effort,
  ]).toEqual(["codex", "gpt-5.6-terra", "medium"]);
});

test("rejects a partial provider model override", () => {
  const workspace = writeStageWorkspace();
  expect(() =>
    resolveStageTarget(workspace, "plan-implement", "implement", { provider: "grok" }, resolveProvider),
  ).toThrow(ConfigurationError);
  expect(() =>
    resolveStageTarget(workspace, "plan-implement", "implement", { provider: "grok" }, resolveProvider),
  ).toThrow(/both --provider and --model/);
});

test("rejects a missing stage", () => {
  const workspace = writeStageWorkspace();
  expect(() => resolveStageTarget(workspace, "plan-implement", "missing", undefined, resolveProvider)).toThrow(
    ConfigurationError,
  );
  expect(() => resolveStageTarget(workspace, "plan-implement", "missing", undefined, resolveProvider)).toThrow(
    /Stage not found: missing/,
  );
});

test("cli override returns before workflow read", () => {
  const workspace = writeRoleWorkspace();
  const target = resolveStageTarget(workspace, "missing-workflow", "missing-stage", {
    provider: "codex",
    model: "gpt-5.6-terra",
    options: { model_reasoning_effort: "medium" },
  }, resolveProvider);
  expect([target.provider, target.model, target.options.model_reasoning_effort]).toEqual([
    "codex",
    "gpt-5.6-terra",
    "medium",
  ]);
});

test("stage option overrides model options", () => {
  const workspace = writeStageWorkspace();
  const workflow = path.join(workspace, ".migent", "workflows", "plan-implement.yaml");
  writeFileSync(
    workflow,
    readFileSync(workflow, "utf8").replace("model_reasoning_effort: high", "model_reasoning_effort: low"),
    "utf8",
  );
  const target = resolveStageTarget(workspace, "plan-implement", "review-work", undefined, resolveProvider);
  expect(target.options.model_reasoning_effort).toBe("low");
  expect(target.options.temperature).toBe("0.2");
});

test("ignores a stray model field", () => {
  const workspace = writeStageWorkspace();
  const config = path.join(workspace, ".migent", "config.yaml");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace(
      "    options:\n      reasoning-effort: high\n",
      "    note: hello\n",
    ),
    "utf8",
  );
  const target = resolveStageTarget(workspace, "plan-implement", "implement", undefined, resolveProvider);
  expect(target.model).toBe("grok-4.6");
  expect(target.options).toEqual({});
});

test("preserves model options and role options", () => {
  const parsed = loadYamlMapping(writeConfig(STAGE_CONFIG));
  const models = parsed.models as { "gpt-terra": { options: Record<string, string> } };
  const roles = parsed.roles as { reviewer: { options: Record<string, string> } };
  expect(models["gpt-terra"].options).toEqual({
    model_reasoning_effort: "medium",
    temperature: "0.2",
  });
  expect(roles.reviewer.options.model_reasoning_effort).toBe("medium");
});

test("loads role instructions and rejects a non-list", () => {
  const config = loadYamlMapping(
    writeConfig(
      STAGE_CONFIG.replace(
        "  developer:\n    default_model: grok\n",
        "  developer:\n    default_model: grok\n    instructions:\n      - Write production code.\n      - Leave tests to the reviewer.\n",
      ),
    ),
  );
  expect(loadRoleInstructions(config, "developer")).toEqual([
    "Write production code.",
    "Leave tests to the reviewer.",
  ]);
  expect(loadRoleInstructions(config, "reviewer")).toEqual([]);
  const bad = loadYamlMapping(
    writeConfig(
      "models:\n  grok:\n    provider: grok\n    model: grok-4\n" +
        "roles:\n  developer:\n    default_model: grok\n    instructions: nope\n",
    ),
  );
  expect(() => loadRoleInstructions(bad, "developer")).toThrow(
    /roles\.developer\.instructions must be a list\./,
  );
  const blank = loadYamlMapping(
    writeConfig(
      "models:\n  grok:\n    provider: grok\n    model: grok-4\n" +
        "roles:\n  developer:\n    default_model: grok\n    instructions:\n      - \" \"\n",
    ),
  );
  expect(() => loadRoleInstructions(blank, "developer")).toThrow(
    /Missing or invalid roles\.developer\.instructions\[0\]\./,
  );
});

test("rejects a non-scalar model option", () => {
  const workspace = writeRoleWorkspace();
  const config = path.join(workspace, ".migent", "config.yaml");
  writeFileSync(
    config,
    "models:\n  grok:\n    provider: grok\n    model: grok-4\n" +
      "    options:\n      reasoning-effort:\n        default: high\n" +
      "roles:\n  developer:\n    default_model: grok\n",
    "utf8",
  );
  expect(() => resolveRoleTarget(workspace, "developer", undefined, resolveProvider)).toThrow(ConfigurationError);
  expect(() => resolveRoleTarget(workspace, "developer", undefined, resolveProvider)).toThrow(
    /Missing or invalid models\.grok\.options\.reasoning-effort\./,
  );
});

test("rejects a non-mapping configuration", () => {
  const filePath = writeConfig("- a\n- b\n");
  expect(() => loadYamlMapping(filePath)).toThrow(ConfigurationError);
  expect(() => loadYamlMapping(filePath)).toThrow(/Invalid configuration: expected a mapping\./);
});

test("rejects a missing role even with a provider model override", () => {
  const workspace = writeRoleWorkspace();
  expect(() => resolveRoleTarget(workspace, "missing", undefined, resolveProvider)).toThrow(ConfigurationError);
  expect(() => resolveRoleTarget(workspace, "missing", undefined, resolveProvider)).toThrow(/roles\.missing/);
  expect(() =>
    resolveRoleTarget(workspace, "missing", { provider: "grok", model: "grok-4.6" }, resolveProvider),
  ).toThrow(/roles\.missing/);
});

test("cli override skips the role cascade", () => {
  const workspace = writeRoleWorkspace();
  const target = resolveRoleTarget(workspace, "developer", {
    provider: "codex",
    model: "gpt-5.6-terra",
    options: { model_reasoning_effort: "low" },
  }, resolveProvider);
  expect(target.provider).toBe("codex");
  expect(target.model).toBe("gpt-5.6-terra");
  expect(target.options.model_reasoning_effort).toBe("low");
  expect(() => resolveRoleTarget(workspace, "developer", { provider: "grok" }, resolveProvider)).toThrow(
    ConfigurationError,
  );
  expect(() => resolveRoleTarget(workspace, "developer", { provider: "grok" }, resolveProvider)).toThrow(
    /both --provider and --model/,
  );
});

test("mergeConfig merges mappings and replaces scalars and lists", () => {
  const base = {
    schema_version: 2,
    models: { a: { provider: "grok", model: "m1", options: { x: "1", y: "2" } } },
    roles: { dev: { default_model: "a", instructions: ["one", "two"] } },
  };
  const snapshot = structuredClone(base);
  const local = {
    models: { a: { model: "m2", options: { y: "3" } }, b: { provider: "codex", model: "m3" } },
    roles: { dev: { instructions: ["only"] } },
  };
  const localSnapshot = structuredClone(local);
  const merged = mergeConfig(base, local);
  expect(merged).toEqual({
    schema_version: 2,
    models: {
      a: { provider: "grok", model: "m2", options: { x: "1", y: "3" } },
      b: { provider: "codex", model: "m3" },
    },
    roles: { dev: { default_model: "a", instructions: ["only"] } },
  });
  expect(base).toEqual(snapshot);
  expect(local).toEqual(localSnapshot);
});

test("loadWorkspaceConfig equals config.yaml without a local file", () => {
  const workspace = writeStageWorkspace();
  expect(loadWorkspaceConfig(workspace)).toEqual(
    loadYamlMapping(path.join(workspace, ".migent", "config.yaml")),
  );
});

test("config.local.yaml overrides role and stage resolution", () => {
  const workspace = writeStageWorkspace();
  writeFileSync(
    path.join(workspace, ".migent", "config.local.yaml"),
    [
      "schema_version: 99",
      "models:",
      "  grok:",
      "    model: grok-local",
      "roles:",
      "  reviewer:",
      "    options:",
      "      model_reasoning_effort: low",
      "",
    ].join("\n"),
    "utf8",
  );
  expect(loadWorkspaceConfig(workspace).schema_version).toBe(
    loadYamlMapping(path.join(workspace, ".migent", "config.yaml")).schema_version,
  );
  expect(resolveRoleTarget(workspace, "developer", undefined, resolveProvider).model).toBe("grok-local");
  expect(resolveStageTarget(workspace, "plan-implement", "implement", undefined, resolveProvider).model).toBe("grok-local");
  expect(resolveRoleTarget(workspace, "reviewer", undefined, resolveProvider).options.model_reasoning_effort).toBe("low");
});

test("a malformed config.local.yaml names the file", () => {
  const workspace = writeStageWorkspace();
  const local = path.join(workspace, ".migent", "config.local.yaml");
  writeFileSync(local, "- not-a-map\n", "utf8");
  expect(() => resolveRoleTarget(workspace, "developer", undefined, resolveProvider)).toThrow(ConfigurationError);
  expect(() => resolveRoleTarget(workspace, "developer", undefined, resolveProvider)).toThrow("config.local.yaml");
  writeFileSync(local, "models: [unclosed\n", "utf8");
  expect(() => loadWorkspaceConfig(workspace)).toThrow(ConfigurationError);
});


test.each([
  ["codex", undefined, "model_reasoning_effort"],
  ["grok", undefined, "reasoning-effort"],
  ["claude", undefined, "effort"],
  ["agy", undefined, "effort"],
  ["opencode", undefined, "variant"],
  ["byteplus", "opencode", "variant"],
  ["codex", "opencode", "variant"],
  ["byteplus", "codex", "model_reasoning_effort"],
  ["codex", "grok", "reasoning-effort"],
])("resolves model effort for %s with client %s", (provider, client, option) => {
  const target = loadModelTarget({ models: { fast: { provider, client, model: "test", effort: " xhigh ", options: { tools: "read" } } } }, "fast", resolveProvider);
  expect(target.options).toEqual({ [option!]: "xhigh", tools: "read" });
});

test.each([null, "", " ", 3, true])("rejects invalid model effort %s", (effort) => {
  expect(() => loadModelTarget({ models: { fast: { provider: "codex", model: "test", effort } } }, "fast", resolveProvider)).toThrow(/models.fast.effort/);
});

test.each([
  { provider: "byteplus" },
  { provider: "codex", client: "unknown" },
])("rejects unsupported effort client %s", (mapping) => {
  expect(() => loadModelTarget({ models: { fast: { ...mapping, model: "test", effort: "high" } } }, "fast", resolveProvider)).toThrow(/models.fast.effort/);
});

test.each(["codex", "grok", "claude", "agy", "opencode"])("rejects model effort conflicts for %s", (provider) => {
  const option = provider === "codex" ? "model_reasoning_effort" : provider === "grok" ? "reasoning-effort" : provider === "opencode" ? "variant" : "effort";
  expect(() => loadModelTarget({ models: { fast: { provider, model: "test", effort: "high", options: { [option]: "low" } } } }, "fast", resolveProvider)).toThrow(/conflicts with models.fast.options/);
});

test("local model effort replaces shared effort and role and stage native options still win", () => {
  const workspace = writeStageWorkspace();
  const config = loadWorkspaceConfig(workspace);
  const models = config.models as Record<string, Record<string, unknown>>;
  const alias = Object.keys(models).find((name) => models[name]!.provider === "grok")!;
  const model = models[alias]!;
  delete (model.options as Record<string, string>)["reasoning-effort"];
  model.effort = "low";
  const roles = config.roles as Record<string, Record<string, unknown>>;
  roles.developer!.options = { "reasoning-effort": "high" };
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), stringify(config));
  writeFileSync(path.join(workspace, ".migent", "config.local.yaml"), stringify({ models: { [alias]: { effort: "medium" } } }));
  expect(loadModelTarget(loadWorkspaceConfig(workspace), alias, resolveProvider).options["reasoning-effort"]).toBe("medium");
  expect(resolveStageTarget(workspace, "plan-implement", "implement", undefined, resolveProvider).options["reasoning-effort"]).toBe("high");
});


test("stage native effort overrides the model alias", () => {
  const workspace = writeStageWorkspace();
  const configPath = path.join(workspace, ".migent", "config.yaml");
  writeFileSync(configPath, readFileSync(configPath, "utf8").replace(
    '    options:\n      model_reasoning_effort: medium\n      temperature: "0.2"',
    '    effort: low\n    options:\n      temperature: "0.2"',
  ));
  expect(resolveRoleTarget(workspace, "reviewer", undefined, resolveProvider).options.model_reasoning_effort).toBe("medium");
  expect(resolveStageTarget(workspace, "plan-implement", "review-work", undefined, resolveProvider).options.model_reasoning_effort).toBe("high");
});


test("rejects effort conflicts introduced by local config merge", () => {
  const merged = mergeConfig(
    { models: { fast: { provider: "codex", model: "test", effort: "high" } } },
    { models: { fast: { options: { model_reasoning_effort: "low" } } } },
  );
  expect(() => loadModelTarget(merged, "fast", resolveProvider)).toThrow(/conflicts with models.fast.options.model_reasoning_effort/);
});


test("resolves effort through an injected provider without knowing provider or client names", () => {
  const resolveCustom = createProviderResolver({
    custom: {
      command: "custom-cli", effortOption: "custom_thinking_level", validateOptions() {},
      withClient(clientId) {
        expect(clientId).toBe("alternate");
        return { command: "alternate-cli", effortOption: "alternate_level", validateOptions() {} };
      },
    },
  });
  expect(loadModelTarget({ models: { fast: { provider: "custom", model: "m", effort: "high" } } }, "fast", resolveCustom).options)
    .toEqual({ custom_thinking_level: "high" });
  expect(loadModelTarget({ models: { fast: { provider: "custom", client: "alternate", model: "m", effort: "max" } } }, "fast", resolveCustom).options)
    .toEqual({ alternate_level: "max" });
});
