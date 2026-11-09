import { expect, test } from "vitest";
import {
  ConfigurationError,
  field,
  listAgentDefinitions,
  mergeConfigLayers,
  resolveEffectiveClient,
  loadRoleResponsibilities,
  resolveRoleCascade,
} from "../src/index.ts";
import { parseYamlDocument } from "@nodeint/migent-workflow";
import { defaultClients } from "./support.ts";

const merge = (project: Record<string, unknown>, local?: Record<string, unknown>) => mergeConfigLayers(project, local);

test("a local agent replaces the project's wholesale and owns its subtree", () => {
  const merged = merge(
    { roles: { dev: { agent: { client: { type: "a" }, model: "m" } } } },
    { roles: { dev: { agent: { model: "x" } } } },
  );
  expect(merged.config.roles).toEqual({ dev: { agent: { model: "x" } } });
  expect(merged.ownerOf(["roles", "dev", "agent", "client"])).toBe("local");
});

test("owner follows the merge boundaries", () => {
  const merged = merge(
    { schema_version: 5, agents: { x: {}, y: { client: { type: "a" } } }, roles: "oops", list: [1] },
    { schema_version: 9, agents: { x: { model: "m" } }, roles: { dev: {} }, list: [2] },
  );
  expect(merged.ownerOf(["schema_version"])).toBe("project");
  expect(merged.ownerOf(["agents", "y"])).toBe("project");
  expect(merged.ownerOf(["agents", "x", "model"])).toBe("local");
  expect(merged.ownerOf(["agents", "x", "client"])).toBe("merged");
  expect(merged.ownerOf(["agents"])).toBe("merged");
  expect(merged.ownerOf(["roles", "dev", "agent"])).toBe("local");
  expect(merged.ownerOf(["list", "0"])).toBe("local");
  expect(merge({ agents: { x: {} } }).ownerOf(["agents", "x", "client"])).toBe("project");
  expect(merged.config.schema_version).toBe(5);
});

test("an alias only the project defines belongs to the project", () => {
  const merged = merge({ agents: { x: {} } }, { agents: { other: { client: { type: "a" } } } });
  expect(merged.ownerOf(["agents", "x"])).toBe("project");
  expect(merged.ownerOf(["agents", "x", "client"])).toBe("project");
});

test("rule errors carry a code and the path of the field", () => {
  try {
    resolveRoleCascade({ roles: { dev: { agent: "nope" } } }, "dev", undefined, defaultClients());
    throw new Error("expected a throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).code).toBe("unknown-agent");
    expect((error as ConfigurationError).path).toEqual(["roles", "dev", "agent"]);
  }
  expect(field("roles", "dev", "instructions")).toEqual({ label: "roles.dev.instructions", path: ["roles", "dev", "instructions"] });
});

test("paths keep dotted and bracketed keys as single segments", () => {
  const config = { agents: { "gpt.5": { client: { type: "codex" } } }, roles: { "a.b": { agent: "gpt.5" } } };
  const thrown = (run: () => unknown): ConfigurationError => {
    try { run(); } catch (error) { return error as ConfigurationError; }
    throw new Error("expected a throw");
  };
  expect(thrown(() => resolveRoleCascade(config, "a.b", undefined, defaultClients())).path).toEqual(["agents", "gpt.5", "model"]);
  expect(thrown(() => resolveRoleCascade({ roles: { "a.b": {} } }, "a.b", undefined, defaultClients())).path)
    .toEqual(["roles", "a.b", "agent"]);
  expect(thrown(() => loadRoleResponsibilities({ roles: { "a.b": { responsibilities: "x" } } }, "a.b")).path)
    .toEqual(["roles", "a.b", "responsibilities"]);
  // The project owns client; local only supplies model. The dotted alias must not hide that.
  const merged = mergeConfigLayers(
    { agents: { "gpt.5": { client: { type: "nope" } } } },
    { agents: { "gpt.5": { model: "m" } } },
  );
  expect(merged.ownerOf(["agents", "gpt.5", "client"])).toBe("project");
  expect(merged.ownerOf(["agents", "gpt.5", "model"])).toBe("local");
});

test("option errors carry the exact option path", () => {
  const config = { agents: { x: { client: { type: "codex", options: { a: 3 } }, model: "m" } }, roles: { dev: { agent: "x" } } };
  try {
    resolveRoleCascade(config, "dev", undefined, defaultClients());
    throw new Error("expected a throw");
  } catch (error) {
    expect((error as ConfigurationError).code).toBe("option-invalid");
    expect((error as ConfigurationError).path).toEqual(["agents", "x", "client", "options", "a"]);
  }
});

test("a YAML syntax error keeps its position", () => {
  try {
    parseYamlDocument("a: [1,\n  b: }");
    throw new Error("expected a throw");
  } catch (error) {
    expect((error as ConfigurationError).code).toBe("yaml-syntax");
    expect((error as ConfigurationError).position?.line).toBeGreaterThan(0);
  }
});

test("agent definitions list aliases sorted, then inline role defaults", () => {
  const entries = listAgentDefinitions({
    agents: { b: {}, a: {} },
    roles: { dev: { agent: { client: { type: "x" } } }, qa: { agent: "a" } },
  });
  expect(entries.map((entry) => [entry.key, entry.field])).toEqual([
    ["a", "agents.a"],
    ["b", "agents.b"],
    ["roles.dev.agent", "roles.dev.agent"],
  ]);
});

test("client binding reports what failed without spawning anything", () => {
  const clients = defaultClients();
  const target = (client: string, options: Record<string, string> = {}) => ({ client, model: "m", options });
  expect(resolveEffectiveClient(clients, target("nope")).failure?.code).toBe("client-unsupported");
  expect(resolveEffectiveClient(clients, target("codex")).client?.command).toBe("codex");
  const bad = resolveEffectiveClient(clients, target("codex", { "bad key": "x" }));
  expect(bad.failure?.code).toBe("options-invalid");
  expect(bad.client?.command).toBe("codex");
});
