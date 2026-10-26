import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { confirm as clackConfirm, isCancel, select as clackSelect } from "@clack/prompts";
import type { ModelCatalog } from "@nodeint/migent-adapters";
import {
  ConfigurationError,
  diagnose,
  whichSync,
  yamlScalar,
  type Provider,
  type ProviderOption,
} from "@nodeint/migent-kernel";
import { PromptCancelled } from "../errors.js";
import { exists, isDirectory, isFile } from "../fs-utils.js";
import {
  printAlreadyInitialized,
  printCreated,
  printError,
  printInitConflicts,
} from "../display.js";
import { cliHooks } from "../hooks.js";
import { runDoctor } from "./doctor.js";
import { clientsFromConfig, installSkill, projectSkillPath, providerClient } from "./skill.js";
import {
  acceptedOptions,
  providerMap,
  asCatalog,
  detected,
  knownModel,
  loadCatalog,
  loadOptionValues,
  parseOptions,
  requireProvider,
  runProviderCommand,
  type RunCommand,
  type Which,
} from "../provider.js";

export const PRESETS = ["implement", "plan"] as const;

export interface ModelChoice {
  provider: string;
  model: string;
  options: Record<string, string>;
}

export interface Prompter {
  selectProvider(
    rows: ReadonlyArray<readonly [string, string | null, Provider]>,
    message: string,
  ): string | Promise<string>;
  selectModel(provider: string, catalog: ModelCatalog, message: string): string | Promise<string>;
  selectOption(name: string, values: readonly string[], allowDefault: boolean): string | Promise<string>;
  confirm(message: string): boolean | Promise<boolean>;
}

export async function runInit(
  workspace: string,
  options: {
    provider?: string | null;
    model?: string | null;
    options?: readonly string[];
    preset?: string;
    presetExplicit?: boolean;
    skill?: boolean;
    interactive?: boolean;
    providers?: Record<string, Provider> | null;
    which?: Which | null;
    prompter?: Prompter | null;
    runCommand?: RunCommand | null;
  } = {},
): Promise<number> {
  const provider = options.provider ?? null;
  const model = options.model ?? null;
  const preset = options.preset ?? "implement";
  const skill = options.skill === true;
  const interactive = options.interactive ?? false;
  const chosen = options.providers ?? providerMap();
  const resolve = options.which ?? cliHooks.which ?? whichSync;
  const prompt = options.prompter ?? new ClackPrompter();
  const execute = options.runCommand ?? runProviderCommand;
  if (!PRESETS.includes(preset as (typeof PRESETS)[number])) {
    printError("preset must be implement or plan.");
    return 2;
  }
  const optionPairs = options.options ?? [];
  const classified = classify(workspace, chosen, resolve);
  if (classified.state === "ready") {
    if (provider !== null || model !== null || optionPairs.length > 0) {
      printError("Already initialized; ignoring --provider/--model/--option.");
    }
    if (options.presetExplicit === true) printError("Already initialized; ignoring --preset.");
    printAlreadyInitialized();
    if (skill) {
      return installSkill({ workspace, scope: "project", clients: clientsFromConfig(workspace, chosen), yes: true, which: resolve });
    }
    return 0;
  }
  if ((provider === null) !== (model === null)) {
    printError("Pass both --provider and --model, or omit both.");
    return 2;
  }
  if (optionPairs.length > 0 && provider === null) {
    printError("Pass --provider and --model with --option.");
    return 2;
  }
  if (provider === null && !interactive) {
    printError("Pass --provider and --model when init is not interactive.");
    return 2;
  }
  if (classified.state === "conflict") {
    printInitConflicts(classified.conflicts);
    return 1;
  }
  let primary: ModelChoice;
  try {
    primary = await choices(chosen, resolve, prompt, {
      provider,
      model,
      options: parseOptions(optionPairs),
      runCommand: execute,
    });
  } catch (error) {
    if (error instanceof PromptCancelled) throw error;
    printError(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const client = providerClient(chosen[primary.provider]);
  let install = skill;
  if (!install && interactive) {
    try {
      install = await prompt.confirm(`Install the Migent skill in ${projectSkillPath(client)}?`);
    } catch (error) {
      if (error instanceof PromptCancelled) throw error;
      printError(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (install) {
    const code = await installSkill({
      workspace,
      scope: "project",
      clients: client === null ? [] : [client],
      yes: true,
      which: resolve,
    });
    if (code !== 0) return 1;
  }
  const paths = writeProject(workspace, preset, primary);
  printCreated(paths, `migent session run --workflow ${preset} --task "..."`);
  if (interactive) {
    const doctorCode = await runDoctor(workspace, { which: resolve });
    if (doctorCode !== 0) writeDoctorProblems(workspace, chosen, resolve);
  } else {
    writeDoctorProblems(workspace, chosen, resolve);
  }
  return 0;
}

function writeDoctorProblems(
  workspace: string,
  providers: Record<string, Provider>,
  which: Which,
): void {
  const problems = diagnose(workspace, { providers, which }).flatMap((check) => check.problems);
  if (problems.length === 0) return;
  process.stderr.write("Doctor reported problems:\n");
  for (const problem of problems) process.stderr.write(`${problem}\n`);
}

async function choices(
  providers: Record<string, Provider>,
  which: Which,
  prompt: Prompter,
  args: {
    provider: string | null;
    model: string | null;
    options: Record<string, string>;
    runCommand: RunCommand;
  },
): Promise<ModelChoice> {
  let provider = args.provider;
  let model = args.model;
  let stored: Record<string, string>;
  if (provider === null) {
    const rows = detected(providers, which);
    provider = await prompt.selectProvider(rows, "Default provider");
    const impl = providers[provider];
    if (impl === undefined) throw new ConfigurationError(`Unknown provider: ${provider}.`);
    const catalog = await loadCatalog(impl, which, args.runCommand);
    model = await prompt.selectModel(provider, catalog, "Model");
    stored = await promptOptions(impl, model, catalog, which, args.runCommand, prompt);
  } else {
    const impl = requireProvider(providers, provider);
    if (model === null) throw new ConfigurationError("Model is required.");
    const catalog = await loadCatalog(impl, which, args.runCommand);
    model = knownModel(model, catalog);
    stored = await acceptedOptions(impl, model, catalog, which, args.runCommand, args.options);
  }
  if (model.trim() === "") throw new ConfigurationError("Model is required.");
  const primary = { provider, model: model.trim(), options: stored };
  return primary;
}

function classify(
  workspace: string,
  providers: Record<string, Provider>,
  which: Which,
): { state: "create" | "ready" | "conflict"; conflicts: string[] } {
  const root = path.join(workspace, ".migent");
  const config = path.join(root, "config.yaml");
  const workflows = path.join(root, "workflows");
  const gitignore = path.join(root, ".gitignore");
  const owned: string[] = [];
  if (exists(config)) owned.push(".migent/config.yaml");
  if (exists(path.join(root, "config.local.yaml"))) owned.push(".migent/config.local.yaml");
  if (exists(workflows) && !(isDirectory(workflows) && readdirSync(workflows).length === 0)) {
    owned.push(".migent/workflows");
    if (isDirectory(workflows)) {
      for (const name of readdirSync(workflows).filter((item) => item.endsWith(".yaml")).sort()) {
        if (isFile(path.join(workflows, name))) owned.push(`.migent/workflows/${name}`);
      }
    }
  }
  if (exists(gitignore)) owned.push(".migent/.gitignore");
  if (owned.length === 0) return { state: "create", conflicts: [] };
  const yamlFiles = isDirectory(workflows)
    ? readdirSync(workflows).filter((name) => name.endsWith(".yaml") && isFile(path.join(workflows, name)))
    : [];
  if (isFile(config) && yamlFiles.length > 0) {
    const checks = diagnose(workspace, { providers, which });
    const byName = new Map(checks.map((check) => [check.name, check]));
    if (byName.get("config")?.ok && byName.get("workflows")?.ok) return { state: "ready", conflicts: [] };
  }
  return { state: "conflict", conflicts: owned };
}

function writeProject(
  workspace: string,
  preset: string,
  primary: ModelChoice,
): string[] {
  const root = path.join(workspace, ".migent");
  const workflows = path.join(root, "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(root, "config.yaml"), renderConfig(preset), "utf8");
  writeFileSync(path.join(root, "config.local.yaml"), renderLocalConfig(preset, primary), "utf8");
  const workflowName = `${preset}.yaml`;
  writeFileSync(path.join(workflows, workflowName), renderWorkflow(preset), "utf8");
  writeFileSync(path.join(root, ".gitignore"), "sessions/\nconfig.local.yaml\n", "utf8");
  return [
    ".migent/config.yaml",
    ".migent/config.local.yaml",
    `.migent/workflows/${workflowName}`,
    ".migent/.gitignore",
  ];
}

type PresetRole = readonly [role: string, alias: string, instructions: readonly string[]];

function presetRoles(preset: string): readonly PresetRole[] {
  if (preset === "implement") {
    return [
      ["developer", "code_generation", [
        "Make the smallest change that completes the task; follow existing code conventions.",
        "Run the relevant checks or tests before finishing and report the result.",
      ]],
    ];
  }
  return [
    ["planner", "deep_reasoning", [
      "Write a concrete, reviewable plan: goal, steps, affected files, risks.",
      "Keep scope to the task; do not implement.",
    ]],
    ["reviewer", "critical_review", [
      "Check the plan for correctness, missing risks, and unnecessary scope.",
      "Give a clear verdict and list every gap in one response.",
    ]],
  ];
}

function presetAliases(preset: string): string[] {
  return [...new Set(presetRoles(preset).map(([, alias]) => alias))];
}

function renderConfig(preset: string): string {
  const lines = [
    "schema_version: 2",
    "# models: stable aliases. Map each one to a provider and model for this machine in .migent/config.local.yaml.",
    "# roles: who does the work; default_model names an alias in models.",
    "# roles.<name>.instructions are added to every prompt for that role, before stage instructions.",
    "# Workflows live in .migent/workflows/.",
    "models:",
  ];
  for (const alias of presetAliases(preset)) lines.push(`  ${alias}: {}`);
  lines.push("roles:");
  for (const [role, alias, instructions] of presetRoles(preset)) {
    lines.push(`  ${role}:`, `    default_model: ${alias}`, "    instructions:");
    for (const item of instructions) lines.push(`      - ${yamlScalar(item)}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderLocalConfig(preset: string, primary: ModelChoice): string {
  const lines = [
    "# This machine's provider and model for each alias in config.yaml. Not committed.",
    "models:",
  ];
  for (const alias of presetAliases(preset)) {
    lines.push(`  ${alias}:`, `    provider: ${yamlScalar(primary.provider)}`, `    model: ${yamlScalar(primary.model)}`);
    const entries = Object.entries(primary.options);
    if (entries.length > 0) {
      lines.push("    options:");
      for (const [optionName, value] of entries) lines.push(`      ${optionName}: ${yamlScalar(value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderWorkflow(preset: string): string {
  if (preset === "implement") {
    return (
      "schema_version: 2\n" +
      "id: implement\n" +
      "stages:\n" +
      "  - id: implement\n" +
      "    role: developer\n" +
      "    depends_on: []\n" +
      "    instructions:\n" +
      "      - Implement the requested change.\n" +
      "      - Verify the result with relevant checks or tests.\n"
    );
  }
  return (
    "schema_version: 2\n" +
    "id: plan\n" +
    "constraints:\n" +
    "  - Plan only. Do not modify source code.\n" +
    "stages:\n" +
    "  - id: plan\n" +
    "    role: planner\n" +
    "    depends_on: []\n" +
    "    max_revisions: 3\n" +
    "    instructions:\n" +
    "      - Analyze the task and write an implementation plan.\n" +
    "      - \"Structure plan.md with these sections: Goal, Steps, Files, Risks, Verification.\"\n" +
    "      - When revising, edit the existing plan.md in place. Do not replace the whole file.\n" +
    "    produces:\n" +
    "      artifact: plan.md\n" +
    "  - id: review-plan\n" +
    "    role: reviewer\n" +
    "    depends_on:\n" +
    "      - plan\n" +
    "    instructions:\n" +
    "      - Review the plan for correctness, missing risks, and unnecessary scope.\n" +
    "      - Report every gap of the same kind in one response.\n" +
    "      - Check that plan.md has the sections Goal, Steps, Files, Risks, Verification.\n" +
    "      - Choose revise only for a factual error, a missing risk, a missing section, or unnecessary scope. Do not revise for style.\n" +
    "      - When choosing revise, list each required change so the planner can act on it.\n" +
    "    decision:\n" +
    "      values:\n" +
    "        - approved\n" +
    "        - revise\n" +
    "      routes:\n" +
    "        approved: complete\n" +
    "        revise: plan\n" +
    "outputs:\n" +
    "  - name: plan\n" +
    "    from_stage: plan\n" +
    "    artifact: plan.md\n"
  );
}

async function promptOptions(
  provider: Provider,
  model: string,
  catalog: ModelCatalog,
  which: Which,
  runCommand: RunCommand,
  prompt: Prompter,
): Promise<Record<string, string>> {
  const stored: Record<string, string> = {};
  for (const spec of providerOptions(provider)) {
    if (!spec.prompt) continue;
    const values = await loadOptionValues(provider, spec.name, model, catalog, which, runCommand);
    if (values === null || values.length === 0) continue;
    const picked = await prompt.selectOption(spec.name, values, spec.allowDefault ?? false);
    if (picked) stored[spec.name] = picked;
  }
  return stored;
}

function providerOptions(provider: Provider): readonly ProviderOption[] {
  return asCatalog(provider).providerOptions();
}

class ClackPrompter implements Prompter {
  async selectProvider(
    rows: ReadonlyArray<readonly [string, string | null, Provider]>,
    message: string,
  ): Promise<string> {
    if (rows.length === 0) throw new ConfigurationError("No providers are available.");
    const names = new Set(rows.map(([name]) => name));
    const result = await clackSelect({
      message,
      options: rows.map(([name, found]) => ({ value: name, label: `${name}  ${found ?? "not found"}` })),
      initialValue: rows[0]?.[0],
    });
    if (isCancel(result)) throw new PromptCancelled();
    if (typeof result !== "string" || !names.has(result)) throw new ConfigurationError("Provider is required.");
    return result;
  }

  async selectModel(_provider: string, catalog: ModelCatalog, message: string): Promise<string> {
    if (catalog.ids.length === 0) throw new ConfigurationError("Model is required.");
    const initial = catalog.defaultId && catalog.ids.includes(catalog.defaultId) ? catalog.defaultId : catalog.ids[0];
    const result = await clackSelect({
      message,
      options: catalog.ids.map((id) => ({ value: id, label: id })),
      initialValue: initial,
    });
    if (isCancel(result)) throw new PromptCancelled();
    if (!catalog.ids.includes(String(result))) throw new ConfigurationError(`Unknown model: ${String(result)}.`);
    return String(result);
  }

  async selectOption(name: string, values: readonly string[], allowDefault: boolean): Promise<string> {
    if (values.length === 0) return "";
    const options = [
      ...(allowDefault ? [{ value: "", label: "provider default" }] : []),
      ...values.map((value) => ({ value, label: value })),
    ];
    const result = await clackSelect({
      message: name,
      options,
      initialValue: allowDefault ? "" : values[0],
    });
    const allowed = new Set(allowDefault ? ["", ...values] : values);
    if (isCancel(result)) throw new PromptCancelled();
    if (!allowed.has(String(result ?? ""))) {
      throw new ConfigurationError(`Unknown ${name} value: ${String(result)}.`);
    }
    return result == null ? "" : String(result);
  }

  async confirm(message: string): Promise<boolean> {
    const result = await clackConfirm({ message, initialValue: true });
    if (isCancel(result)) throw new PromptCancelled();
    if (typeof result !== "boolean") throw new ConfigurationError("Answer yes or no.");
    return result;
  }
}
