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
    expect(config).toContain("schema_version: 1");
    expect(workflow).toContain("schema_version: 1");
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
    expect(captured.stdout).toContain('migent start implement --task "..."');
    expect(captured.stdout).toContain("ok");
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
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("interactive plan review can choose a second model", async () => {
  const workspace = tempDir();
  try {
    const code = await runInit(workspace, {
      preset: "plan",
      interactive: true,
      runCommand,
      which: which(new Set(["codex", "grok"])),
      prompter: new ScriptedPrompt(["", "gpt-5", "", "n", "grok", "", "high"]),
    });
    const config = readFileSync(path.join(workspace, ".migent", "config.yaml"), "utf8");
    expect(code).toBe(0);
    expect(config).toContain("provider: codex");
    expect(config).toContain("model: gpt-5");
    expect(config).not.toContain("model_reasoning_effort:");
    expect(config).toContain("provider: grok");
    expect(config).toContain("model: grok-4.7");
    expect(config).toContain("reasoning-effort: high");
    expect(config).toContain("default_model: review");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("interactive prefers an installed provider", async () => {
  const workspace = tempDir();
  try {
    const code = await runInit(workspace, {
      interactive: true,
      runCommand,
      which: which(new Set(["grok"])),
      prompter: new ScriptedPrompt(["", "", ""]),
    });
    const config = readFileSync(path.join(workspace, ".migent", "config.yaml"), "utf8");
    expect(code).toBe(0);
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

test("requires provider and model when not interactive", async () => {
  const workspace = tempDir();
  try {
    const first = await capture(() => main(["init"], workspace));
    expect(first.value).toBe(2);
    expect(existsSync(path.join(workspace, ".migent"))).toBe(false);
    expect(first.stderr).toContain("--provider");
    const second = await capture(() => main(["init", "--provider", "codex"], workspace));
    expect(second.value).toBe(2);
    expect(second.stderr).toContain("--model");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
