import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveRoleTarget, resolveStageTarget, stringifyConfig,
} from "@nodeint/migent-kernel";
import { diagnose } from "@nodeint/migent-doctor";
import { afterEach, expect, test } from "vitest";
import { clientRegistry } from "../src/client.ts";
import { runDoctor } from "../src/commands/doctor.ts";
import { clientsFromConfig } from "../src/commands/skill.ts";
import { capture } from "./support.ts";

const directories: string[] = [];
const clients = clientRegistry();
const resolve = clients;
const which = (command: string) => `/fake/${command}`;

function project(model: unknown, extra: Record<string, unknown> = {}): string {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-inline-"));
  directories.push(workspace);
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), stringifyConfig({
    schema_version: 6,
    roles: { developer: { agent: model } },
    ...extra,
  }));
  writeFileSync(path.join(workspace, ".migent", "workflows", "work.yaml"), stringifyConfig({
    schema_version: 6,
    stages: [{ id: "work", role: "developer" }],
  }));
  return workspace;
}

afterEach(() => {
  for (const workspace of directories.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

test("inline defaults support options, effort, clients, and local overrides", () => {
  const workspace = project({ client: { type: "codex" }, model: "test", effort: "low" });
  expect(resolveRoleTarget(workspace, "developer", undefined, resolve)).toEqual({
    client: "codex", model: "test", options: { model_reasoning_effort: "low" },
  });
  expect(resolveStageTarget(workspace, "work", "work", undefined, resolve).options).toEqual({ model_reasoning_effort: "low" });
  // A stage's inline agent replaces the role's wholesale, effort and client included.
  writeFileSync(path.join(workspace, ".migent", "workflows", "work.yaml"), stringifyConfig({
    schema_version: 6,
    stages: [{ id: "work", role: "developer", agent: { client: { type: "codex", options: { model_reasoning_effort: "high" } }, model: "stage" } }],
  }));
  expect(resolveStageTarget(workspace, "work", "work", undefined, resolve)).toEqual({
    client: "codex", model: "stage", options: { model_reasoning_effort: "high" },
  });
  writeFileSync(path.join(workspace, ".migent", "workflows", "work.yaml"), stringifyConfig({
    schema_version: 6, stages: [{ id: "work", role: "developer" }],
  }));
  expect(diagnose(workspace, { clients, which }).every((check) => check.ok)).toBe(true);
  expect(clientsFromConfig(workspace)).toEqual(["codex"]);
  writeFileSync(path.join(workspace, ".migent", "config.local.yaml"), stringifyConfig({
    schema_version: 6,
    roles: { developer: { agent: { client: { type: "codex" }, model: "local" } } },
  }));
  expect(resolveRoleTarget(workspace, "developer", undefined, resolve).model).toBe("local");
});

test("a named stage agent overrides an inline role default", () => {
  const workspace = project({ client: { type: "codex" }, model: "inline" }, {
    agents: { alternate: { client: { type: "codex" }, model: "named" } },
  });
  writeFileSync(path.join(workspace, ".migent", "workflows", "work.yaml"), stringifyConfig({
    schema_version: 6, stages: [{ id: "work", role: "developer", agent: "alternate" }],
  }));
  expect(resolveStageTarget(workspace, "work", "work", undefined, resolve)).toMatchObject({ model: "named" });
  expect(resolveStageTarget(workspace, "work", "work", { client: "grok", model: "cli" }, resolve)).toEqual({
    client: "grok", model: "cli", options: {},
  });
});

test.each([
  [{ model: "test" }, "Missing roles.developer.agent.client.type"],
  [{ client: { type: "missing" }, model: "test" }, "roles.developer.agent.client.type is not supported"],
  [{ client: { type: "codex" } }, "roles.developer.agent.model"],
  [{ client: { type: "codex", options: { nested: {} } }, model: "test" }, "roles.developer.agent.client.options.nested"],
  [{ client: { type: "codex", options: { model_reasoning_effort: "low" } }, model: "test", effort: "high" }, "effort conflicts"],
])("doctor rejects invalid inline models with their field path: %j", (model, problem) => {
  const workspace = project(model);
  const [config] = diagnose(workspace, { clients, which });
  expect(config.ok).toBe(false);
  expect(config.problems.join("\n")).toContain(problem);
});

test("doctor checks the executable used by inline models", () => {
  const workspace = project({ client: { type: "codex" }, model: "test" });
  const [, , checks] = diagnose(workspace, { clients, which: () => null });
  expect(checks.ok).toBe(false);
  expect(checks.problems).toEqual(["codex is not on PATH"]);
});

test.each(["high", "typo"])("doctor validates inline effort against the client catalog: %s", async (effort) => {
  const workspace = project({ client: { type: "codex" }, model: "test", effort });
  const result = await capture(() => runDoctor(workspace, {
    asJson: true, which, home: workspace,
    runCommand: () => JSON.stringify({ models: [{ slug: "test", supported_reasoning_levels: ["low", "medium", "high"] }] }),
  }));
  expect(result.value).toBe(effort === "high" ? 0 : 1);
  const checks = JSON.parse(result.stdout).checks;
  if (effort === "typo") {
    expect(checks.flatMap((check: { problems: string[] }) => check.problems)).toEqual([
      'Invalid roles.developer.agent.effort: "typo"\nValid values: low, medium, high',
    ]);
  }
});
