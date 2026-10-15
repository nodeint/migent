import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadYamlMapping } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { runConfigModel, runConfigRole, type ConfigPrompter } from "../src/commands/config.ts";
import { cliHooks } from "../src/hooks.ts";
import { main } from "../src/index.ts";
import { runMigrate } from "../src/migrate.ts";
import { capture } from "./support.ts";

const CONFIG = `\
schema_version: 1
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
schema_version: 1
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

function runCommand(argv: string[]): string {
  if (argv[0] === "grok" && argv[1] === "models") {
    return "Default model: grok-4.7\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n";
  }
  if (argv[0] === "codex" && argv[1] === "debug") {
    return JSON.stringify({
      models: [{ slug: "gpt-5", visibility: "list", supported_reasoning_levels: [{ effort: "high" }] }],
    });
  }
  if (argv[0] === "grok" && argv.includes("--reasoning-effort")) return "use one of: xhigh, high, medium, low";
  throw new Error(JSON.stringify(argv));
}

function which(command: string): string | null {
  if (command === "grok" || command === "codex") return `/bin/${command}`;
  return null;
}

class Answers implements ConfigPrompter {
  readonly textDefaults: string[] = [];
  private index = 0;

  constructor(private readonly answers: readonly string[]) {}

  select(): string {
    const value = this.answers[this.index];
    this.index += 1;
    if (value === undefined) throw new Error("scripted select ran out of answers");
    return value;
  }

  confirm(): boolean {
    const value = this.answers[this.index];
    this.index += 1;
    return value === "y";
  }

  text(_message: string, defaultValue = ""): string {
    this.textDefaults.push(defaultValue);
    const value = this.answers[this.index];
    this.index += 1;
    if (value === undefined) throw new Error("scripted text ran out of answers");
    return value;
  }
}

function project(root: string): void {
  const workflows = path.join(root, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(root, ".migent", "config.yaml"), CONFIG, "utf8");
  writeFileSync(path.join(workflows, "plan.yaml"), WORKFLOW, "utf8");
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "migent-cli-"));
}

test("config without a command prints help", async () => {
  const workspace = tempDir();
  try {
    const captured = await capture(() => main(["config"], workspace));
    expect(captured.value).toBe(2);
    expect(captured.stdout).toContain("show");
    expect(captured.stdout).toContain("model");
    expect(captured.stdout).toContain("role");
    expect(captured.stdout).not.toContain("models:");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("show prints the config file without migrating it", async () => {
  const workspace = tempDir();
  try {
    project(workspace);
    const captured = await capture(() => main(["config", "show"], workspace));
    expect(captured.value).toBe(0);
    expect(captured.stdout).toBe(CONFIG);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("outdated schema stops before a model edit", async () => {
  const legacy = `\
models:
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
    const captured = await capture(() =>
      runConfigModel(workspace, {
        interactive: true,
        prompter: new Answers(["grok"]),
        which,
        runCommand,
      }),
    );
    expect(captured.value).toBe(2);
    expect(captured.stderr).toContain("Schema is outdated. Run `migent migrate` to update.");
    expect(readFileSync(configPath, "utf8")).toBe(legacy);
    const migrated = await capture(() => runMigrate(workspace, { assumeYes: true }));
    const config = loadYamlMapping(configPath);
    expect(migrated.value).toBe(0);
    expect(migrated.stdout).toContain("Upgraded schema to version 1.");
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
    const original = readFileSync(configPath, "utf8").replace("schema_version: 1\n", "");
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
    expect(String(loaded.schema_version)).toBe("1");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("lists models as json", async () => {
  const workspace = tempDir();
  try {
    project(workspace);
    const captured = await capture(() => main(["config", "model", "--json"], workspace));
    const payload = JSON.parse(captured.stdout) as {
      models: Array<{ key: string; roles: string[]; options: Record<string, string>; stages: Array<{ workflow: string }> }>;
    };
    expect(captured.value).toBe(0);
    const shared = payload.models.find((model) => model.key === "shared");
    expect(shared?.roles).toEqual(["developer", "reviewer"]);
    expect(shared?.options.max_turns).toBe("4");
    expect(new Set(shared?.stages.map((stage) => stage.workflow))).toContain("plan");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("set role model name updates only that role", async () => {
  const workspace = tempDir();
  try {
    project(workspace);
    cliHooks.which = which;
    const captured = await capture(() =>
      main(["config", "role", "reviewer", "--model-name", "plain", "--json"], workspace),
    );
    const payload = JSON.parse(captured.stdout) as {
      wrote: boolean;
      roles: string[];
      stages_unchanged: Array<{ stage: string; ignores: string[] }>;
      stages_updated: Array<{ stage: string }>;
      doctor: { ok: boolean };
    };
    const config = loadYamlMapping(path.join(workspace, ".migent", "config.yaml"));
    const roles = config.roles as { developer: { default_model: string }; reviewer: { default_model: string } };
    const models = config.models as { shared: { model: string; options: Record<string, string> } };
    expect(captured.value).toBe(0);
    expect(payload.wrote).toBe(true);
    expect(payload.roles).toEqual(["reviewer"]);
    expect(roles.developer.default_model).toBe("shared");
    expect(roles.reviewer.default_model).toBe("plain");
    expect(models.shared.model).toBe("grok-4.6");
    expect(models.shared.options.max_turns).toBe("4");
    const unchanged = Object.fromEntries(payload.stages_unchanged.map((stage) => [stage.stage, stage.ignores]));
    expect(unchanged.review).toEqual(["role-model"]);
    expect(payload.stages_updated.map((stage) => stage.stage)).toContain("plain-review");
    expect(payload.doctor.ok).toBe(true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("role provider model does not rewrite a shared entry", async () => {
  const workspace = tempDir();
  try {
    project(workspace);
    const captured = await capture(() =>
      runConfigRole(workspace, {
        roles: ["reviewer"],
        provider: "grok",
        model: "grok-4.6",
        options: ["reasoning-effort=high"],
        asJson: true,
        which,
        runCommand,
      }),
    );
    const payload = JSON.parse(captured.stdout) as { created_model: string };
    const config = loadYamlMapping(path.join(workspace, ".migent", "config.yaml"));
    const models = config.models as {
      shared: { model: string; options: Record<string, string> };
      reviewer: Record<string, unknown>;
    };
    const roles = config.roles as {
      developer: { default_model: string };
      reviewer: { default_model: string; options: Record<string, string> };
    };
    expect(captured.value).toBe(0);
    expect(payload.created_model).toBe("reviewer");
    expect(models.shared.model).toBe("grok-4.6");
    expect(models.shared.options["reasoning-effort"]).toBe("medium");
    expect(roles.developer.default_model).toBe("shared");
    expect(roles.reviewer.default_model).toBe("reviewer");
    expect(roles.reviewer.options["reasoning-effort"]).toBe("high");
    expect(models.reviewer).not.toHaveProperty("options");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("model update reports every role using the key", async () => {
  const workspace = tempDir();
  try {
    project(workspace);
    const captured = await capture(() =>
      runConfigModel(workspace, {
        key: "shared",
        provider: "grok",
        model: "grok-4.7",
        asJson: true,
        which,
        runCommand,
      }),
    );
    const payload = JSON.parse(captured.stdout) as { updated_model: string; roles: string[] };
    const config = loadYamlMapping(path.join(workspace, ".migent", "config.yaml"));
    const shared = (config.models as { shared: { model: string; options: Record<string, string> } }).shared;
    expect(captured.value).toBe(0);
    expect(payload.updated_model).toBe("shared");
    expect(payload.roles).toEqual(["developer", "reviewer"]);
    expect(shared.model).toBe("grok-4.7");
    expect(shared.options["reasoning-effort"]).toBe("medium");
    expect(shared.options.max_turns).toBe("4");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("one model name can be assigned to several roles", async () => {
  const workspace = tempDir();
  try {
    project(workspace);
    cliHooks.which = which;
    const captured = await capture(() =>
      main(["config", "role", "developer", "reviewer", "--model-name", "plain", "--json"], workspace),
    );
    const payload = JSON.parse(captured.stdout) as { roles: string[] };
    const config = loadYamlMapping(path.join(workspace, ".migent", "config.yaml"));
    const roles = config.roles as { developer: { default_model: string }; reviewer: { default_model: string } };
    const models = config.models as { shared: { model: string } };
    expect(captured.value).toBe(0);
    expect(payload.roles).toEqual(["developer", "reviewer"]);
    expect(roles.developer.default_model).toBe("plain");
    expect(roles.reviewer.default_model).toBe("plain");
    expect(models.shared.model).toBe("grok-4.6");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects provider without model before writing", async () => {
  const workspace = tempDir();
  try {
    project(workspace);
    const captured = await capture(() => runConfigModel(workspace, { key: "shared", provider: "grok" }));
    expect(captured.value).toBe(2);
    expect(captured.stderr).toContain("--provider");
    expect(readFileSync(path.join(workspace, ".migent", "config.yaml"), "utf8")).toBe(CONFIG);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("interactive new model writes the key", async () => {
  const workspace = tempDir();
  try {
    project(workspace);
    const answers = new Answers(["__new__", "grok", "grok-4.7", "medium", "fast", "y"]);
    const captured = await capture(() =>
      runConfigModel(workspace, { interactive: true, prompter: answers, which, runCommand }),
    );
    expect(answers.textDefaults).toEqual([""]);
    const config = loadYamlMapping(path.join(workspace, ".migent", "config.yaml"));
    const fast = (config.models as { fast: { provider: string; model: string; options: Record<string, string> } }).fast;
    const developer = (config.roles as { developer: { default_model: string } }).developer;
    expect(captured.value).toBe(0);
    expect(fast.provider).toBe("grok");
    expect(fast.model).toBe("grok-4.7");
    expect(fast.options["reasoning-effort"]).toBe("medium");
    expect(developer.default_model).toBe("shared");
    expect(captured.stdout).toContain("ok");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("interactive role new model leaves the name empty", async () => {
  const workspace = tempDir();
  try {
    project(workspace);
    const answers = new Answers(["reviewer", "__new__", "grok", "grok-4.7", "high", "fresh", "y"]);
    const code = await runConfigRole(workspace, { interactive: true, prompter: answers, which, runCommand });
    const config = loadYamlMapping(path.join(workspace, ".migent", "config.yaml"));
    const roles = config.roles as { reviewer: { default_model: string }; developer: { default_model: string } };
    const fresh = (config.models as { fresh: { model: string } }).fresh;
    expect(code).toBe(0);
    expect(answers.textDefaults).toEqual([""]);
    expect(roles.reviewer.default_model).toBe("fresh");
    expect(fresh.model).toBe("grok-4.7");
    expect(roles.developer.default_model).toBe("shared");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("clear role option keeps the model name", async () => {
  const workspace = tempDir();
  try {
    project(workspace);
    const configPath = path.join(workspace, ".migent", "config.yaml");
    writeFileSync(
      configPath,
      CONFIG.replace(
        "  reviewer:\n    default_model: shared\n",
        "  reviewer:\n    default_model: shared\n    options:\n      reasoning-effort: high\n",
      ),
      "utf8",
    );
    const captured = await capture(() =>
      runConfigRole(workspace, {
        roles: ["reviewer"],
        clearOptions: ["reasoning-effort"],
        asJson: true,
        which,
        runCommand,
      }),
    );
    const config = loadYamlMapping(configPath);
    const reviewer = (config.roles as { reviewer: { default_model: string } & Record<string, unknown> }).reviewer;
    const shared = (config.models as { shared: { options: Record<string, string> } }).shared;
    expect(captured.value).toBe(0);
    expect(reviewer).not.toHaveProperty("options");
    expect(reviewer.default_model).toBe("shared");
    expect(shared.options["reasoning-effort"]).toBe("medium");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
