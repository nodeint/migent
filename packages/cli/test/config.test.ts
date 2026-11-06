import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadYamlMapping } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { main } from "../src/index.ts";
import { requireCurrentSchema, runMigrate } from "../src/migrate.ts";
import { capture } from "./support.ts";

const CONFIG = `\
schema_version: 6
agents:
  shared:
    client:
      type: grok
      options:
        reasoning-effort: medium
        max_turns: "4"
    model: grok-4.6
  plain:
    client:
      type: grok
    model: grok-4.7
roles:
  developer:
    agent: shared
  reviewer:
    agent: shared
`;

const WORKFLOW = `\
schema_version: 6
id: plan
stages:
  - id: implement
    role: developer
    depends_on: []
  - id: review
    role: reviewer
    model: plain
    depends_on: []
  - id: plain-review
    role: reviewer
    depends_on:
      - review
`;

function project(root: string): void {
  const workflows = path.join(root, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(root, ".migent", "config.yaml"), CONFIG, "utf8");
  writeFileSync(path.join(workflows, "plan.yaml"), WORKFLOW, "utf8");
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "migent-cli-"));
}

test("config without a workspace exits 2 and help lists only the read-only command", async () => {
  const workspace = tempDir();
  try {
    const captured = await capture(() => main(["config"], workspace));
    expect(captured.value).toBe(2);
    expect(captured.stderr).toContain(".migent/config.yaml");
    const help = await capture(() => main(["config", "--help"]));
    expect(help.value).toBe(0);
    expect(help.stdout).toContain("--json");
    expect(help.stdout).not.toMatch(/^ {2}(show|model|role)\b/m);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("config prints the config file without migrating it", async () => {
  const workspace = tempDir();
  try {
    project(workspace);
    const captured = await capture(() => main(["config"], workspace));
    expect(captured.value).toBe(0);
    expect(captured.stdout).toBe(readFileSync(path.join(workspace, ".migent", "config.yaml"), "utf8"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("removed config subcommands exit 2 and name the replacement", async () => {
  const workspace = tempDir();
  try {
    project(workspace);
    const configPath = path.join(workspace, ".migent", "config.yaml");
    const before = readFileSync(configPath, "utf8");
    for (const argv of [["config", "show"], ["config", "model", "shared", "--client", "grok"], ["config", "role", "developer"]]) {
      const captured = await capture(() => main(argv, workspace));
      expect(captured.value).toBe(2);
      expect(captured.stderr).toContain("was removed");
      expect(captured.stderr).toContain(".migent/config.local.yaml");
      expect(captured.stderr).toContain("migent doctor");
    }
    expect(readFileSync(configPath, "utf8")).toBe(before);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("config --json prints the merged config and the local model names", async () => {
  const workspace = tempDir();
  try {
    project(workspace);
    const plain = await capture(() => main(["config", "--json"], workspace));
    expect(plain.value).toBe(0);
    expect(JSON.parse(plain.stdout)).toMatchObject({ local: null, config: { agents: { shared: { model: "grok-4.6" } } } });
    writeFileSync(
      path.join(workspace, ".migent", "config.local.yaml"),
      "agents:\n  shared:\n    model: grok-local\n",
      "utf8",
    );
    const merged = await capture(() => main(["config", "--json"], workspace));
    expect(merged.value).toBe(0);
    expect(JSON.parse(merged.stdout)).toMatchObject({
      local: { file: ".migent/config.local.yaml", agents: ["shared"] },
      config: { agents: { shared: { model: "grok-local" }, plain: { model: "grok-4.7" } } },
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("config prints the merged config and names the local models when config.local.yaml exists", async () => {
  const workspace = tempDir();
  try {
    project(workspace);
    writeFileSync(
      path.join(workspace, ".migent", "config.local.yaml"),
      "agents:\n  shared:\n    model: grok-local\n",
      "utf8",
    );
    const shown = await capture(() => main(["config"], workspace));
    expect(shown.value).toBe(0);
    expect(shown.stdout).toContain("model: grok-local");
    expect(shown.stdout).toContain("model: grok-4.7");
    expect(shown.stderr).toContain("Merged with .migent/config.local.yaml. Local agents: shared.");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});


test("migrate upgrades an outdated schema", async () => {
  const legacy = `models:
  grok:
    provider: grok
    model: grok-4.6
    options:
      thinking: medium
roles:
  developer:
    default_model: grok
    thinking: high
`;
  const workflow = "id: plan\nstages:\n  - id: implement\n    role: developer\n    depends_on: []\n";
  const workspace = tempDir();
  try {
    project(workspace);
    const configPath = path.join(workspace, ".migent", "config.yaml");
    const workflowPath = path.join(workspace, ".migent", "workflows", "plan.yaml");
    writeFileSync(configPath, legacy, "utf8");
    writeFileSync(workflowPath, workflow, "utf8");
    const migrated = await capture(() => runMigrate(workspace, { assumeYes: true }));
    const config = loadYamlMapping(configPath);
    expect(migrated.value).toBe(0);
    expect(migrated.stdout).toContain("Upgraded schema to version 6.");
    const agents = config.agents as { grok: { client: { type: string; options: Record<string, string> } } };
    const roles = config.roles as { developer: Record<string, unknown> & { options: Record<string, string> } };
    expect(config).not.toHaveProperty("models");
    expect(agents.grok.client.type).toBe("grok");
    expect(agents.grok.client.options["reasoning-effort"]).toBe("medium");
    expect(roles.developer.options["reasoning-effort"]).toBe("high");
    expect(roles.developer).not.toHaveProperty("thinking");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("migrate asks before writing and yes skips the question", async () => {
  const workspace = tempDir();
  try {
    project(workspace);
    const configPath = path.join(workspace, ".migent", "config.yaml");
    const original = readFileSync(configPath, "utf8").replace("schema_version: 6\n", "");
    writeFileSync(configPath, original, "utf8");
    const declined = await capture(() => runMigrate(workspace, { confirm: () => false }));
    const refused = await capture(() => main(["migrate"], workspace));
    expect(declined.value).toBe(0);
    expect(declined.stdout).toContain("Left unchanged.");
    expect(refused.value).toBe(2);
    expect(refused.stderr).toContain("--yes");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    const upgraded = await main(["migrate", "--yes"], workspace);
    expect(upgraded).toBe(0);
    const loaded = loadYamlMapping(configPath);
    expect(String(loaded.schema_version)).toBe("6");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("migrate lists deleted stage options and says when comments cannot be kept", async () => {
  const workspace = tempDir();
  try {
    project(workspace);
    const root = path.join(workspace, ".migent");
    writeFileSync(
      path.join(root, "config.yaml"),
      "# note\nschema_version: 4\nmodels: { fast: { provider: grok, model: grok-4.6 } }\nroles:\n  developer:\n    default_model: fast\n",
      "utf8",
    );
    writeFileSync(
      path.join(root, "workflows", "plan.yaml"),
      'schema_version: 4\nid: plan\nstages:\n  - id: implement\n    role: developer\n    depends_on: []\n    options:\n      max_turns: "4"\n',
      "utf8",
    );
    const result = await capture(() => runMigrate(workspace, { assumeYes: true }));
    expect(result.value).toBe(0);
    const notes = `${result.stdout}${result.stderr}`;
    expect(notes).toContain("stages.implement.options.max_turns removed");
    expect(notes).toContain(".migent/config.yaml: comments could not be preserved by this migration");
    expect(readFileSync(path.join(root, "workflows", "plan.yaml"), "utf8")).toBe(
      "schema_version: 6\nid: plan\nstages:\n  - id: implement\n    role: developer\n    depends_on: []\n",
    );
    expect(loadYamlMapping(path.join(root, "config.yaml"))).toEqual({
      schema_version: 6,
      agents: { fast: { client: { type: "grok" }, model: "grok-4.6" } },
      roles: { developer: { agent: "fast" } },
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("migrate does not modify a session directory", async () => {
  const workspace = tempDir();
  try {
    project(workspace);
    const sessionDir = path.join(workspace, ".migent", "sessions", "kept");
    mkdirSync(sessionDir, { recursive: true });
    const marker = path.join(sessionDir, "manifest.yaml");
    const body = "session_id: kept\nstatus: running\n";
    writeFileSync(marker, body, "utf8");
    const captured = await capture(() => runMigrate(workspace, { assumeYes: true }));
    expect(captured.value).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe(body);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("migrate versions both config layers and preserves roles without a default", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-layer-migration-"));
  const root = path.join(workspace, ".migent");
  mkdirSync(root);
  const base = "schema_version: 2\nmodels: {}\nroles:\n  architect:\n    instructions:\n      - Plan the work.\n";
  const local = "# Machine settings\nmodels:\n  local:\n    provider: codex\n    model: test\n    thinking: high\nroles:\n  architect:\n    default_model: local\n";
  writeFileSync(path.join(root, "config.yaml"), base);
  writeFileSync(path.join(root, "config.local.yaml"), local);
  try {
    expect(() => requireCurrentSchema(workspace)).toThrow(".migent/config.local.yaml");
    const result = await capture(() => runMigrate(workspace, { assumeYes: true }));
    expect(() => requireCurrentSchema(workspace)).not.toThrow();
    expect(result.value).toBe(0);
    expect(readFileSync(path.join(root, "config.yaml"), "utf8")).toBe(
      "schema_version: 6\nagents: {}\nroles:\n  architect:\n    responsibilities:\n      - Plan the work.\n",
    );
    const migrated = loadYamlMapping(path.join(root, "config.local.yaml"));
    expect(migrated.schema_version).toBe(6);
    expect(migrated.agents).toEqual({
      local: { client: { type: "codex", options: { model_reasoning_effort: "high" } }, model: "test" },
    });
    expect(migrated.roles).toEqual({ architect: { agent: "local" } });
    expect(readFileSync(path.join(root, "config.local.yaml"), "utf8")).toContain("# Machine settings");
    const second = await capture(() => runMigrate(workspace, { assumeYes: true }));
    expect(second.stdout).toContain("Schema is current.");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test.each([
  ["flow-style stages", 'schema_version: 4\nid: plan\nstages: [{ id: implement, role: developer, model: fast, options: { max_turns: "4" }, depends_on: [] }]\n'],
  ["a key on the dash line", 'schema_version: 4\nid: plan\nstages:\n  - model: fast\n    id: implement\n    role: developer\n    depends_on: []\n'],
  ["an empty options entry", 'schema_version: 4\nid: plan\nstages:\n  - id: implement\n    role: developer\n    model: fast\n    options:\n    depends_on: []\n'],
])("migrate handles a v4 workflow with %s", async (_label, text) => {
  const workspace = tempDir();
  try {
    project(workspace);
    const root = path.join(workspace, ".migent");
    writeFileSync(path.join(root, "config.yaml"), "schema_version: 4\nmodels:\n  fast:\n    provider: grok\n    model: grok-4.6\nroles:\n  developer:\n    default_model: fast\n", "utf8");
    writeFileSync(path.join(root, "workflows", "plan.yaml"), text, "utf8");
    const result = await capture(() => runMigrate(workspace, { assumeYes: true }));
    expect(result.value).toBe(0);
    const migrated = loadYamlMapping(path.join(root, "workflows", "plan.yaml")) as { schema_version: number; stages: Array<Record<string, unknown>> };
    expect(migrated.schema_version).toBe(6);
    expect(migrated.stages[0]).not.toHaveProperty("model");
    expect(migrated.stages[0]).not.toHaveProperty("options");
    expect(migrated.stages[0]?.agent).toBe("fast");
    expect(() => requireCurrentSchema(workspace)).not.toThrow();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
