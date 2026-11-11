import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { autocomplete, isCancel, select as clackSelect, spinner } from '@clack/prompts';
import type { ModelCatalog } from '@nodeint/migent-adapters';
import { diagnose } from '@nodeint/migent-doctor';
import {
  ConfigurationError,
  loadRoleDescription,
  loadWorkspaceConfig,
  whichSync,
} from '@nodeint/migent-kernel';

import {
  acceptedOptions,
  asCatalog,
  catalogSourceOf,
  clientRegistry,
  detected,
  knownModel,
  loadCatalog,
  loadOptionValues,
  parseOptions,
  runClientCommandAsync,
  type RunCommand,
  type Which,
} from '../client.js';
import {
  printAlreadyInitialized,
  printCreated,
  printError,
  printInitConflicts,
  printInitNextSteps,
} from '../display.js';
import { PromptCancelled } from '../errors.js';
import { exists, isDirectory, isFile } from '../fs-utils.js';
import { cliHooks } from '../hooks.js';
import { type ModelChoice, type RenderedFile,renderProject } from '../project-template.js';
import { runDoctor } from './doctor.js';

const INIT_EXAMPLE = 'Example: migent init --planner-client codex --planner-model gpt-5 --reviewer-client grok --reviewer-model grok-4.7 --client codex --developer-model gpt-5 --no-input';


export interface ModelSelection { client: string; model: string }

export interface Prompter {
  selectModel(models: readonly ModelSelection[], message: string): ModelSelection | Promise<ModelSelection>;
  selectOption(name: string, values: readonly string[], allowDefault: boolean): string | Promise<string>;
}

export async function runInit(
  workspace: string,
  options: {
    client?: string | null;
    model?: string | null;
    effort?: string | null;
    options?: readonly string[];
    plannerClient?: string | null;
    plannerModel?: string | null;
    plannerEffort?: string | null;
    plannerOptions?: readonly string[];
    reviewerClient?: string | null;
    reviewerModel?: string | null;
    reviewerEffort?: string | null;
    reviewerOptions?: readonly string[];
    interactive?: boolean;
    clients?: import('@nodeint/migent-kernel').ClientRegistry | null;
    which?: Which | null;
    prompter?: Prompter | null;
    runCommand?: RunCommand | null;
  } = {},
): Promise<number> {
  const client = options.client ?? null;
  const model = options.model ?? null;
  const plannerClient = options.plannerClient ?? null;
  const plannerModel = options.plannerModel ?? null;
  const reviewerClient = options.reviewerClient ?? null;
  const reviewerModel = options.reviewerModel ?? null;
  const interactive = options.interactive ?? false;
  const chosen = options.clients ?? clientRegistry();
  const resolve = options.which ?? cliHooks.which ?? whichSync;
  const prompt = options.prompter ?? new ClackPrompter();
  const runCommand = options.runCommand ?? cliHooks.runCommand ?? runClientCommandAsync;
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
  if (classified.state === 'ready') {
    if (client !== null || model !== null || (options.effort !== null && options.effort !== undefined) || optionPairs.length > 0 ||
        plannerClient !== null || plannerModel !== null || (options.plannerEffort !== null && options.plannerEffort !== undefined) || plannerOptionPairs.length > 0 ||
        reviewerClient !== null || reviewerModel !== null || (options.reviewerEffort !== null && options.reviewerEffort !== undefined) || reviewerOptionPairs.length > 0) {
      printError('Already initialized; ignoring model selection flags.');
    }
    printAlreadyInitialized();
    printInitNextSteps();
    return 0;
  }
  for (const [role, selectedClient, selectedModel, pairs, effort, prefix] of [
    ['planner', plannerClient, plannerModel, plannerOptionPairs, options.plannerEffort, 'planner-'],
    ['reviewer', reviewerClient, reviewerModel, reviewerOptionPairs, options.reviewerEffort, 'reviewer-'],
    ['developer', client, model, optionPairs, options.effort, 'developer-'],
  ] as const) {
    const clientFlag = role === 'developer' ? '--client' : `--${prefix}client`;
    const flags = `${clientFlag} and --${prefix}model`;
    if ((selectedClient === null) !== (selectedModel === null)) {
      printError(`Pass both ${flags} for ${role}, or omit both.\n${INIT_EXAMPLE}`);
      return 2;
    }
    if (pairs.length > 0 && selectedClient === null) {
      printError(`Pass ${flags} with --${prefix}option.`);
      return 2;
    }
    if ((effort !== null && effort !== undefined) && selectedClient === null) {
      printError(`Pass ${flags} with --${prefix}effort.`);
      return 2;
    }
    if (selectedClient === null && !interactive) {
      printError(`Pass ${flags} for ${role} when init is not interactive.\n${INIT_EXAMPLE}`);
      return 2;
    }
  }
  if (classified.state === 'conflict') {
    printInitConflicts(classified.conflicts);
    return 1;
  }
  const catalogs = new Map<string, Promise<ModelCatalog>>();
  const getCatalog = (name: string): Promise<ModelCatalog> => {
    let catalog = catalogs.get(name);
    if (!catalog) {
      catalog = loadCatalog(catalogSourceOf(chosen.get(name)), resolve, execute);
      catalogs.set(name, catalog);
    }
    return catalog;
  };
  const models: ModelSelection[] = [];
  if ([plannerClient, reviewerClient, client].some((value) => value === null)) {
    const loading = options.prompter ? null : spinner();
    loading?.start('Loading models from installed clients...');
    const rows = detected(resolve).filter(([, found]) => found !== null);
    const results = await Promise.allSettled(rows.map(async ([name]) => ({ name, catalog: await getCatalog(name) })));
    loading?.stop('Model catalogs loaded.');
    const failures: string[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        const { name, catalog } = result.value;
        models.push(...catalog.ids.map((id) => ({ client: name, model: id })));
      } else {
        failures.push(`${rows[index]?.[0]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }
    for (const failure of failures) process.stderr.write(`Could not load models for ${failure}\n`);
    if (models.length === 0) {
      printError('No models available from installed clients.');
      return 2;
    }
  }
  let developer: ModelChoice;
  let planner: ModelChoice;
  let reviewer: ModelChoice;
  try {
    planner = await choices(chosen, resolve, prompt, {
      role: 'Planner',
      client: plannerClient,
      model: plannerModel,
      options: parseOptions(plannerOptionPairs),
      effort: options.plannerEffort ?? null,
      runCommand: execute,
      models, getCatalog,
    });
    reviewer = await choices(chosen, resolve, prompt, {
      role: 'Reviewer',
      client: reviewerClient,
      model: reviewerModel,
      options: parseOptions(reviewerOptionPairs),
      effort: options.reviewerEffort ?? null,
      runCommand: execute,
      models, getCatalog,
    });
    developer = await choices(chosen, resolve, prompt, {
      role: 'Developer',
      client,
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
    `Planner: ${planner.client}/${planner.model}. Reviewer: ${reviewer.client}/${reviewer.model}. Developer: ${developer.client}/${developer.model}. Workflows: implement, plan.`,
  );
  printRoleDescriptions(workspace);
  if (interactive) {
    const doctorCode = await runDoctor(workspace, { which: resolve, runCommand: execute });
    if (doctorCode !== 0) writeDoctorProblems(workspace, chosen, resolve);
  } else {
    writeDoctorProblems(workspace, chosen, resolve);
  }
  printInitNextSteps();
  return 0;
}

/** Lists each created role with the one-line description the template gives it. */
function printRoleDescriptions(workspace: string): void {
  const config = loadWorkspaceConfig(workspace);
  const lines: string[] = [];
  for (const role of Object.keys(config.roles as Record<string, unknown>)) {
    const description = loadRoleDescription(config, role);
    if (description !== null) lines.push(`  ${role.padEnd(10)} ${description}`);
  }
  if (lines.length > 0) process.stdout.write(`Roles:\n${lines.join('\n')}\n`);
}

function writeDoctorProblems(
  workspace: string,
  clients: import('@nodeint/migent-kernel').ClientRegistry,
  which: Which,
): void {
  const problems = diagnose(workspace, { clients, which }).flatMap((check) => check.problems);
  if (problems.length === 0) return;
  process.stderr.write('Doctor reported problems:\n');
  for (const problem of problems) process.stderr.write(`${problem}\n`);
}

async function choices(
  clients: import('@nodeint/migent-kernel').ClientRegistry,
  which: Which,
  prompt: Prompter,
  args: {
    role: string;
    client: string | null;
    model: string | null;
    options: Record<string, string>;
    effort: string | null;
    runCommand: RunCommand;
    models: readonly ModelSelection[];
    getCatalog: (name: string) => Promise<ModelCatalog>;
  },
): Promise<ModelChoice> {
  let {client} = args;
  let {model} = args;
  let {effort} = args;
  let stored: Record<string, string>;
  if (client === null) {
    const selected = await prompt.selectModel(args.models, `${args.role} model`);
    if (!args.models.some((item) => item.client === selected.client && item.model === selected.model)) {
      throw new ConfigurationError('Unknown client or model.');
    }
    client = selected.client;
    model = selected.model;
    const impl = clients.get(client);
    const catalog = await args.getCatalog(client);
    stored = await promptOptions(impl, model, catalog, which, args.runCommand, prompt);
    // The prompt stores effort as a native option; keep it in the dedicated `effort` field instead.
    const promptedOption = impl.effortOption;
    if (promptedOption && Object.hasOwn(stored, promptedOption) && !(promptedOption === 'variant' && model.includes('#'))) {
      effort = stored[promptedOption] ?? null;
      delete stored[promptedOption];
    }
  } else {
    const impl = clients.get(client);
    if (model === null) throw new ConfigurationError('Model is required.');
    const catalog = await args.getCatalog(client);
    model = knownModel(model, catalog);
    const {effortOption} = impl;
    if (args.effort !== null && !effortOption) throw new ConfigurationError(`${args.role} client does not support effort.`);
    if (args.effort !== null && effortOption && Object.hasOwn(args.options, effortOption)) {
      throw new ConfigurationError(`${args.role} effort conflicts with option ${effortOption}; use only one.`);
    }
    if (args.effort !== null && model.includes('#') && effortOption === 'variant') {
      throw new ConfigurationError(`${args.role} model already selects a #variant; omit effort.`);
    }
    const requested = args.effort !== null && effortOption
      ? { ...args.options, [effortOption]: args.effort }
      : args.options;
    stored = await acceptedOptions(impl, model, catalog, which, args.runCommand, requested);
    if (args.effort !== null && effortOption) delete stored[effortOption];
  }
  if (model.trim() === '') throw new ConfigurationError('Model is required.');
  const primary = { client, model: model.trim(), options: stored, ...(effort !== null ? { effort } : {}) };
  return primary;
}

function classify(
  workspace: string,
  clients: import('@nodeint/migent-kernel').ClientRegistry,
  which: Which,
): { state: 'create' | 'ready' | 'conflict'; conflicts: string[] } {
  const root = path.join(workspace, '.migent');
  const config = path.join(root, 'config.yaml');
  const workflows = path.join(root, 'workflows');
  const gitignore = path.join(root, '.gitignore');
  const owned: string[] = [];
  if (exists(config)) owned.push('.migent/config.yaml');
  if (exists(path.join(root, 'config.local.yaml'))) owned.push('.migent/config.local.yaml');
  if (exists(workflows) && !(isDirectory(workflows) && readdirSync(workflows).length === 0)) {
    owned.push('.migent/workflows');
    if (isDirectory(workflows)) {
      for (const name of readdirSync(workflows).filter((item) => item.endsWith('.yaml')).sort()) {
        if (isFile(path.join(workflows, name))) owned.push(`.migent/workflows/${name}`);
      }
    }
  }
  if (exists(gitignore)) owned.push('.migent/.gitignore');
  if (owned.length === 0) return { state: 'create', conflicts: [] };
  const yamlFiles = isDirectory(workflows)
    ? readdirSync(workflows).filter((name) => name.endsWith('.yaml') && isFile(path.join(workflows, name)))
    : [];
  if (isFile(config) && yamlFiles.length > 0) {
    const checks = diagnose(workspace, { clients, which });
    const byName = new Map(checks.map((check) => [check.name, check]));
    if (byName.get('config')?.ok && byName.get('workflows')?.ok) return { state: 'ready', conflicts: [] };
  }
  return { state: 'conflict', conflicts: owned };
}

function writeProject(workspace: string, files: readonly RenderedFile[]): string[] {
  for (const file of files) {
    const target = path.join(workspace, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
  return files.map((file) => file.path);
}

async function promptOptions(
  client: import('@nodeint/migent-kernel').CliClient,
  model: string,
  catalog: ModelCatalog,
  which: Which,
  runCommand: RunCommand,
  prompt: Prompter,
): Promise<Record<string, string>> {
  const stored: Record<string, string> = {};
  for (const spec of clientOptions(client)) {
    if (!spec.prompt) continue;
    const values = await loadOptionValues(catalogSourceOf(client), spec.name, model, catalog, which, runCommand);
    if (values === null || values.length === 0) continue;
    const picked = await prompt.selectOption(spec.name, values, spec.allowDefault ?? false);
    if (picked) stored[spec.name] = picked;
  }
  return stored;
}

function clientOptions(client: import('@nodeint/migent-kernel').CliClient) {
  return asCatalog(catalogSourceOf(client)).clientOptions();
}

class ClackPrompter implements Prompter {
  public async selectModel(models: readonly ModelSelection[], message: string): Promise<ModelSelection> {
    const result = await autocomplete({
      message,
      placeholder: 'Search client or model...',
      options: models.map((item, index) => ({ value: String(index), label: `${item.client} / ${item.model}` })),
      filter: (search, option) => (option.label ?? '').toLowerCase().includes(search.toLowerCase()),
    });
    if (isCancel(result)) throw new PromptCancelled();
    const selected = models[Number(result)];
    if (!selected) throw new ConfigurationError('Model is required.');
    return selected;
  }

  public async selectOption(name: string, values: readonly string[], allowDefault: boolean): Promise<string> {
    if (values.length === 0) return '';
    const options = [
      ...(allowDefault ? [{ value: '', label: 'client default' }] : []),
      ...values.map((value) => ({ value, label: value })),
    ];
    const result = await clackSelect({
      message: name,
      options,
      initialValue: allowDefault ? '' : values[0],
    });
    const allowed = new Set(allowDefault ? ['', ...values] : values);
    if (isCancel(result)) throw new PromptCancelled();
    if (!allowed.has(String(result ?? ''))) {
      throw new ConfigurationError(`Unknown ${name} value: ${String(result)}.`);
    }
    return (result === null || result === undefined) ? '' : String(result);
  }
}
