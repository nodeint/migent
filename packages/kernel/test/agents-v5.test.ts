import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import {
  ConfigurationError,
  SCHEMA_VERSION,
  getAgentView,
  getRoleView,
  listAgentDefinitions,
  loadRoleDescription,
  loadRoleResponsibilities,
  resolveRoleCascade,
  resolveStageSpec,
  unknownRoleKeyEntries,
  unknownWorkflowKeyEntries,
} from "../src/index.ts";
import { parseWorkflowMapping, type RoleStageSpec } from "../src/workflow.ts";
import { readWorkflowFreeze, writeWorkflowFreeze } from "../src/session-freeze.ts";
import { loadNamedWorkflow } from "../src/workflow.ts";
import { defaultClients, tempDir } from "./support.ts";

const resolver = defaultClients();

const CONFIG = {
  schema_version: 6,
  agents: {
    fast: { client: { type: "codex", options: { temperature: "0.2" } }, model: "gpt-5" },
    other: { client: { type: "grok" }, model: "grok-4" },
  },
  roles: {
    dev: { description: "Builds it.", agent: "fast", responsibilities: ["Write code."] },
  },
};

function stageOf(extra: Record<string, unknown> = {}): RoleStageSpec {
  const workflow = parseWorkflowMapping(
    { schema_version: 6, id: "w", stages: [{ id: "s", role: "dev", depends_on: [], ...extra }] },
    "test",
  );
  const stage = workflow.stages.s;
  if (stage === undefined || stage.kind !== "role") throw new Error("expected a role stage");
  return stage;
}

test("the current schema version is 6", () => {
  expect(SCHEMA_VERSION).toBe(6);
});

test("a v6 stage selects an agent by name or with a complete inline definition", () => {
  expect(stageOf().agent).toBeNull();
  expect(stageOf({ agent: " other " }).agent).toEqual({ kind: "named", name: "other" });
  const inline = { client: { type: "codex" }, model: "gpt-5", effort: "low" };
  expect(stageOf({ agent: inline }).agent).toEqual({ kind: "inline", value: inline });
  expect(() => stageOf({ agent: 3 })).toThrow("Missing or invalid stages.s.agent.");
  expect(() => stageOf({ agent: "" })).toThrow("Missing or invalid stages.s.agent.");
});

test("a v6 stage rejects the v4 model and options keys with their replacements", () => {
  expect(() => stageOf({ model: "fast" })).toThrow("stages.s.model was renamed to stages.s.agent in schema_version 5");
  expect(() => stageOf({ options: { a: "b" } })).toThrow("stages.s.options was removed in schema_version 5");
  const entries = unknownWorkflowKeyEntries({
    schema_version: 6,
    stages: [{ id: "s", role: "dev", model: "fast" }],
  });
  expect(entries.map((entry) => entry.path)).toEqual([["stages", 0, "model"]]);
});

test("a v4 workflow keeps reading model and options for frozen sessions", () => {
  const workflow = parseWorkflowMapping(
    { schema_version: 4, id: "w", stages: [{ id: "s", role: "dev", depends_on: [], model: "other", options: { a: "b" } }] },
    "test",
  );
  const stage = workflow.stages.s;
  expect(stage).toMatchObject({ agent: { kind: "named", name: "other" }, options: { a: "b" } });
});

test("stage agent resolution: named, inline, then the role's own", () => {
  const dev = resolveStageSpec(CONFIG, stageOf(), undefined, resolver);
  expect(dev).toEqual({ client: "codex", model: "gpt-5", options: { temperature: "0.2" } });
  expect(resolveStageSpec(CONFIG, stageOf({ agent: "other" }), undefined, resolver)).toEqual({
    client: "grok", model: "grok-4", options: {},
  });
  // The inline agent replaces the role's wholesale: nothing is inherited from it.
  expect(resolveStageSpec(CONFIG, stageOf({ agent: { client: { type: "grok" }, model: "x" } }), undefined, resolver)).toEqual({
    client: "grok", model: "x", options: {},
  });
  expect(() => resolveStageSpec(CONFIG, stageOf({ agent: "ghost" }), undefined, resolver)).toThrow(
    'stages.s.agent: unknown agent "ghost" in agents.',
  );
  expect(() => resolveStageSpec(CONFIG, stageOf({ agent: { client: { type: "codex" } } }), undefined, resolver)).toThrow(
    "Missing or invalid stages.s.agent.model.",
  );
});

test("client is a mapping with type and options", () => {
  const target = (client: unknown) => resolveRoleCascade(
    { agents: { a: { client, model: "m" } }, roles: { dev: { agent: "a" } } },
    "dev", undefined, resolver,
  );
  expect(target({ type: "codex", options: { temperature: "0.2" } })).toEqual({
    client: "codex", model: "m", options: { temperature: "0.2" },
  });
  expect(() => target("codex")).toThrow("agents.a.client must be a mapping: use agents.a.client.type");
  expect(() => target({ type: "codex", extra: 1 })).toThrow("agents.a.client.extra is not used by Migent.");
});

test("v4 keys in a v6 config name their replacements", () => {
  const code = (config: Record<string, unknown>): string | undefined => {
    try {
      resolveRoleCascade(config, "dev", undefined, resolver);
    } catch (error) {
      return (error as ConfigurationError).message;
    }
    return undefined;
  };
  expect(code({ models: {}, roles: { dev: {} } })).toContain("models was renamed to agents");
  expect(code({ roles: { dev: { default_model: "a" } } })).toContain("roles.dev.default_model was renamed to roles.dev.agent");
  expect(code({ roles: { dev: { agent: "a", instructions: ["x"] } } })).toContain(
    "roles.dev.instructions was renamed to roles.dev.responsibilities",
  );
  expect(code({ agents: { a: { client: { type: "codex" }, model: "m", options: { x: "y" } } }, roles: { dev: { agent: "a" } } })).toContain(
    "agents.a.options moved to agents.a.client.options",
  );
  expect(code({ agents: { a: { provider: "codex", model: "m" } }, roles: { dev: { agent: "a" } } })).toContain(
    "agents.a.provider was removed in schema_version 6; set agents.a.client.type",
  );
  const keys = unknownRoleKeyEntries({ roles: { dev: { default_model: "a", instructions: [], options: {} } } });
  expect(keys.map((entry) => entry.message)).toEqual([
    "roles.dev.default_model was renamed to roles.dev.agent in schema_version 5. Run `migent migrate`.",
    "roles.dev.instructions was renamed to roles.dev.responsibilities in schema_version 5. Run `migent migrate`.",
    "roles.dev.options is no longer supported. Move options into the role's agent under client.options.",
  ]);
});

test("role description and responsibilities are separate accessors", () => {
  expect(loadRoleDescription(CONFIG, "dev")).toBe("Builds it.");
  expect(loadRoleResponsibilities(CONFIG, "dev")).toEqual(["Write code."]);
  expect(loadRoleDescription({ roles: { dev: {} } }, "dev")).toBeNull();
  expect(() => loadRoleDescription({ roles: { dev: { description: "a\nb" } } }, "dev")).toThrow("roles.dev.description must be one line.");
});

test("definitions list named agents and inline role agents", () => {
  const entries = listAgentDefinitions({
    agents: { b: {}, a: {} },
    roles: { dev: { agent: { client: { type: "x" } } }, qa: { agent: "a" } },
  });
  expect(entries.map((entry) => entry.field)).toEqual(["agents.a", "agents.b", "roles.dev.agent"]);
});

test("a frozen v4 body keeps model and options; a v5 body writes agent", () => {
  const workspace = tempDir("migent-agents-v5-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), stringify(CONFIG));
  const session = tempDir("migent-agents-v5-session-");
  const write = (version: number, stage: Record<string, unknown>) => {
    writeFileSync(path.join(workspace, ".migent", "workflows", "w.yaml"), stringify({
      schema_version: version, id: "w", stages: [{ id: "s", role: "dev", depends_on: [], ...stage }],
    }));
    writeWorkflowFreeze(session, workspace, loadNamedWorkflow(workspace, "w"), resolver);
    return readWorkflowFreeze(session);
  };
  const v4 = write(4, { model: "other", options: { max_turns: "3" } });
  expect(v4?.workflow.schemaVersion).toBe(4);
  expect(v4?.workflow.stages.s).toMatchObject({ agent: { kind: "named", name: "other" }, options: { max_turns: "3" } });
  // The pin is the resolved target, so a later config change cannot reach a frozen session.
  expect(v4?.targets.s).toEqual({ client: "grok", model: "grok-4", options: { max_turns: "3" } });
  const v5 = write(5, { agent: { client: { type: "codex", options: { temperature: "0.5" } }, model: "gpt-5" } });
  expect(v5?.workflow.schemaVersion).toBe(5);
  expect(v5?.workflow.stages.s).toMatchObject({
    agent: { kind: "inline", value: { client: { type: "codex", options: { temperature: "0.5" } }, model: "gpt-5" } },
  });
  expect(v5?.targets.s).toEqual({ client: "codex", model: "gpt-5", options: { temperature: "0.5" } });
});

test("get views name the agent, its client, and the role description", () => {
  const workspace = tempDir("migent-agents-v5-views-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), stringify({
    ...CONFIG,
    agents: { ...CONFIG.agents, bp: { client: { type: "codex" }, model: "m" } },
  }));
  writeFileSync(path.join(workspace, ".migent", "config.local.yaml"), stringify({ agents: { other: { model: "grok-local" } } }));
  const agent = getAgentView(workspace, "bp", resolver);
  expect(agent).toMatchObject({ kind: "agent", name: "bp", client: "codex", local: false });
  expect(getAgentView(workspace, "other", resolver)).toMatchObject({ local: true, model: "grok-local" });
  expect(getRoleView(workspace, "dev", resolver)).toMatchObject({
    kind: "role", name: "dev", description: "Builds it.", agent: "fast", responsibilities: ["Write code."],
  });
  expect(() => getAgentView(workspace, "nope", resolver)).toThrow("Agent not found");
});
