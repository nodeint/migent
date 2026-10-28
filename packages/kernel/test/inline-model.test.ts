import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, expect, test } from "vitest";
import { defaultProviders } from "@nodeint/migent-adapters";
import {
  createProviderResolver, describeChange, diagnose, inspectConfig, loadWorkspaceConfig, patchConfigText,
  resolveRoleCascade, resolveRoleTarget, resolveStageSpec,
} from "../src/index.ts";
import { parseWorkflowMapping } from "../src/workflow.ts";
import { parseYamlDocument } from "../src/yaml.ts";

const providers = defaultProviders();
const resolver = createProviderResolver(providers);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const model = { provider: "codex", model: "test-model", effort: "high", options: { temperature: "0.2" } };
function workspace(config: unknown, local?: unknown): string {
  const root = mkdtempSync(path.join(tmpdir(), "migent-inline-"));
  roots.push(root);
  mkdirSync(path.join(root, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(root, ".migent", "config.yaml"), stringify(config));
  if (local !== undefined) writeFileSync(path.join(root, ".migent", "config.local.yaml"), stringify(local));
  return root;
}

test("inline-only role resolution and doctor use the same model validation as aliases", () => {
  const root = workspace({ roles: { dev: { default_model: model } } });
  expect(resolveRoleTarget(root, "dev", undefined, resolver)).toEqual({
    provider: "codex", model: "test-model", options: { model_reasoning_effort: "high", temperature: "0.2" },
  });
  const checks = diagnose(root, { providers, which: () => "/fake/provider" });
  expect(checks[0].problems).toEqual([]);
  expect(checks[2].ok).toBe(true);
  expect(checks[2].items.join(" ")).toContain("codex");
  const config = loadWorkspaceConfig(root);
  const snapshot = structuredClone(config);
  const view = inspectConfig(config, [], resolver);
  expect(config).toEqual(snapshot);
  expect(describeChange(config, structuredClone(config), [], { resolveProvider: resolver }).roles).toEqual([]);
  expect(view.models).toEqual([]);
  expect(view.roles[0]).toMatchObject({ modelName: null, sharedWith: [], options: { model_reasoning_effort: "high" } });
});

test.each(["shared", model])("local inline selection replaces the whole shared default: %j", (shared) => {
  const local = { provider: "grok", model: "local-model" };
  const root = workspace({ models: { shared: model }, roles: { dev: { default_model: shared, instructions: ["keep"] } } },
    { roles: { dev: { default_model: local } } });
  expect(resolveRoleTarget(root, "dev", undefined, resolver)).toEqual({ ...local, options: {} });
  expect(loadWorkspaceConfig(root).roles).toEqual({ dev: { default_model: local, instructions: ["keep"] } });
});

test("local alias replaces an inline default", () => {
  const root = workspace({ models: { shared: model }, roles: { dev: { default_model: model } } },
    { roles: { dev: { default_model: "shared" } } });
  expect(resolveRoleTarget(root, "dev", undefined, resolver).options.model_reasoning_effort).toBe("high");
});

test.each([
  [null, "roles.dev.default_model"],
  [[], "roles.dev.default_model"],
  [{ model: "test" }, "roles.dev.default_model.provider"],
  [{ provider: "codex" }, "roles.dev.default_model.model"],
  [{ ...model, effort: 3 }, "roles.dev.default_model.effort"],
  [{ ...model, options: { model_reasoning_effort: "low" } }, "conflicts"],
  [{ ...model, options: { temperature: {} } }, "roles.dev.default_model.options.temperature"],
  ["test-model", 'roles.dev.default_model: unknown model alias "test-model"'],
])("invalid inline or alias selection points to the field: %j", (selection, error) => {
  expect(() => resolveRoleCascade({ roles: { dev: { default_model: selection } } }, "dev", undefined, resolver)).toThrow(error);
});

test.each([{}, null, { temperature: "0.2" }])("removed role options are rejected: %j", (options) => {
  const config = { roles: { dev: { default_model: model, options } } };
  expect(() => resolveRoleCascade(config, "dev", undefined, resolver)).toThrow("roles.dev.options is no longer supported");
  const checks = diagnose(workspace(config), { providers, which: () => "/fake/provider" });
  expect(checks[0].problems.join(" ")).toContain("roles.dev.options is no longer supported");
});

test("stage model selection, stage options and CLI options override inline defaults", () => {
  const config = { models: { other: { provider: "grok", model: "other" } }, roles: { dev: { default_model: model } } };
  const workflow = parseWorkflowMapping({ schema_version: 2, stages: [
    { id: "inline", role: "dev", options: { model_reasoning_effort: "low" } },
    { id: "named", role: "dev", model: "other" },
  ] }, "test");
  const inline = workflow.stages.inline!;
  const named = workflow.stages.named!;
  if (inline.kind !== "role" || named.kind !== "role") throw new Error("expected roles");
  expect(resolveStageSpec(config, inline, undefined, resolver).options.model_reasoning_effort).toBe("low");
  expect(resolveStageSpec(config, inline, { model_reasoning_effort: "medium" }, resolver).options.model_reasoning_effort).toBe("medium");
  expect(resolveStageSpec(config, named, undefined, resolver)).toEqual({ provider: "grok", model: "other", options: {} });
});

test.each([
  { provider: "unknown", model: "test" },
  { provider: "byteplus", model: "test" },
  { provider: "codex", client: "unknown", model: "test" },
])("doctor validates inline provider and client: %j", (definition) => {
  const checks = diagnose(workspace({ roles: { dev: { default_model: definition } } }), { providers, which: () => "/fake/provider" });
  expect(checks[0].ok).toBe(false);
  expect(checks[0].problems.join(" ")).toContain("roles.dev.default_model");
});

test("inline client selects the effective CLI", () => {
  const definition = { provider: "byteplus", client: "codex", model: "test", effort: "high" };
  const root = workspace({ roles: { dev: { default_model: definition } } });
  expect(resolveRoleTarget(root, "dev", undefined, resolver)).toMatchObject({ client: "codex", options: { model_reasoning_effort: "high" } });
  expect(diagnose(root, { providers, which: () => "/fake/provider" })[0].ok).toBe(true);
});

test("text patching supports alias and inline transitions and keeps role instructions", () => {
  let text = "# keep\nroles:\n  dev:\n    default_model: shared\n    instructions:\n      - Keep instructions.\n";
  for (const selection of [model, { provider: "grok", model: "local" }, "shared"]) {
    const updated = { roles: { dev: { default_model: selection, instructions: ["Keep instructions."] } } };
    text = patchConfigText(text, updated);
    expect(parseYamlDocument(text)).toEqual(updated);
    expect(text).toContain("# keep");
  }
});
