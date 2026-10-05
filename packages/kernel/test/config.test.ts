import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  ConfigurationError,
  loadYamlMapping,
  resolveRoleTarget,
  resolveStageTarget,
} from "../src/index.ts";
import { STAGE_CONFIG, writeConfig, writeRoleWorkspace, writeStageWorkspace } from "./support.ts";

test("resolves role default, stage override, and cli override", () => {
  const workspace = writeStageWorkspace();
  const roleDefault = resolveStageTarget(workspace, "plan-implement", "implement");
  const stageOverride = resolveStageTarget(workspace, "plan-implement", "review-work");
  const cliOverride = resolveStageTarget(workspace, "plan-implement", "implement", {
    provider: "codex",
    model: "gpt-5.6-terra",
    options: { model_reasoning_effort: "medium" },
  });
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
    resolveStageTarget(workspace, "plan-implement", "implement", { provider: "grok" }),
  ).toThrow(ConfigurationError);
  expect(() =>
    resolveStageTarget(workspace, "plan-implement", "implement", { provider: "grok" }),
  ).toThrow(/both --provider and --model/);
});

test("rejects a missing stage", () => {
  const workspace = writeStageWorkspace();
  expect(() => resolveStageTarget(workspace, "plan-implement", "missing")).toThrow(
    ConfigurationError,
  );
  expect(() => resolveStageTarget(workspace, "plan-implement", "missing")).toThrow(
    /Stage not found: missing/,
  );
});

test("cli override returns before workflow read", () => {
  const workspace = writeRoleWorkspace();
  const target = resolveStageTarget(workspace, "missing-workflow", "missing-stage", {
    provider: "codex",
    model: "gpt-5.6-terra",
    options: { model_reasoning_effort: "medium" },
  });
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
  const target = resolveStageTarget(workspace, "plan-implement", "review-work");
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
  const target = resolveStageTarget(workspace, "plan-implement", "implement");
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
  expect(() => resolveRoleTarget(workspace, "developer")).toThrow(ConfigurationError);
  expect(() => resolveRoleTarget(workspace, "developer")).toThrow(
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
  expect(() => resolveRoleTarget(workspace, "missing")).toThrow(ConfigurationError);
  expect(() => resolveRoleTarget(workspace, "missing")).toThrow(/roles\.missing/);
  expect(() =>
    resolveRoleTarget(workspace, "missing", { provider: "grok", model: "grok-4.6" }),
  ).toThrow(/roles\.missing/);
});

test("cli override skips the role cascade", () => {
  const workspace = writeRoleWorkspace();
  const target = resolveRoleTarget(workspace, "developer", {
    provider: "codex",
    model: "gpt-5.6-terra",
    options: { model_reasoning_effort: "low" },
  });
  expect(target.provider).toBe("codex");
  expect(target.model).toBe("gpt-5.6-terra");
  expect(target.options.model_reasoning_effort).toBe("low");
  expect(() => resolveRoleTarget(workspace, "developer", { provider: "grok" })).toThrow(
    ConfigurationError,
  );
  expect(() => resolveRoleTarget(workspace, "developer", { provider: "grok" })).toThrow(
    /both --provider and --model/,
  );
});
