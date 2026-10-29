import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultProviders } from "@nodeint/migent-adapters";
import {
  createProviderResolver, diagnose, resolveRoleTarget, resolveStageTarget, stringifyConfig,
} from "@nodeint/migent-kernel";
import { afterEach, expect, test } from "vitest";
import { runDoctor } from "../src/commands/doctor.ts";
import { clientsFromConfig } from "../src/commands/skill.ts";
import { capture } from "./support.ts";

const directories: string[] = [];
const providers = defaultProviders();
const resolve = createProviderResolver(providers);
const which = (command: string) => `/fake/${command}`;

function project(model: unknown, extra: Record<string, unknown> = {}): string {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-inline-"));
  directories.push(workspace);
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), stringifyConfig({
    schema_version: 3,
    roles: { developer: { default_model: model } },
    ...extra,
  }));
  writeFileSync(path.join(workspace, ".migent", "workflows", "work.yaml"), stringifyConfig({
    schema_version: 3,
    stages: [{ id: "work", role: "developer", options: { model_reasoning_effort: "high" } }],
  }));
  return workspace;
}

afterEach(() => {
  for (const workspace of directories.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

test("inline defaults support options, effort, clients, and local overrides", () => {
  const workspace = project({ provider: "byteplus", client: "codex", model: "test", effort: "low" });
  expect(resolveRoleTarget(workspace, "developer", undefined, resolve)).toEqual({
    provider: "byteplus", client: "codex", model: "test", options: { model_reasoning_effort: "low" },
  });
  expect(resolveStageTarget(workspace, "work", "work", undefined, resolve).options).toEqual({ model_reasoning_effort: "high" });
  expect(diagnose(workspace, { providers, which }).every((check) => check.ok)).toBe(true);
  expect(clientsFromConfig(workspace)).toEqual(["codex"]);
  writeFileSync(path.join(workspace, ".migent", "config.local.yaml"), stringifyConfig({
    roles: { developer: { default_model: { provider: "byteplus", client: "codex", model: "local" } } },
  }));
  expect(resolveRoleTarget(workspace, "developer", undefined, resolve).model).toBe("local");
});

test("a named stage model overrides an inline role default", () => {
  const workspace = project({ provider: "codex", model: "inline" }, {
    models: { alternate: { provider: "codex", model: "named" } },
  });
  writeFileSync(path.join(workspace, ".migent", "workflows", "work.yaml"), stringifyConfig({
    schema_version: 3, stages: [{ id: "work", role: "developer", model: "alternate" }],
  }));
  expect(resolveStageTarget(workspace, "work", "work", undefined, resolve)).toMatchObject({ model: "named" });
  expect(resolveStageTarget(workspace, "work", "work", { provider: "grok", model: "cli" }, resolve)).toEqual({
    provider: "grok", model: "cli", options: {},
  });
});

test.each([
  [{ provider: "unknown", model: "test" }, "roles.developer.default_model.provider is not supported"],
  [{ provider: "byteplus", model: "test" }, "roles.developer.default_model.client is required"],
  [{ provider: "byteplus", client: "missing", model: "test" }, "roles.developer.default_model.client is not supported"],
  [{ provider: "codex" }, "roles.developer.default_model.model"],
  [{ provider: "codex", model: "test", options: { nested: {} } }, "roles.developer.default_model.options.nested"],
  [{ provider: "codex", model: "test", effort: "high", options: { model_reasoning_effort: "low" } }, "effort conflicts"],
])("doctor rejects invalid inline models with their field path: %j", (model, problem) => {
  const workspace = project(model);
  const [config] = diagnose(workspace, { providers, which });
  expect(config.ok).toBe(false);
  expect(config.problems.join("\n")).toContain(problem);
});

test("doctor checks the executable used by inline models", () => {
  const workspace = project({ provider: "codex", model: "test" });
  const [, , checks] = diagnose(workspace, { providers, which: () => null });
  expect(checks.ok).toBe(false);
  expect(checks.problems).toEqual(["codex is not on PATH"]);
});

test.each(["high", "typo"])("doctor validates inline effort against the client catalog: %s", async (effort) => {
  const workspace = project({ provider: "codex", model: "test", effort });
  const result = await capture(() => runDoctor(workspace, {
    asJson: true, which, home: workspace,
    runCommand: () => JSON.stringify({ models: [{ slug: "test", supported_reasoning_levels: ["low", "medium", "high"] }] }),
  }));
  expect(result.value).toBe(effort === "high" ? 0 : 1);
  const checks = JSON.parse(result.stdout).checks;
  if (effort === "typo") {
    expect(checks.flatMap((check: { problems: string[] }) => check.problems)).toEqual([
      'Invalid roles.developer.default_model.effort: "typo"\nValid values: low, medium, high',
    ]);
  }
});
