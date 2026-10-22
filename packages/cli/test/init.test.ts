import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelCatalog } from "@nodeint/migent-adapters";
import type { AgentAdapter } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { runInit, type Prompter } from "../src/commands/init.ts";
import { main } from "../src/index.ts";
import { capture } from "./support.ts";

function runCommand(argv: string[]): string {
  if (argv[0] === "codex" && argv[1] === "debug") {
    return JSON.stringify({
      models: [
        {
          slug: "gpt-5",
          visibility: "list",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }],
        },
        { slug: "hidden", visibility: "hide" },
      ],
    });
  }
  if (argv[0] === "grok" && argv[1] === "models") {
    return "Default model: grok-4.7\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n";
  }
  if (argv[0] === "grok" && argv.includes("--reasoning-effort")) return "use one of: xhigh, high, medium, low";
  throw new Error(JSON.stringify(argv));
}

class ScriptedPrompt implements Prompter {
  private readonly answers: string[];
  private index = 0;

  constructor(answers: readonly string[]) {
    this.answers = [...answers];
  }

  selectProvider(rows: ReadonlyArray<readonly [string, string | null, AgentAdapter]>): string {
    const raw = this.answers[this.index++] ?? "";
    return raw === "" ? (rows[0]?.[0] ?? "") : raw;
  }

  selectModel(_provider: string, catalog: ModelCatalog): string {
    const raw = this.answers[this.index++] ?? "";
    if (raw === "") return catalog.defaultId || catalog.ids[0] || "";
    if (!catalog.ids.includes(raw)) throw new Error(`Unknown model: ${raw}.`);
    return raw;
  }

  selectOption(_name: string, values: readonly string[]): string {
    const raw = this.answers[this.index++] ?? "";
    if (raw === "") return "";
    if (!values.includes(raw)) throw new Error(`Unknown option value: ${raw}.`);
    return raw;
  }

  confirm(): boolean {
    const raw = this.answers[this.index++] ?? "";
    return raw !== "n" && raw !== "no";
  }
}

function which(found: ReadonlySet<string>): (command: string) => string | null {
  return (command) => (found.has(command) ? `/bin/${command}` : null);
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "migent-cli-"));
}

test("writes one provider and the implement workflow", async () => {
  const workspace = tempDir();
  try {
    const captured = await capture(() =>
      runInit(workspace, {
        provider: "codex",
        model: "gpt-5",
        runCommand,
        which: which(new Set(["codex", "grok"])),
      }),
    );
    const config = readFileSync(path.join(workspace, ".migent", "config.yaml"), "utf8");
    const workflow = readFileSync(path.join(workspace, ".migent", "workflows", "implement.yaml"), "utf8");
    const gitignore = readFileSync(path.join(workspace, ".migent", ".gitignore"), "utf8");
    expect(captured.value).toBe(0);
    expect(config).toContain("schema_version: 2");
    expect(workflow).toContain("schema_version: 2");
    expect(config).toContain("provider: codex");
    expect(config).toContain("model: gpt-5");
    expect(config).not.toContain("options");
    expect(config).toContain("default_model: default");
    expect(config).not.toContain("grok");
    expect(config).not.toContain("planner");
    expect(workflow).toContain("id: implement");
    expect(workflow).toContain("role: developer");
    expect(gitignore).toBe("sessions/\n");
    expect(captured.stdout).toContain(".migent/workflows/implement.yaml");
    expect(captured.stdout).toContain('migent session run --workflow implement --task "..."');
    expect(captured.stdout).not.toContain("providers");
    expect(captured.stderr).not.toContain("Doctor reported problems:");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses a partial project and leaves it unchanged", async () => {
  const workspace = tempDir();
  try {
    const root = path.join(workspace, ".migent");
    mkdirSync(root);
    const config = path.join(root, "config.yaml");
    writeFileSync(config, "partial: true\n", "utf8");
    const captured = await capture(() =>
      runInit(workspace, {
        provider: "codex",
        model: "gpt-5",
        runCommand,
        which: which(new Set(["codex"])),
      }),
    );
    expect(captured.value).toBe(1);
    expect(readFileSync(config, "utf8")).toBe("partial: true\n");
    expect(existsSync(path.join(root, "workflows"))).toBe(false);
    expect(captured.stderr).toContain(".migent/config.yaml");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reports an existing valid project without changing it", async () => {
  const workspace = tempDir();
  try {
    expect(
      await runInit(workspace, {
        provider: "codex",
        model: "gpt-5",
        runCommand,
        which: which(new Set(["codex"])),
      }),
    ).toBe(0);
    const config = path.join(workspace, ".migent", "config.yaml");
    const original = readFileSync(config, "utf8");
    const captured = await capture(() =>
      runInit(workspace, {
        provider: "grok",
        model: "grok-4",
        runCommand,
        which: which(new Set()),
      }),
    );
    expect(captured.value).toBe(0);
    expect(readFileSync(config, "utf8")).toBe(original);
    expect(captured.stdout).toContain("Already initialized.");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("plan review shares the default model", async () => {
  const workspace = tempDir();
  try {
    const code = await runInit(workspace, {
      provider: "codex",
      model: "gpt-5",
      preset: "plan",
      runCommand,
      which: which(new Set(["codex"])),
    });
    const config = readFileSync(path.join(workspace, ".migent", "config.yaml"), "utf8");
    const workflow = readFileSync(path.join(workspace, ".migent", "workflows", "plan.yaml"), "utf8");
    expect(code).toBe(0);
    expect(config).toContain("planner:");
    expect(config).toContain("reviewer:");
    expect(config).not.toContain("\n  review:");
    expect(workflow).toContain("id: plan");
    expect(workflow).toContain("revise: plan");
    expect(workflow).toContain("When revising, edit the existing plan.md in place. Do not replace the whole file.");
    expect(workflow).toContain("Report every gap of the same kind in one response.");
    expect(workflow).not.toContain("reasoning-effort");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("interactive prefers an installed provider", async () => {
  const workspace = tempDir();
  try {
    const captured = await capture(() =>
      runInit(workspace, {
        interactive: true,
        runCommand,
        which: which(new Set(["grok"])),
        prompter: new ScriptedPrompt(["", "", "", "n"]),
      }),
    );
    const config = readFileSync(path.join(workspace, ".migent", "config.yaml"), "utf8");
    expect(captured.value).toBe(0);
    expect(captured.stdout).toContain("providers");
    expect(captured.stdout).toContain("ok");
    expect(config).toContain("provider: grok");
    expect(config).toContain("model: grok-4.7");
    expect(config).not.toContain("codex");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("writes an option only when it is passed", async () => {
  const workspace = tempDir();
  try {
    const code = await runInit(workspace, {
      provider: "codex",
      model: "gpt-5",
      options: ["model_reasoning_effort=high"],
      runCommand,
      which: which(new Set(["codex"])),
    });
    const config = readFileSync(path.join(workspace, ".migent", "config.yaml"), "utf8");
    expect(code).toBe(0);
    expect(config).toContain("model_reasoning_effort: high");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects a model the provider cli did not list", async () => {
  const workspace = tempDir();
  try {
    const captured = await capture(() =>
      runInit(workspace, {
        provider: "codex",
        model: "hidden",
        runCommand,
        which: which(new Set(["codex"])),
      }),
    );
    expect(captured.value).toBe(2);
    expect(existsSync(path.join(workspace, ".migent"))).toBe(false);
    expect(captured.stderr).toContain("Unknown model: hidden");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects an option value the provider does not list", async () => {
  const workspace = tempDir();
  try {
    const captured = await capture(() =>
      runInit(workspace, {
        provider: "codex",
        model: "gpt-5",
        options: ["model_reasoning_effort=max"],
        runCommand,
        which: which(new Set(["codex"])),
      }),
    );
    expect(captured.value).toBe(2);
    expect(existsSync(path.join(workspace, ".migent"))).toBe(false);
    expect(captured.stderr).toContain("model_reasoning_effort must be one of");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("installs the skill when --skill is set", async () => {
  const workspace = tempDir();
  try {
    const captured = await capture(() =>
      runInit(workspace, {
        provider: "codex",
        model: "gpt-5",
        skill: true,
        runCommand,
        which: which(new Set(["codex"])),
      }),
    );
    const skill = readFileSync(path.join(workspace, ".agents", "skills", "migent", "SKILL.md"), "utf8");
    expect(captured.value).toBe(0);
    expect(skill).toContain("name: migent");
    expect(captured.stdout).toContain("Installed .agents/skills/migent");
    expect(existsSync(path.join(workspace, ".migent", "config.yaml"))).toBe(true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("leaves the skill uninstalled unless asked", async () => {
  const workspace = tempDir();
  try {
    const code = await runInit(workspace, {
      provider: "codex",
      model: "gpt-5",
      runCommand,
      which: which(new Set(["codex"])),
    });
    expect(code).toBe(0);
    expect(existsSync(path.join(workspace, ".agents"))).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("interactive init installs the skill only when confirmed", async () => {
  const workspace = tempDir();
  const declined = tempDir();
  try {
    const accepted = await runInit(workspace, {
      interactive: true,
      runCommand,
      which: which(new Set(["codex"])),
      prompter: new ScriptedPrompt(["", "gpt-5", "", "y"]),
    });
    const refused = await runInit(declined, {
      interactive: true,
      runCommand,
      which: which(new Set(["codex"])),
      prompter: new ScriptedPrompt(["", "gpt-5", "", "n"]),
    });
    expect(accepted).toBe(0);
    expect(existsSync(path.join(workspace, ".agents", "skills", "migent", "SKILL.md"))).toBe(true);
    expect(refused).toBe(0);
    expect(existsSync(path.join(declined, ".agents"))).toBe(false);
    expect(existsSync(path.join(declined, ".migent", "config.yaml"))).toBe(true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(declined, { recursive: true, force: true });
  }
});

test("refuses to replace an existing skill and writes no project", async () => {
  const workspace = tempDir();
  try {
    const skillDirectory = path.join(workspace, ".agents", "skills", "migent");
    mkdirSync(skillDirectory, { recursive: true });
    const custom = path.join(skillDirectory, "SKILL.md");
    writeFileSync(custom, "custom\n", "utf8");
    const captured = await capture(() =>
      runInit(workspace, {
        provider: "codex",
        model: "gpt-5",
        skill: true,
        runCommand,
        which: which(new Set(["codex"])),
      }),
    );
    expect(captured.value).toBe(1);
    expect(readFileSync(custom, "utf8")).toBe("custom\n");
    expect(existsSync(path.join(workspace, ".migent"))).toBe(false);
    expect(captured.stderr).toContain("already exists");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("--skill installs into an existing project", async () => {
  const workspace = tempDir();
  try {
    expect(
      await runInit(workspace, {
        provider: "codex",
        model: "gpt-5",
        runCommand,
        which: which(new Set(["codex"])),
      }),
    ).toBe(0);
    const config = readFileSync(path.join(workspace, ".migent", "config.yaml"), "utf8");
    const captured = await capture(() =>
      runInit(workspace, {
        provider: "codex",
        model: "gpt-5",
        skill: true,
        runCommand,
        which: which(new Set(["codex"])),
      }),
    );
    expect(captured.value).toBe(0);
    expect(captured.stdout).toContain("Already initialized.");
    expect(captured.stdout).toContain("Installed .agents/skills/migent");
    expect(readFileSync(path.join(workspace, ".migent", "config.yaml"), "utf8")).toBe(config);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("init exits 0 when doctor later reports a missing provider", async () => {
  const workspace = tempDir();
  try {
    let seen = 0;
    const captured = await capture(() =>
      runInit(workspace, {
        provider: "codex",
        model: "gpt-5",
        runCommand,
        which: (command) => {
          seen += 1;
          return command === "codex" && seen === 1 ? "/bin/codex" : null;
        },
      }),
    );
    expect(captured.value).toBe(0);
    expect(existsSync(path.join(workspace, ".migent", "config.yaml"))).toBe(true);
    expect(captured.stdout).toContain('migent session run --workflow implement --task "..."');
    expect(captured.stdout).not.toContain("failed");
    expect(captured.stderr).toContain("Doctor reported problems:");
    expect(captured.stderr).toContain("not on PATH");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("already initialized ignores provider model option and explicit preset", async () => {
  const workspace = tempDir();
  try {
    expect(
      await runInit(workspace, {
        provider: "codex",
        model: "gpt-5",
        runCommand,
        which: which(new Set(["codex"])),
      }),
    ).toBe(0);
    const captured = await capture(() =>
      runInit(workspace, {
        provider: "grok",
        model: "grok-4",
        options: ["reasoning=high"],
        preset: "plan",
        presetExplicit: true,
        runCommand,
        which: which(new Set()),
      }),
    );
    expect(captured.value).toBe(0);
    expect(captured.stderr).toContain("Already initialized; ignoring --provider/--model/--option.");
    expect(captured.stderr).toContain("Already initialized; ignoring --preset.");
    expect(captured.stdout).toContain("Already initialized.");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("requires provider and model when not interactive", async () => {
  const workspace = tempDir();
  try {
    const first = await capture(() => main(["init"], workspace));
    expect(first.value).toBe(2);
    expect(existsSync(path.join(workspace, ".migent"))).toBe(false);
    expect(first.stderr).toContain("Pass --provider and --model when init is not interactive.");
    const second = await capture(() => main(["init", "--provider", "codex"], workspace));
    expect(second.value).toBe(2);
    expect(second.stderr).toContain("--model");
    const previous = process.env.MIGENT_NO_INPUT;
    process.env.MIGENT_NO_INPUT = "1";
    try {
      const third = await capture(() => main(["init"], workspace));
      expect(third.value).toBe(2);
      expect(third.stderr).toContain("Pass --provider and --model when init is not interactive.");
    } finally {
      if (previous === undefined) delete process.env.MIGENT_NO_INPUT;
      else process.env.MIGENT_NO_INPUT = previous;
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
