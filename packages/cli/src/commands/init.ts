import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { confirm as clackConfirm, isCancel, select as clackSelect } from "@clack/prompts";
import type { ModelCatalog } from "@nodeint/migent-adapters";
import { diagnose, whichSync, yamlScalar, type AgentAdapter, type ProviderOption } from "@nodeint/migent-kernel";
import {
  printAlreadyInitialized,
  printCreated,
  printError,
  printInitConflicts,
} from "../display.js";
import { cliHooks } from "../hooks.js";
import { runDoctor } from "./doctor.js";
import { installSkill } from "./skill.js";
import {
  acceptedOptions,
  adapterMap,
  asCatalog,
  detected,
  knownModel,
  loadCatalog,
  loadOptionValues,
  parseOptions,
  requireAdapter,
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
    rows: ReadonlyArray<readonly [string, string | null, AgentAdapter]>,
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
    skill?: boolean;
    interactive?: boolean;
    adapters?: Record<string, AgentAdapter> | null;
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
  const chosen = options.adapters ?? adapterMap();
  const resolve = options.which ?? cliHooks.which ?? whichSync;
  const prompt = options.prompter ?? new ClackPrompter();
  const execute = options.runCommand ?? runProviderCommand;
  if (!PRESETS.includes(preset as (typeof PRESETS)[number])) {
    printError("preset must be implement or plan.");
    return 2;
  }
  if ((provider === null) !== (model === null)) {
    printError("Pass both --provider and --model, or omit both.");
    return 2;
  }
  const optionPairs = options.options ?? [];
  if (optionPairs.length > 0 && provider === null) {
    printError("Pass --provider and --model with --option.");
    return 2;
  }
  if (provider === null && !interactive) {
    printError("Pass --provider and --model when init is not interactive.");
    return 2;
  }
  const classified = classify(workspace, chosen, resolve);
  if (classified.state === "ready") {
    printAlreadyInitialized();
    if (skill) return installSkill(workspace);
    return 0;
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
    printError(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let install = skill;
  if (!install && interactive) {
    try {
      install = await prompt.confirm("Install the Migent skill in .agents/skills/migent?");
    } catch (error) {
      printError(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (install && installSkill(workspace) !== 0) return 1;
  const paths = writeProject(workspace, preset, primary);
  printCreated(paths, `migent start ${preset} --task "..."`);
  return runDoctor(workspace, { which: resolve });
}

async function choices(
  adapters: Record<string, AgentAdapter>,
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
    const rows = detected(adapters, which);
    provider = await prompt.selectProvider(rows, "Default provider");
    const adapter = adapters[provider];
    if (adapter === undefined) throw new Error(`Unknown provider: ${provider}.`);
    const catalog = await loadCatalog(adapter, which, args.runCommand);
    model = await prompt.selectModel(provider, catalog, "Model");
    stored = await promptOptions(adapter, model, catalog, which, args.runCommand, prompt);
  } else {
    const adapter = requireAdapter(adapters, provider);
    if (model === null) throw new Error("Model is required.");
    const catalog = await loadCatalog(adapter, which, args.runCommand);
    model = knownModel(model, catalog);
    stored = await acceptedOptions(adapter, model, catalog, which, args.runCommand, args.options);
  }
  if (model.trim() === "") throw new Error("Model is required.");
  const primary = { provider, model: model.trim(), options: stored };
  return primary;
}

function classify(
  workspace: string,
  adapters: Record<string, AgentAdapter>,
  which: Which,
): { state: "create" | "ready" | "conflict"; conflicts: string[] } {
  const root = path.join(workspace, ".migent");
  const config = path.join(root, "config.yaml");
  const workflows = path.join(root, "workflows");
  const gitignore = path.join(root, ".gitignore");
  const owned: string[] = [];
  if (exists(config)) owned.push(".migent/config.yaml");
  if (exists(workflows)) {
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
    const checks = diagnose(workspace, { adapters, which });
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
  writeFileSync(path.join(root, "config.yaml"), renderConfig(preset, primary), "utf8");
  const workflowName = `${preset}.yaml`;
  writeFileSync(path.join(workflows, workflowName), renderWorkflow(preset), "utf8");
  writeFileSync(path.join(root, ".gitignore"), "sessions/\n", "utf8");
  return [".migent/config.yaml", `.migent/workflows/${workflowName}`, ".migent/.gitignore"];
}

function renderConfig(preset: string, primary: ModelChoice): string {
  const models: Array<[string, ModelChoice]> = [["default", primary]];
  let roles: Array<[string, string]>;
  if (preset === "implement") roles = [["developer", "default"]];
  else roles = [["planner", "default"], ["reviewer", "default"]];
  const lines = ["schema_version: 1", "models:"];
  for (const [name, choice] of models) {
    lines.push(`  ${name}:`, `    provider: ${yamlScalar(choice.provider)}`, `    model: ${yamlScalar(choice.model)}`);
    const entries = Object.entries(choice.options);
    if (entries.length > 0) {
      lines.push("    options:");
      for (const [optionName, value] of entries) lines.push(`      ${optionName}: ${yamlScalar(value)}`);
    }
  }
  lines.push("roles:");
  for (const [role, modelName] of roles) lines.push(`  ${role}:`, `    default_model: ${modelName}`);
  return `${lines.join("\n")}\n`;
}

function renderWorkflow(preset: string): string {
  if (preset === "implement") {
    return (
      "schema_version: 1\n" +
      "id: implement\n" +
      "stages:\n" +
      "  - id: implement\n" +
      "    role: developer\n" +
      "    depends_on: []\n" +
      "    instructions:\n" +
      "      - Implement the requested change.\n" +
      "      - Verify the result with relevant checks or tests.\n" +
      "completion:\n" +
      "  stage: implement\n"
    );
  }
  return (
    "schema_version: 1\n" +
    "id: plan\n" +
    "stages:\n" +
    "  - id: plan\n" +
    "    role: planner\n" +
    "    depends_on: []\n" +
    "    max_revisions: 3\n" +
    "    instructions:\n" +
    "      - Analyze the task and write an implementation plan.\n" +
    "    produces:\n" +
    "      artifact: plan.md\n" +
    "  - id: review-plan\n" +
    "    role: reviewer\n" +
    "    depends_on:\n" +
    "      - plan\n" +
    "    instructions:\n" +
    "      - Review the plan for correctness, missing risks, and unnecessary scope.\n" +
    "    decision:\n" +
    "      values:\n" +
    "        - approved\n" +
    "        - revise\n" +
    "      routes:\n" +
    "        approved: complete\n" +
    "        revise: plan\n" +
    "completion:\n" +
    "  stage: review-plan\n" +
    "  decision: approved\n" +
    "  outputs:\n" +
    "    - name: plan\n" +
    "      from_stage: plan\n" +
    "      artifact: plan.md\n"
  );
}

async function promptOptions(
  adapter: AgentAdapter,
  model: string,
  catalog: ModelCatalog,
  which: Which,
  runCommand: RunCommand,
  prompt: Prompter,
): Promise<Record<string, string>> {
  const stored: Record<string, string> = {};
  for (const spec of providerOptions(adapter)) {
    if (!spec.prompt) continue;
    const values = await loadOptionValues(adapter, spec.name, model, catalog, which, runCommand);
    if (values === null || values.length === 0) continue;
    const picked = await prompt.selectOption(spec.name, values, spec.allowDefault ?? false);
    if (picked) stored[spec.name] = picked;
  }
  return stored;
}

function providerOptions(adapter: AgentAdapter): readonly ProviderOption[] {
  return asCatalog(adapter).providerOptions();
}

class ClackPrompter implements Prompter {
  async selectProvider(
    rows: ReadonlyArray<readonly [string, string | null, AgentAdapter]>,
    message: string,
  ): Promise<string> {
    if (rows.length === 0) throw new Error("No providers are available.");
    const names = new Set(rows.map(([name]) => name));
    const result = await clackSelect({
      message,
      options: rows.map(([name, found]) => ({ value: name, label: `${name}  ${found ?? "not found"}` })),
      initialValue: rows[0]?.[0],
    });
    if (isCancel(result) || typeof result !== "string" || !names.has(result)) throw new Error("Provider is required.");
    return result;
  }

  async selectModel(_provider: string, catalog: ModelCatalog, message: string): Promise<string> {
    if (catalog.ids.length === 0) throw new Error("Model is required.");
    const initial = catalog.defaultId && catalog.ids.includes(catalog.defaultId) ? catalog.defaultId : catalog.ids[0];
    const result = await clackSelect({
      message,
      options: catalog.ids.map((id) => ({ value: id, label: id })),
      initialValue: initial,
    });
    if (isCancel(result) || !catalog.ids.includes(String(result))) throw new Error(`Unknown model: ${String(result)}.`);
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
    if (isCancel(result) || !allowed.has(String(result ?? ""))) {
      throw new Error(`Unknown ${name} value: ${String(result)}.`);
    }
    return result == null ? "" : String(result);
  }

  async confirm(message: string): Promise<boolean> {
    const result = await clackConfirm({ message, initialValue: true });
    if (isCancel(result) || typeof result !== "boolean") throw new Error("Answer yes or no.");
    return result;
  }
}

function exists(filePath: string): boolean {
  try {
    statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}
