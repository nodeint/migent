import { clientIds, createClient } from "@nodeint/migent-adapters";
import { stringify } from "yaml";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  ConfigurationError,
  loadRoleResponsibilities,
  loadAgentTarget,
  loadWorkspaceConfig,
  loadYamlMapping,
  mergeConfig,
  resolveRoleTarget,
  resolveStageTarget,
  type ClientRegistry,
} from "../src/index.ts";
import { FakeClient, registryOf, STAGE_CONFIG, writeConfig, writeRoleWorkspace, writeStageWorkspace } from "./support.ts";

const registry: ClientRegistry = { ids: () => clientIds(), get: (id: string) => createClient(id) };

test("resolves role default, stage override, and cli override", () => {
  const workspace = writeStageWorkspace();
  const roleDefault = resolveStageTarget(workspace, "plan-implement", "implement", undefined, registry);
  const stageOverride = resolveStageTarget(workspace, "plan-implement", "review-work", undefined, registry);
  const cliOverride = resolveStageTarget(workspace, "plan-implement", "implement", {
    client: "codex",
    model: "gpt-5.6-terra",
    options: { model_reasoning_effort: "medium" },
  }, registry);
  expect([roleDefault.client, roleDefault.model, roleDefault.options["reasoning-effort"]]).toEqual([
    "grok",
    "grok-4.6",
    "high",
  ]);
  expect([
    stageOverride.client,
    stageOverride.model,
    stageOverride.options.model_reasoning_effort,
  ]).toEqual(["codex", "gpt-5.6-terra", "high"]);
  expect(stageOverride.options.temperature).toBe("0.2");
  expect([
    cliOverride.client,
    cliOverride.model,
    cliOverride.options.model_reasoning_effort,
  ]).toEqual(["codex", "gpt-5.6-terra", "medium"]);
});

test("rejects a partial client model override", () => {
  const workspace = writeStageWorkspace();
  expect(() =>
    resolveStageTarget(workspace, "plan-implement", "implement", { client: "grok" }, registry),
  ).toThrow(ConfigurationError);
  expect(() =>
    resolveStageTarget(workspace, "plan-implement", "implement", { client: "grok" }, registry),
  ).toThrow(/both --client and --model/);
});

test("rejects a missing stage", () => {
  const workspace = writeStageWorkspace();
  expect(() => resolveStageTarget(workspace, "plan-implement", "missing", undefined, registry)).toThrow(
    ConfigurationError,
  );
  expect(() => resolveStageTarget(workspace, "plan-implement", "missing", undefined, registry)).toThrow(
    /Stage not found: missing/,
  );
});

test("cli override returns before workflow read", () => {
  const workspace = writeRoleWorkspace();
  const target = resolveStageTarget(workspace, "missing-workflow", "missing-stage", {
    client: "codex",
    model: "gpt-5.6-terra",
    options: { model_reasoning_effort: "medium" },
  }, registry);
  expect([target.client, target.model, target.options.model_reasoning_effort]).toEqual([
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
  const target = resolveStageTarget(workspace, "plan-implement", "review-work", undefined, registry);
  expect(target.options.model_reasoning_effort).toBe("low");
  expect(target.options.temperature).toBe("0.2");
});

test("ignores a stray model field", () => {
  const workspace = writeStageWorkspace();
  const config = path.join(workspace, ".migent", "config.yaml");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace(
      "    client:\n      type: grok\n      options:\n        reasoning-effort: high\n",
      "    note: hello\n    client:\n      type: grok\n",
    ),
    "utf8",
  );
  const target = resolveStageTarget(workspace, "plan-implement", "implement", undefined, registry);
  expect(target.model).toBe("grok-4.6");
  expect(target.options).toEqual({});
});

test("preserves model options without role options", () => {
  const parsed = loadYamlMapping(writeConfig(STAGE_CONFIG));
  const agents = parsed.agents as { "gpt-terra": { client: { options: Record<string, string> } } };
  const roles = parsed.roles as { reviewer: { options: Record<string, string> } };
  expect(agents["gpt-terra"].client.options).toEqual({
    model_reasoning_effort: "medium",
    temperature: "0.2",
  });
  expect(roles.reviewer).not.toHaveProperty("options");
});

test("loads role instructions and rejects a non-list", () => {
  const config = loadYamlMapping(
    writeConfig(
      STAGE_CONFIG.replace(
        "  developer:\n    agent: grok\n",
        "  developer:\n    agent: grok\n    responsibilities:\n      - Write production code.\n      - Leave tests to the reviewer.\n",
      ),
    ),
  );
  expect(loadRoleResponsibilities(config, "developer")).toEqual([
    "Write production code.",
    "Leave tests to the reviewer.",
  ]);
  expect(loadRoleResponsibilities(config, "reviewer")).toEqual([]);
  const bad = loadYamlMapping(
    writeConfig(
      "schema_version: 6\nagents:\n  grok:\n    client:\n      type: grok\n    model: grok-4\n" +
        "roles:\n  developer:\n    agent: grok\n    responsibilities: nope\n",
    ),
  );
  expect(() => loadRoleResponsibilities(bad, "developer")).toThrow(
    /roles\.developer\.responsibilities must be a list\./,
  );
  const blank = loadYamlMapping(
    writeConfig(
      "schema_version: 6\nagents:\n  grok:\n    client:\n      type: grok\n    model: grok-4\n" +
        "roles:\n  developer:\n    agent: grok\n    responsibilities:\n      - \" \"\n",
    ),
  );
  expect(() => loadRoleResponsibilities(blank, "developer")).toThrow(
    /Missing or invalid roles\.developer\.responsibilities\[0\]\./,
  );
});

test("rejects a non-scalar model option", () => {
  const workspace = writeRoleWorkspace();
  const config = path.join(workspace, ".migent", "config.yaml");
  writeFileSync(
    config,
    "schema_version: 6\nagents:\n  grok:\n    client:\n      type: grok\n      options:\n        reasoning-effort:\n          default: high\n" +
      "    model: grok-4\nroles:\n  developer:\n    agent: grok\n",
    "utf8",
  );
  expect(() => resolveRoleTarget(workspace, "developer", undefined, registry)).toThrow(ConfigurationError);
  expect(() => resolveRoleTarget(workspace, "developer", undefined, registry)).toThrow(
    /Missing or invalid agents\.grok\.client\.options\.reasoning-effort\./,
  );
});

test("rejects a non-mapping configuration", () => {
  const filePath = writeConfig("- a\n- b\n");
  expect(() => loadYamlMapping(filePath)).toThrow(ConfigurationError);
  expect(() => loadYamlMapping(filePath)).toThrow(/Invalid configuration: expected a mapping\./);
});

test("rejects a missing role even with a client model override", () => {
  const workspace = writeRoleWorkspace();
  expect(() => resolveRoleTarget(workspace, "missing", undefined, registry)).toThrow(ConfigurationError);
  expect(() => resolveRoleTarget(workspace, "missing", undefined, registry)).toThrow(/roles\.missing/);
  expect(() =>
    resolveRoleTarget(workspace, "missing", { client: "grok", model: "grok-4.6" }, registry),
  ).toThrow(/roles\.missing/);
});

test("cli override skips the role cascade", () => {
  const workspace = writeRoleWorkspace();
  const target = resolveRoleTarget(workspace, "developer", {
    client: "codex",
    model: "gpt-5.6-terra",
    options: { model_reasoning_effort: "low" },
  }, registry);
  expect(target.client).toBe("codex");
  expect(target.model).toBe("gpt-5.6-terra");
  expect(target.options.model_reasoning_effort).toBe("low");
  expect(() => resolveRoleTarget(workspace, "developer", { client: "grok" }, registry)).toThrow(
    ConfigurationError,
  );
  expect(() => resolveRoleTarget(workspace, "developer", { client: "grok" }, registry)).toThrow(
    /both --client and --model/,
  );
});

test("mergeConfig merges mappings and replaces scalars and lists", () => {
  const base = {
    schema_version: 2,
    agents: { a: { client: { type: "grok", options: { x: "1", y: "2" } }, model: "m1" } },
    roles: { dev: { agent: "a", responsibilities: ["one", "two"] } },
  };
  const snapshot = structuredClone(base);
  const local = {
    agents: { a: { model: "m2", client: { options: { y: "3" } } }, b: { client: { type: "codex" }, model: "m3" } },
    roles: { dev: { responsibilities: ["only"] } },
  };
  const localSnapshot = structuredClone(local);
  const merged = mergeConfig(base, local);
  expect(merged).toEqual({
    schema_version: 2,
    agents: {
      a: { client: { type: "grok", options: { x: "1", y: "3" } }, model: "m2" },
      b: { client: { type: "codex" }, model: "m3" },
    },
    roles: { dev: { agent: "a", responsibilities: ["only"] } },
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
      "agents:",
      "  grok:",
      "    model: grok-local",
      "roles:",
      "  reviewer:",
      "    agent:",
      "      client:",
      "        type: codex",
      "        options:",
      "          model_reasoning_effort: low",
      "      model: local-reviewer",
      "",
    ].join("\n"),
    "utf8",
  );
  expect(loadWorkspaceConfig(workspace).schema_version).toBe(
    loadYamlMapping(path.join(workspace, ".migent", "config.yaml")).schema_version,
  );
  expect(resolveRoleTarget(workspace, "developer", undefined, registry).model).toBe("grok-local");
  expect(resolveStageTarget(workspace, "plan-implement", "implement", undefined, registry).model).toBe("grok-local");
  expect(resolveRoleTarget(workspace, "reviewer", undefined, registry).options.model_reasoning_effort).toBe("low");
});

test("a malformed config.local.yaml names the file", () => {
  const workspace = writeStageWorkspace();
  const local = path.join(workspace, ".migent", "config.local.yaml");
  writeFileSync(local, "- not-a-map\n", "utf8");
  expect(() => resolveRoleTarget(workspace, "developer", undefined, registry)).toThrow(ConfigurationError);
  expect(() => resolveRoleTarget(workspace, "developer", undefined, registry)).toThrow("config.local.yaml");
  writeFileSync(local, "agents: [unclosed\n", "utf8");
  expect(() => loadWorkspaceConfig(workspace)).toThrow(ConfigurationError);
});


test.each([
  ["codex", undefined, "model_reasoning_effort"],
  ["grok", undefined, "reasoning-effort"],
  ["claude-code", undefined, "effort"],
  ["agy", undefined, "effort"],
  ["opencode", undefined, "variant"],
  ["codex", "opencode", "variant"],
  ["opencode", "codex", "model_reasoning_effort"],
  ["codex", "grok", "reasoning-effort"],
])("resolves model effort for %s with client %s", (client, override, option) => {
  const target = loadAgentTarget({
    agents: {
      fast: {
        client: { type: override ?? client, options: { tools: "read" } },
        model: "test",
        effort: " xhigh ",
      },
    },
  }, "fast", registry);
  expect(target.options).toEqual({ [option!]: "xhigh", tools: "read" });
});

test.each([null, "", " ", 3, true])("rejects invalid model effort %s", (effort) => {
  expect(() => loadAgentTarget({ agents: { fast: { client: { type: "codex" }, model: "test", effort } } }, "fast", registry)).toThrow(/agents.fast.effort/);
});

test.each([
  { client: { type: "byteplus" } },
  { client: { type: "codex-unknown" } },
])("rejects unsupported effort client %s", (mapping) => {
  expect(() => loadAgentTarget({ agents: { fast: { ...mapping, model: "test", effort: "high" } } }, "fast", registry)).toThrow(/agents.fast.effort/);
});

test.each(["codex", "grok", "claude-code", "agy", "opencode"])("rejects model effort conflicts for %s", (client) => {
  const option = client === "codex" ? "model_reasoning_effort" : client === "grok" ? "reasoning-effort" : client === "opencode" ? "variant" : "effort";
  expect(() => loadAgentTarget({ agents: { fast: { client: { type: client, options: { [option]: "low" } }, model: "test", effort: "high" } } }, "fast", registry)).toThrow(/conflicts with agents.fast.client.options/);
});

test("local model effort replaces shared effort", () => {
  const workspace = writeStageWorkspace();
  const config = loadWorkspaceConfig(workspace);
  const agents = config.agents as Record<string, Record<string, unknown>>;
  const alias = Object.keys(agents).find((name) => (agents[name]!.client as Record<string, unknown>).type === "grok")!;
  const model = agents[alias]!;
  delete ((model.client as Record<string, unknown>).options as Record<string, string>)["reasoning-effort"];
  model.effort = "low";
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), stringify(config));
  writeFileSync(path.join(workspace, ".migent", "config.local.yaml"), stringify({ agents: { [alias]: { effort: "medium" } } }));
  expect(loadAgentTarget(loadWorkspaceConfig(workspace), alias, registry).options["reasoning-effort"]).toBe("medium");
  expect(resolveStageTarget(workspace, "plan-implement", "implement", undefined, registry).options["reasoning-effort"]).toBe("medium");
});


test("stage native effort overrides the model alias", () => {
  const workspace = writeStageWorkspace();
  const configPath = path.join(workspace, ".migent", "config.yaml");
  writeFileSync(configPath, readFileSync(configPath, "utf8").replace(
    '    client:\n      type: codex\n      options:\n        model_reasoning_effort: medium\n        temperature: "0.2"',
    '    effort: low\n    client:\n      type: codex\n      options:\n        temperature: "0.2"',
  ));
  expect(resolveRoleTarget(workspace, "reviewer", undefined, registry).options.model_reasoning_effort).toBe("low");
  expect(resolveStageTarget(workspace, "plan-implement", "review-work", undefined, registry).options.model_reasoning_effort).toBe("high");
});


test("rejects effort conflicts introduced by local config merge", () => {
  const merged = mergeConfig(
    { agents: { fast: { client: { type: "codex" }, model: "test", effort: "high" } } },
    { agents: { fast: { client: { options: { model_reasoning_effort: "low" } } } } },
  );
  expect(() => loadAgentTarget(merged, "fast", registry)).toThrow(/conflicts with agents.fast.client.options.model_reasoning_effort/);
});


test("resolves effort through an injected client without knowing client names", () => {
  const custom = registryOf({
    custom: Object.assign(new FakeClient("custom", "custom-cli"), { effortOption: "custom_thinking_level" }),
    alternate: Object.assign(new FakeClient("alternate", "alternate-cli"), { effortOption: "alternate_level" }),
  });
  expect(loadAgentTarget({ agents: { fast: { client: { type: "custom" }, model: "m", effort: "high" } } }, "fast", custom).options)
    .toEqual({ custom_thinking_level: "high" });
  expect(loadAgentTarget({ agents: { fast: { client: { type: "alternate" }, model: "m", effort: "max" } } }, "fast", custom).options)
    .toEqual({ alternate_level: "max" });
});
