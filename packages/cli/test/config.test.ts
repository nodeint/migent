import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadYamlMapping } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { main } from "../src/index.ts";
import { runMigrate } from "../src/migrate.ts";
import { capture } from "./support.ts";

const CONFIG = `\
schema_version: 4
models:
  shared:
    provider: grok
    model: grok-4.6
    options:
      reasoning-effort: medium
      max_turns: "4"
  plain:
    provider: grok
    model: grok-4.7
roles:
  developer:
    default_model: shared
  reviewer:
    default_model: shared
`;

const WORKFLOW = `\
schema_version: 4
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
    for (const argv of [["config", "show"], ["config", "model", "shared", "--provider", "grok"], ["config", "role", "developer"]]) {
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
    expect(JSON.parse(plain.stdout)).toMatchObject({ local: null, config: { models: { shared: { model: "grok-4.6" } } } });
    writeFileSync(
      path.join(workspace, ".migent", "config.local.yaml"),
      "models:\n  shared:\n    model: grok-local\n",
      "utf8",
    );
    const merged = await capture(() => main(["config", "--json"], workspace));
    expect(merged.value).toBe(0);
    expect(JSON.parse(merged.stdout)).toMatchObject({
      local: { file: ".migent/config.local.yaml", models: ["shared"] },
      config: { models: { shared: { model: "grok-local" }, plain: { model: "grok-4.7" } } },
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
      "models:\n  shared:\n    model: grok-local\n",
      "utf8",
    );
    const shown = await capture(() => main(["config"], workspace));
    expect(shown.value).toBe(0);
    expect(shown.stdout).toContain("model: grok-local");
    expect(shown.stdout).toContain("model: grok-4.7");
    expect(shown.stderr).toContain("Merged with .migent/config.local.yaml. Local models: shared.");
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
    expect(migrated.stdout).toContain("Upgraded schema to version 4.");
    const models = config.models as { grok: { options: Record<string, string> } };
    const roles = config.roles as { developer: Record<string, unknown> & { options: Record<string, string> } };
    expect(models.grok.options["reasoning-effort"]).toBe("medium");
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
    const original = readFileSync(configPath, "utf8").replace("schema_version: 4\n", "");
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
    expect(String(loaded.schema_version)).toBe("4");
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
