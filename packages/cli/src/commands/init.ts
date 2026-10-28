import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isCancel, select as clackSelect } from "@clack/prompts";
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
  printInitNextSteps,
} from "../display.js";
import { cliHooks } from "../hooks.js";
import { runDoctor } from "./doctor.js";
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

const INIT_EXAMPLE = "Example: migent init --provider codex --model gpt-5 --reviewer-provider grok --reviewer-model grok-4.7 --no-input";

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
}

export async function runInit(
  workspace: string,
  options: {
    provider?: string | null;
    model?: string | null;
    options?: readonly string[];
    reviewerProvider?: string | null;
    reviewerModel?: string | null;
    reviewerOptions?: readonly string[];
    interactive?: boolean;
    providers?: Record<string, Provider> | null;
    which?: Which | null;
    prompter?: Prompter | null;
    runCommand?: RunCommand | null;
  } = {},
): Promise<number> {
  const provider = options.provider ?? null;
  const model = options.model ?? null;
  const reviewerProvider = options.reviewerProvider ?? null;
  const reviewerModel = options.reviewerModel ?? null;
  const interactive = options.interactive ?? false;
  const chosen = options.providers ?? providerMap();
  const resolve = options.which ?? cliHooks.which ?? whichSync;
  const prompt = options.prompter ?? new ClackPrompter();
  const execute = options.runCommand ?? cliHooks.runCommand ?? runProviderCommand;
  const optionPairs = options.options ?? [];
  const reviewerOptionPairs = options.reviewerOptions ?? [];
  const classified = classify(workspace, chosen, resolve);
  if (classified.state === "ready") {
    if (provider !== null || model !== null || optionPairs.length > 0 ||
        reviewerProvider !== null || reviewerModel !== null || reviewerOptionPairs.length > 0) {
      printError("Already initialized; ignoring model selection flags.");
    }
    printAlreadyInitialized();
    printInitNextSteps();
    return 0;
  }
  for (const [role, selectedProvider, selectedModel, pairs, prefix] of [
    ["developer", provider, model, optionPairs, ""],
    ["reviewer", reviewerProvider, reviewerModel, reviewerOptionPairs, "reviewer-"],
  ] as const) {
    const flags = `--${prefix}provider and --${prefix}model`;
    if ((selectedProvider === null) !== (selectedModel === null)) {
      printError(`Pass both ${flags} for ${role}, or omit both.\n${INIT_EXAMPLE}`);
      return 2;
    }
    if (pairs.length > 0 && selectedProvider === null) {
      printError(`Pass ${flags} with --${prefix}option.`);
      return 2;
    }
    if (selectedProvider === null && !interactive) {
      printError(`Pass ${flags} for ${role} when init is not interactive.\n${INIT_EXAMPLE}`);
      return 2;
    }
  }
  if (classified.state === "conflict") {
    printInitConflicts(classified.conflicts);
    return 1;
  }
  let developer: ModelChoice;
  let reviewer: ModelChoice;
  try {
    developer = await choices(chosen, resolve, prompt, {
      role: "Developer",
      provider,
      model,
      options: parseOptions(optionPairs),
      runCommand: execute,
    });
    reviewer = await choices(chosen, resolve, prompt, {
      role: "Reviewer",
      provider: reviewerProvider,
      model: reviewerModel,
      options: parseOptions(reviewerOptionPairs),
      runCommand: execute,
    });
  } catch (error) {
    if (error instanceof PromptCancelled) throw error;
    printError(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const paths = writeProject(workspace, developer, reviewer);
  printCreated(
    paths,
    `Developer: ${developer.provider}/${developer.model}. Reviewer: ${reviewer.provider}/${reviewer.model}. Planner uses the developer model. Workflows: implement, plan.`,
  );
  if (interactive) {
    const doctorCode = await runDoctor(workspace, { which: resolve, runCommand: execute });
    if (doctorCode !== 0) writeDoctorProblems(workspace, chosen, resolve);
  } else {
    writeDoctorProblems(workspace, chosen, resolve);
  }
  printInitNextSteps();
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
    role: string;
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
    provider = await prompt.selectProvider(rows, `${args.role} provider`);
    const impl = providers[provider];
    if (impl === undefined) throw new ConfigurationError(`Unknown provider: ${provider}.`);
    const catalog = await loadCatalog(impl, which, args.runCommand);
    model = await prompt.selectModel(provider, catalog, `${args.role} model`);
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
  developer: ModelChoice,
  reviewer: ModelChoice,
): string[] {
  const root = path.join(workspace, ".migent");
  const workflows = path.join(root, "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(root, "config.yaml"), renderConfig(developer, reviewer), "utf8");
  for (const preset of PRESETS) {
    writeFileSync(path.join(workflows, `${preset}.yaml`), renderWorkflow(preset), "utf8");
  }
  writeFileSync(path.join(root, ".gitignore"), "sessions/\nconfig.local.yaml\n", "utf8");
  return [
    ".migent/config.yaml",
    ...PRESETS.map((preset) => `.migent/workflows/${preset}.yaml`),
    ".migent/.gitignore",
  ];
}

function renderConfig(developer: ModelChoice, reviewer: ModelChoice): string {
  const lines = ["schema_version: 2", "roles:"];
  const instructions = {
    developer: [
      "Read the relevant code and project instructions before making changes.",
      "Implement only the requested scope and follow the project conventions.",
      "Run relevant checks or tests and fix failures caused by your changes.",
      "Report what changed, the verification results, and anything not verified.",
    ],
    planner: [
      "Read the task, relevant code, and project instructions before planning.",
      "Write only planning artifacts; do not modify project files or implement code.",
      "Describe the scope, ordered changes, affected files, risks, and verification.",
      "Support claims about current behavior with file paths and line numbers; identify assumptions.",
    ],
    reviewer: [
      "Read the task and inspect the relevant code, diff, or planning artifact.",
      "Check correctness, missing requirements, unnecessary scope, and verification evidence.",
      "Do not modify project files or implement fixes while reviewing.",
      "Report all actionable findings in one response with file locations, impact, and required changes.",
      "Approve only when the work meets the task and relevant checks are supported by evidence.",
    ],
  };
  for (const [role, choice] of [["developer", developer], ["planner", developer], ["reviewer", reviewer]] as const) {
    lines.push(
      `  ${role}:`,
      "    default_model:",
      `      provider: ${yamlScalar(choice.provider)}`,
      `      model: ${yamlScalar(choice.model)}`,
    );
    if (Object.keys(choice.options).length > 0) {
      lines.push("      options:");
      for (const [key, value] of Object.entries(choice.options)) lines.push(`        ${key}: ${yamlScalar(value)}`);
    }
    lines.push("    instructions:");
    for (const instruction of instructions[role]) lines.push(`      - ${yamlScalar(instruction)}`);
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
      "    max_revisions: 3\n" +
      "    instructions:\n" +
      "      - Implement the requested change.\n" +
      "      - Verify the result with relevant checks or tests.\n" +
      "      - When revising, address all review findings and rerun the relevant checks.\n" +
      "  - id: review_work\n" +
      "    role: reviewer\n" +
      "    depends_on:\n" +
      "      - implement\n" +
      "    instructions:\n" +
      "      - Review the diff against the task and inspect the relevant code.\n" +
      "      - Check correctness, regressions, missing requirements, and the reported verification results.\n" +
      "      - Choose approved only when the requested change is complete and supported by verification evidence.\n" +
      "      - Otherwise choose revise and list all required fixes with file locations and their impact.\n" +
      "    decision:\n" +
      "      values:\n" +
      "        - approved\n" +
      "        - revise\n" +
      "      routes:\n" +
      "        approved: complete\n" +
      "        revise: implement\n"
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
    "  - id: review_plan\n" +
    "    role: reviewer\n" +
    "    depends_on:\n" +
    "      - plan\n" +
    "    instructions:\n" +
    "      - Review the plan for correctness, missing risks, and unnecessary scope.\n" +
    "      - Report every gap of the same kind in one response.\n" +
    "      - Check that plan.md has the sections Goal, Steps, Files, Risks, Verification.\n" +
    "      - Choose revise only for a factual error, a missing risk, a missing section, or unnecessary scope. Do not revise for style.\n" +
    "      - When choosing revise, list each required change so the developer can act on it.\n" +
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
}
