import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { autocomplete, isCancel, select as clackSelect, spinner } from "@clack/prompts";
import type { ModelCatalog } from "@nodeint/migent-adapters";
import { diagnose } from "@nodeint/migent-doctor";
import {
  ConfigurationError,
  whichSync,
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
import { renderProject, type ModelChoice, type RenderedFile } from "../project-template.js";
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
  runProviderCommandAsync,
  type RunCommand,
  type Which,
} from "../provider.js";

const INIT_EXAMPLE = "Example: migent init --planner-provider codex --planner-model gpt-5 --reviewer-provider grok --reviewer-model grok-4.7 --developer-provider codex --developer-model gpt-5 --no-input";


export interface ModelSelection { provider: string; model: string }

export interface Prompter {
  selectModel(models: readonly ModelSelection[], message: string): ModelSelection | Promise<ModelSelection>;
  selectOption(name: string, values: readonly string[], allowDefault: boolean): string | Promise<string>;
}

export async function runInit(
  workspace: string,
  options: {
    provider?: string | null;
    model?: string | null;
    effort?: string | null;
    options?: readonly string[];
    plannerProvider?: string | null;
    plannerModel?: string | null;
    plannerEffort?: string | null;
    plannerOptions?: readonly string[];
    reviewerProvider?: string | null;
    reviewerModel?: string | null;
    reviewerEffort?: string | null;
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
  const plannerProvider = options.plannerProvider ?? null;
  const plannerModel = options.plannerModel ?? null;
  const reviewerProvider = options.reviewerProvider ?? null;
  const reviewerModel = options.reviewerModel ?? null;
  const interactive = options.interactive ?? false;
  const chosen = options.providers ?? providerMap();
  const resolve = options.which ?? cliHooks.which ?? whichSync;
  const prompt = options.prompter ?? new ClackPrompter();
  const runCommand = options.runCommand ?? cliHooks.runCommand ?? runProviderCommandAsync;
  const commands = new Map<string, Promise<string>>();
  const execute: RunCommand = (argv, input) => {
    const key = JSON.stringify([argv, input]);
    let pending = commands.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => runCommand(argv, input));
      commands.set(key, pending);
    }
    return pending;
  };
  const optionPairs = options.options ?? [];
  const plannerOptionPairs = options.plannerOptions ?? [];
  const reviewerOptionPairs = options.reviewerOptions ?? [];
  const classified = classify(workspace, chosen, resolve);
  if (classified.state === "ready") {
    if (provider !== null || model !== null || options.effort != null || optionPairs.length > 0 ||
        plannerProvider !== null || plannerModel !== null || options.plannerEffort != null || plannerOptionPairs.length > 0 ||
        reviewerProvider !== null || reviewerModel !== null || options.reviewerEffort != null || reviewerOptionPairs.length > 0) {
      printError("Already initialized; ignoring model selection flags.");
    }
    printAlreadyInitialized();
    printInitNextSteps();
    return 0;
  }
  for (const [role, selectedProvider, selectedModel, pairs, effort, prefix] of [
    ["planner", plannerProvider, plannerModel, plannerOptionPairs, options.plannerEffort, "planner-"],
    ["reviewer", reviewerProvider, reviewerModel, reviewerOptionPairs, options.reviewerEffort, "reviewer-"],
    ["developer", provider, model, optionPairs, options.effort, "developer-"],
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
    if (effort != null && selectedProvider === null) {
      printError(`Pass ${flags} with --${prefix}effort.`);
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
  const catalogs = new Map<string, Promise<ModelCatalog>>();
  const getCatalog = (name: string): Promise<ModelCatalog> => {
    let catalog = catalogs.get(name);
    if (!catalog) {
      catalog = loadCatalog(requireProvider(chosen, name), resolve, execute);
      catalogs.set(name, catalog);
    }
    return catalog;
  };
  let models: ModelSelection[] = [];
  if ([plannerProvider, reviewerProvider, provider].some((value) => value === null)) {
    const loading = options.prompter ? null : spinner();
    loading?.start("Loading models from installed providers...");
    const rows = detected(chosen, resolve).filter(([, found]) => found !== null);
    const results = await Promise.allSettled(rows.map(async ([name]) => ({ name, catalog: await getCatalog(name) })));
    loading?.stop("Model catalogs loaded.");
    const failures: string[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        const { name, catalog } = result.value;
        models.push(...catalog.ids.map((id) => ({ provider: name, model: id })));
      } else {
        failures.push(`${rows[index]?.[0]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }
    for (const failure of failures) process.stderr.write(`Could not load models for ${failure}\n`);
    if (models.length === 0) {
      printError("No models available from installed providers.");
      return 2;
    }
  }
  let developer: ModelChoice;
  let planner: ModelChoice;
  let reviewer: ModelChoice;
  try {
    planner = await choices(chosen, resolve, prompt, {
      role: "Planner",
      provider: plannerProvider,
      model: plannerModel,
      options: parseOptions(plannerOptionPairs),
      effort: options.plannerEffort ?? null,
      runCommand: execute,
      models, getCatalog,
    });
    reviewer = await choices(chosen, resolve, prompt, {
      role: "Reviewer",
      provider: reviewerProvider,
      model: reviewerModel,
      options: parseOptions(reviewerOptionPairs),
      effort: options.reviewerEffort ?? null,
      runCommand: execute,
      models, getCatalog,
    });
    developer = await choices(chosen, resolve, prompt, {
      role: "Developer",
      provider,
      model,
      options: parseOptions(optionPairs),
      effort: options.effort ?? null,
      runCommand: execute,
      models, getCatalog,
    });
  } catch (error) {
    if (error instanceof PromptCancelled) throw error;
    printError(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let files: RenderedFile[];
  try {
    files = renderProject({ planner, reviewer, developer });
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const paths = writeProject(workspace, files);
  printCreated(
    paths,
    `Planner: ${planner.provider}/${planner.model}. Reviewer: ${reviewer.provider}/${reviewer.model}. Developer: ${developer.provider}/${developer.model}. Workflows: implement, plan.`,
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
    effort: string | null;
    runCommand: RunCommand;
    models: readonly ModelSelection[];
    getCatalog: (name: string) => Promise<ModelCatalog>;
  },
): Promise<ModelChoice> {
  let provider = args.provider;
  let model = args.model;
  let effort = args.effort;
  let stored: Record<string, string>;
  if (provider === null) {
    const selected = await prompt.selectModel(args.models, `${args.role} model`);
    if (!args.models.some((item) => item.provider === selected.provider && item.model === selected.model)) {
      throw new ConfigurationError("Unknown provider or model.");
    }
    provider = selected.provider;
    model = selected.model;
    const impl = requireProvider(providers, provider);
    const catalog = await args.getCatalog(provider);
    stored = await promptOptions(impl, model, catalog, which, args.runCommand, prompt);
    // The prompt stores effort as a native option; keep it in the dedicated `effort` field instead.
    const promptedOption = impl.effortOption;
    if (promptedOption && Object.hasOwn(stored, promptedOption) && !(promptedOption === "variant" && model.includes("#"))) {
      effort = stored[promptedOption] ?? null;
      delete stored[promptedOption];
    }
  } else {
    const impl = requireProvider(providers, provider);
    if (model === null) throw new ConfigurationError("Model is required.");
    const catalog = await args.getCatalog(provider);
    model = knownModel(model, catalog);
    const effortOption = impl.effortOption;
    if (args.effort !== null && !effortOption) throw new ConfigurationError(`${args.role} provider does not support effort.`);
    if (args.effort !== null && effortOption && Object.hasOwn(args.options, effortOption)) {
      throw new ConfigurationError(`${args.role} effort conflicts with option ${effortOption}; use only one.`);
    }
    if (args.effort !== null && model.includes("#") && effortOption === "variant") {
      throw new ConfigurationError(`${args.role} model already selects a #variant; omit effort.`);
    }
    const requested = args.effort !== null && effortOption
      ? { ...args.options, [effortOption]: args.effort }
      : args.options;
    stored = await acceptedOptions(impl, model, catalog, which, args.runCommand, requested);
    if (args.effort !== null && effortOption) delete stored[effortOption];
  }
  if (model.trim() === "") throw new ConfigurationError("Model is required.");
  const primary = { provider, model: model.trim(), options: stored, ...(effort !== null ? { effort } : {}) };
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

function writeProject(workspace: string, files: readonly RenderedFile[]): string[] {
  for (const file of files) {
    const target = path.join(workspace, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
  return files.map((file) => file.path);
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
  async selectModel(models: readonly ModelSelection[], message: string): Promise<ModelSelection> {
    const result = await autocomplete({
      message,
      placeholder: "Search provider or model...",
      options: models.map((item, index) => ({ value: String(index), label: `${item.provider} / ${item.model}` })),
      filter: (search, option) => (option.label ?? "").toLowerCase().includes(search.toLowerCase()),
    });
    if (isCancel(result)) throw new PromptCancelled();
    const selected = models[Number(result)];
    if (!selected) throw new ConfigurationError("Model is required.");
    return selected;
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
