import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelCatalog } from "@nodeint/migent-adapters";
import { createProviderResolver, diagnose, loadWorkflowDocument, loadWorkspaceConfig, resolveStageTarget, type Provider } from "@nodeint/migent-kernel";
import { defaultProviders } from "@nodeint/migent-adapters";
import { afterEach, expect, test } from "vitest";
import { cliHooks } from "../src/hooks.ts";
import { runInit, type Prompter } from "../src/commands/init.ts";
import { main } from "../src/index.ts";
import { capture } from "./support.ts";

function skillRecorder(code = 0): { calls: Array<{ argv: string[]; cwd: string }> } {
  const calls: Array<{ argv: string[]; cwd: string }> = [];
  cliHooks.skillRunner = (argv, cwd) => {
    calls.push({ argv, cwd });
    return code;
  };
  return { calls };
}

afterEach(() => {
  cliHooks.skillRunner = null;
  cliHooks.which = null;
  cliHooks.runCommand = null;
});

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

  selectProvider(rows: ReadonlyArray<readonly [string, string | null, Provider]>): string {
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
}

function which(found: ReadonlySet<string>): (command: string) => string | null {
  return (command) => (found.has(command) ? `/bin/${command}` : null);
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "migent-cli-"));
}

test("writes inline role models and both working presets", async () => {
  const workspace = tempDir();
  try {
    const captured = await capture(() =>
      runInit(workspace, {
        provider: "codex",
        model: "gpt-5",
        plannerProvider: "codex", plannerModel: "gpt-5",
        reviewerProvider: "codex",
        reviewerModel: "gpt-5",
        runCommand,
        which: which(new Set(["codex", "grok"])),
      }),
    );
    const config = readFileSync(path.join(workspace, ".migent", "config.yaml"), "utf8");
    const workflow = readFileSync(path.join(workspace, ".migent", "workflows", "implement.yaml"), "utf8");
    const gitignore = readFileSync(path.join(workspace, ".migent", ".gitignore"), "utf8");
    expect(captured.value).toBe(0);
    expect(config).toContain("schema_version: 4");
    expect(workflow).toContain("schema_version: 4");
    expect(loadWorkspaceConfig(workspace)).toMatchObject({
      schema_version: 4,
      roles: {
        developer: { default_model: { provider: "codex", model: "gpt-5" } },
        planner: { default_model: { provider: "codex", model: "gpt-5" } },
        reviewer: { default_model: { provider: "codex", model: "gpt-5" } },
      },
    });
    const roles = loadWorkspaceConfig(workspace).roles as Record<string, { instructions: string[] }>;
    expect(Object.keys(roles).sort()).toEqual(["developer", "planner", "reviewer"]);
    for (const role of Object.values(roles)) expect(role.instructions.length).toBeGreaterThan(0);
    expect(roles.planner?.instructions.join("\n")).toContain("do not modify project files");
    expect(roles.reviewer?.instructions.join("\n")).toContain("Do not modify project files");
    expect(existsSync(path.join(workspace, ".migent", "config.local.yaml"))).toBe(false);
    expect(workflow).toContain("id: implement");
    expect(workflow).toContain("role: developer");
    expect(gitignore).toBe("sessions/\nconfig.local.yaml\n");
    const providers = defaultProviders();
    expect(diagnose(workspace, { providers, which: which(new Set(["codex"])) }).every((check) => check.ok)).toBe(true);
    for (const [flow, stage] of [["implement", "implement"], ["implement", "review_work"], ["plan", "plan"], ["plan", "review_plan"]] as const) {
      expect(resolveStageTarget(workspace, flow, stage, undefined, createProviderResolver(providers))).toEqual({
        provider: "codex", model: "gpt-5", options: {},
      });
    }
    expect(captured.stdout).toContain(".migent/workflows/plan.yaml");
    expect(captured.stdout).toContain(".migent/workflows/implement.yaml");
    expect(captured.stdout).toContain('migent session run --workflow implement --task "<what you want done>"');
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
        plannerProvider: "codex", plannerModel: "gpt-5",
        reviewerProvider: "codex",
        reviewerModel: "gpt-5",
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
        plannerProvider: "codex", plannerModel: "gpt-5",
        reviewerProvider: "codex",
        reviewerModel: "gpt-5",
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
        plannerProvider: "codex", plannerModel: "gpt-5",
        reviewerProvider: "codex",
        reviewerModel: "gpt-5",
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

test("a lone config.local.yaml is a conflict and is left unchanged", async () => {
  const workspace = tempDir();
  try {
    const root = path.join(workspace, ".migent");
    mkdirSync(root);
    const local = path.join(root, "config.local.yaml");
    writeFileSync(local, "models: {}\n", "utf8");
    const captured = await capture(() =>
      runInit(workspace, { provider: "codex", model: "gpt-5", plannerProvider: "codex", plannerModel: "gpt-5", reviewerProvider: "codex", reviewerModel: "gpt-5", runCommand, which: which(new Set(["codex"])) }),
    );
    expect(captured.value).toBe(1);
    expect(readFileSync(local, "utf8")).toBe("models: {}\n");
    expect(existsSync(path.join(root, "config.yaml"))).toBe(false);
    expect(captured.stderr).toContain(".migent/config.local.yaml");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("planner has its own model and each workflow uses the reviewer model", async () => {
  const workspace = tempDir();
  try {
    const code = await runInit(workspace, {
      provider: "codex",
      model: "gpt-5",
      plannerProvider: "grok", plannerModel: "grok-4.6",
      reviewerProvider: "grok",
      reviewerModel: "grok-4.7",
      runCommand,
      which: which(new Set(["codex", "grok"])),
    });
    const config = readFileSync(path.join(workspace, ".migent", "config.yaml"), "utf8");
    const workflow = readFileSync(path.join(workspace, ".migent", "workflows", "plan.yaml"), "utf8");
    expect(code).toBe(0);
    const resolve = createProviderResolver(defaultProviders());
    expect(resolveStageTarget(workspace, "plan", "plan", undefined, resolve)).toMatchObject({ provider: "grok", model: "grok-4.6" });
    expect(resolveStageTarget(workspace, "plan", "review_plan", undefined, resolve)).toMatchObject({ provider: "grok", model: "grok-4.7" });
    expect(config).not.toContain("models:");
    expect(config).toContain("planner:");
    expect(workflow).toContain("role: planner");
    expect(resolveStageTarget(workspace, "implement", "review_work", undefined, resolve)).toMatchObject({ provider: "grok", model: "grok-4.7" });
    expect(workflow).toContain("id: plan");
    expect(loadWorkflowDocument(path.join(workspace, ".migent", "workflows", "plan.yaml")).stages.review_plan?.routes.revise).toBe("plan");
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
        prompter: new ScriptedPrompt(["", "", "", "", "", "", "", "", ""]),
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
      plannerProvider: "codex", plannerModel: "gpt-5",
      reviewerProvider: "codex",
      reviewerModel: "gpt-5",
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
        plannerProvider: "codex", plannerModel: "gpt-5",
        reviewerProvider: "codex",
        reviewerModel: "gpt-5",
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
        plannerProvider: "codex", plannerModel: "gpt-5",
        reviewerProvider: "codex",
        reviewerModel: "gpt-5",
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

test("init succeeds without npx and suggests a separate skill command", async () => {
  const workspace = tempDir();
  const { calls } = skillRecorder(1);
  try {
    const result = await capture(() => runInit(workspace, {
      provider: "codex", model: "gpt-5",
      plannerProvider: "codex", plannerModel: "gpt-5",
      reviewerProvider: "codex", reviewerModel: "gpt-5",
      runCommand, which: which(new Set(["codex"])),
    }));
    expect(result.value).toBe(0);
    expect(calls).toEqual([]);
    expect(existsSync(path.join(workspace, ".migent/config.yaml"))).toBe(true);
    expect(result.stdout).toContain("migent skill install --project");
    expect(result.stdout).toContain("migent session run --workflow implement");
    expect(result.stdout.indexOf("migent skill install --project"))
      .toBeLessThan(result.stdout.indexOf("migent session run"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test.each(["missing npx", "installer failure"])("skill %s after init preserves the project and can be retried", async (failure) => {
  const workspace = tempDir();
  const { calls } = skillRecorder(1);
  try {
    const initialized = await capture(() => runInit(workspace, {
      provider: "codex", model: "gpt-5", options: ["model_reasoning_effort=low"],
      plannerProvider: "codex", plannerModel: "gpt-5",
      reviewerProvider: "grok", reviewerModel: "grok-4.7", reviewerOptions: ["reasoning-effort=high"],
      runCommand, which: which(new Set(["codex", "grok"])),
    }));
    expect(initialized.value, initialized.stderr).toBe(0);
    expect(calls).toEqual([]);
    const files = [".migent/config.yaml", ".migent/workflows/implement.yaml", ".migent/workflows/plan.yaml", ".migent/.gitignore"];
    const snapshot = () => files.map(file => readFileSync(path.join(workspace, file), "utf8"));
    const original = snapshot();
    cliHooks.which = which(new Set(failure === "missing npx" ? [] : ["npx"]));
    const failed = await capture(() => main(["skill", "install", "--project", "-y"], workspace));
    expect(failed.value).toBe(1);
    expect(failed.stderr).toContain(failure === "missing npx" ? "not found on PATH" : "npx skills exited with code 1");
    expect(snapshot()).toEqual(original);
    expect(calls).toHaveLength(failure === "missing npx" ? 0 : 1);

    const retry = skillRecorder();
    cliHooks.which = which(new Set(["npx"]));
    const installed = await capture(() => main(["skill", "install", "--project", "-y"], workspace));
    expect(installed.value).toBe(0);
    expect(retry.calls).toHaveLength(1);
    expect(retry.calls[0]?.argv).toEqual(expect.arrayContaining(["-a", "codex", "grok"]));
    expect(retry.calls[0]?.cwd).toBe(workspace);
    expect(snapshot()).toEqual(original);

    const existing = await capture(() => runInit(workspace, { runCommand, which: which(new Set()) }));
    expect(existing.value).toBe(0);
    expect(existing.stdout).toContain("Already initialized.");
    expect(existing.stdout).toContain("migent skill install --project");
    expect(retry.calls).toHaveLength(1);
    expect(snapshot()).toEqual(original);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("init --skill reports the replacement before prompting or writing files and is hidden from help", async () => {
  const workspace = tempDir();
  const { calls } = skillRecorder();
  try {
    const result = await capture(() => main(["init", "--skill"], workspace));
    expect(result.value).toBe(2);
    expect(result.stderr).toContain("init --skill has been removed");
    expect(result.stderr).toContain("migent init");
    expect(result.stderr).toContain("migent skill install --project");
    expect(existsSync(path.join(workspace, ".migent"))).toBe(false);
    expect(calls).toEqual([]);
    const help = await capture(() => main(["init", "--help"], workspace));
    expect(help.value).toBe(0);
    expect(help.stdout).not.toContain("--skill");
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
        plannerProvider: "codex", plannerModel: "gpt-5",
        reviewerProvider: "codex",
        reviewerModel: "gpt-5",
        runCommand,
        which: (command) => {
          seen += 1;
          return command === "codex" && seen <= 3 ? "/bin/codex" : null;
        },
      }),
    );
    expect(captured.value).toBe(0);
    expect(existsSync(path.join(workspace, ".migent", "config.yaml"))).toBe(true);
    expect(captured.stdout).toContain('migent session run --workflow implement --task "<what you want done>"');
    expect(captured.stdout).not.toContain("failed");
    expect(captured.stderr).toContain("Doctor reported problems:");
    expect(captured.stderr).toContain("not on PATH");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("already initialized ignores model selection flags", async () => {
  const workspace = tempDir();
  try {
    expect(
      await runInit(workspace, {
        provider: "codex",
        model: "gpt-5",
        plannerProvider: "codex", plannerModel: "gpt-5",
        reviewerProvider: "codex",
        reviewerModel: "gpt-5",
        runCommand,
        which: which(new Set(["codex"])),
      }),
    ).toBe(0);
    const captured = await capture(() =>
      runInit(workspace, {
        provider: "grok",
        model: "grok-4",
        plannerProvider: "codex", plannerModel: "gpt-5",
        reviewerProvider: "codex",
        reviewerModel: "gpt-5",
        options: ["reasoning=high"],
        runCommand,
        which: which(new Set()),
      }),
    );
    expect(captured.value).toBe(0);
    expect(captured.stderr).toContain("Already initialized; ignoring model selection flags.");
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
    expect(first.stderr).toContain("Pass --planner-provider and --planner-model for planner when init is not interactive.");
    const second = await capture(() => main(["init", "--provider", "codex"], workspace));
    expect(second.value).toBe(2);
    expect(second.stderr).toContain("--model");
    const previous = process.env.MIGENT_NO_INPUT;
    process.env.MIGENT_NO_INPUT = "1";
    try {
      const third = await capture(() => main(["init"], workspace));
      expect(third.value).toBe(2);
      expect(third.stderr).toContain("Pass --planner-provider and --planner-model for planner when init is not interactive.");
    } finally {
      if (previous === undefined) delete process.env.MIGENT_NO_INPUT;
      else process.env.MIGENT_NO_INPUT = previous;
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("initializes over an empty .migent directory", async () => {
  const workspace = tempDir();
  try {
    mkdirSync(path.join(workspace, ".migent"));
    const captured = await capture(() =>
      runInit(workspace, { provider: "codex", model: "gpt-5", plannerProvider: "codex", plannerModel: "gpt-5", reviewerProvider: "codex", reviewerModel: "gpt-5", runCommand, which: which(new Set(["codex"])) }),
    );
    expect(captured.value).toBe(0);
    expect(existsSync(path.join(workspace, ".migent", "config.yaml"))).toBe(true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("initializes over an empty .migent/workflows directory", async () => {
  const workspace = tempDir();
  try {
    mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
    const captured = await capture(() =>
      runInit(workspace, { provider: "codex", model: "gpt-5", plannerProvider: "codex", plannerModel: "gpt-5", reviewerProvider: "codex", reviewerModel: "gpt-5", runCommand, which: which(new Set(["codex"])) }),
    );
    expect(captured.value).toBe(0);
    expect(existsSync(path.join(workspace, ".migent", "workflows", "implement.yaml"))).toBe(true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("init runs only catalog listing commands, never an inference call", async () => {
  const workspace = tempDir();
  try {
    const seen: string[][] = [];
    const code = await runInit(workspace, {
      provider: "codex",
      model: "gpt-5",
      plannerProvider: "codex", plannerModel: "gpt-5",
      reviewerProvider: "codex",
      reviewerModel: "gpt-5",
      runCommand: (argv) => {
        seen.push(argv);
        return runCommand(argv);
      },
      which: which(new Set(["codex"])),
    });
    expect(code).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    for (const argv of seen) expect(argv.slice(0, 2)).toEqual(["codex", "debug"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});


test("non-interactive CLI requires all three role models and accepts the same model for each", async () => {
  const workspace = tempDir();
  cliHooks.which = which(new Set(["codex"]));
  cliHooks.runCommand = runCommand;
  try {
    const missing = await capture(() => main(["init", "--no-input", "--provider", "codex", "--model", "gpt-5"], workspace));
    expect(missing.value).toBe(2);
    expect(missing.stderr).toContain("--planner-provider and --planner-model");
    expect(existsSync(path.join(workspace, ".migent"))).toBe(false);
    cliHooks.which = which(new Set(["codex"]));
    cliHooks.runCommand = runCommand;
    const result = await capture(() => main([
      "init", "--no-input", "--provider", "codex", "--model", "gpt-5",
      "--planner-provider", "codex", "--planner-model", "gpt-5",
      "--planner-option", "model_reasoning_effort=medium",
      "--reviewer-provider", "codex", "--reviewer-model", "gpt-5",
      "--option", "model_reasoning_effort=low", "--reviewer-option", "model_reasoning_effort=high",
    ], workspace));
    expect(result.value, result.stderr).toBe(0);
    const resolve = createProviderResolver(defaultProviders());
    expect(resolveStageTarget(workspace, "plan", "plan", undefined, resolve).options).toEqual({ model_reasoning_effort: "medium" });
    expect(resolveStageTarget(workspace, "plan", "review_plan", undefined, resolve).options).toEqual({ model_reasoning_effort: "high" });
    expect(resolveStageTarget(workspace, "implement", "implement", undefined, resolve).options).toEqual({ model_reasoning_effort: "low" });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("interactive init saves each role independently without installing the skill", async () => {
  const workspace = tempDir();
  const { calls } = skillRecorder();
  const messages: string[] = [];
  const prompt = new ScriptedPrompt(["codex", "gpt-5", "low", "grok", "grok-4.7", "high", "codex", "gpt-5", "xhigh"]);
  const providerPrompt = prompt.selectProvider.bind(prompt);
  const modelPrompt = prompt.selectModel.bind(prompt);
  const prompter: Prompter = {
    selectProvider(rows, message) { messages.push(message); return providerPrompt(rows); },
    selectModel(provider, catalog, message) { messages.push(message); return modelPrompt(provider, catalog); },
    selectOption: prompt.selectOption.bind(prompt),
  };
  try {
    const result = await capture(() => runInit(workspace, {
      interactive: true, prompter, runCommand, which: which(new Set(["codex", "grok"])),
    }));
    expect(result.value, result.stderr).toBe(0);
    expect(messages).toEqual(["Planner provider", "Planner model", "Reviewer provider", "Reviewer model", "Developer provider", "Developer model"]);
    expect(Object.keys(loadWorkspaceConfig(workspace).roles)).toEqual(["planner", "reviewer", "developer"]);
    expect(result.stdout).toContain("migent skill install --project");
    const resolve = createProviderResolver(defaultProviders());
    expect(resolveStageTarget(workspace, "implement", "implement", undefined, resolve)).toEqual({
      provider: "codex", model: "gpt-5", options: { model_reasoning_effort: "xhigh" },
    });
    expect(resolveStageTarget(workspace, "plan", "review_plan", undefined, resolve)).toEqual({
      provider: "grok", model: "grok-4.7", options: { "reasoning-effort": "high" },
    });
    expect(resolveStageTarget(workspace, "plan", "plan", undefined, resolve)).toEqual({
      provider: "codex", model: "gpt-5", options: { model_reasoning_effort: "low" },
    });
    expect(calls).toEqual([]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test.each([
  { plannerProvider: "codex", plannerModel: "hidden" },
  { plannerProvider: "codex" },
  { plannerModel: "gpt-5" },
  { plannerOptions: ["model_reasoning_effort=high"] },
  { plannerProvider: "codex", plannerModel: "gpt-5", plannerOptions: ["model_reasoning_effort=max"] },
])("invalid planner selection leaves the project unwritten: %j", async (planner) => {
  const workspace = tempDir();
  try {
    const result = await capture(() => runInit(workspace, {
      ...planner,
      reviewerProvider: "codex", reviewerModel: "gpt-5",
      provider: "codex", model: "gpt-5",
      runCommand, which: which(new Set(["codex"])),
    }));
    expect(result.value).toBe(2);
    expect(existsSync(path.join(workspace, ".migent"))).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test.each([
  { reviewerProvider: "codex", reviewerModel: "hidden" },
  { reviewerProvider: "codex" },
  { reviewerModel: "gpt-5" },
  { reviewerOptions: ["model_reasoning_effort=high"] },
])("invalid reviewer selection leaves the project unwritten: %j", async (reviewer) => {
  const workspace = tempDir();
  try {
    const result = await capture(() => runInit(workspace, {
      plannerProvider: "codex", plannerModel: "gpt-5",
      provider: "codex", model: "gpt-5", ...reviewer,
      runCommand, which: which(new Set(["codex"])),
    }));
    expect(result.value).toBe(2);
    expect(existsSync(path.join(workspace, ".migent"))).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
