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
import { EXIT_CONFIG } from '../exits.js';
import { exists, isDirectory, isFile } from '../fs-utils.js';
import { cliHooks } from '../hooks.js';
import { type ModelChoice, type RenderedFile,renderProject } from '../project-template.js';
import { runDoctor } from './doctor.js';

/** Column width of role names in the init summary. */
const ROLE_NAME_WIDTH = 10;

const INIT_EXAMPLE = 'Example: migent init --planner-client codex --planner-model gpt-5 --reviewer-client grok --reviewer-model grok-4.7 --client codex --developer-model gpt-5 --no-input';


export interface ModelSelection { client: string; model: string }

export interface Prompter {
  selectModel(models: readonly ModelSelection[], message: string): ModelSelection | Promise<ModelSelection>;
  selectOption(name: string, values: readonly string[], allowDefault: boolean): string | Promise<string>;
}

export interface InitOptions {
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
}

/** The model selection flags given for one role. */
interface RoleFlags {
  role: 'planner' | 'reviewer' | 'developer';
  client: string | null;
  model: string | null;
  pairs: readonly string[];
  effort: string | null;
  prefix: string;
}

interface InitEnv {
  clients: import('@nodeint/migent-kernel').ClientRegistry;
  which: Which;
  prompt: Prompter;
  execute: RunCommand;
  getCatalog: (name: string) => Promise<ModelCatalog>;
}

export async function runInit(workspace: string, options: InitOptions = {}): Promise<number> {
  const interactive = options.interactive ?? false;
  const [planner, reviewer, developer] = roleFlagsOf(options);
  const roles = [planner, reviewer, developer];
  const env = initEnv(options);
  const early = preflight(workspace, { env, roles, interactive });
  if (early !== null) return early;
  const models = roles.some((flags) => flags.client === null) ? await loadModels(env, Boolean(options.prompter)) : [];
  if (models === null) return EXIT_CONFIG;
  let selected: { planner: ModelChoice; reviewer: ModelChoice; developer: ModelChoice };
  try {
    selected = {
      planner: await roleChoice(env, planner, models),
      reviewer: await roleChoice(env, reviewer, models),
      developer: await roleChoice(env, developer, models),
    };
  } catch (error) {
    if (error instanceof PromptCancelled) throw error;
    printError(error instanceof Error ? error.message : String(error));
    return EXIT_CONFIG;
  }
  return writeInitProject(workspace, selected, { env, interactive });
}

/** The exit code when init stops before selecting models; null to continue. */
function preflight(
  workspace: string,
  context: { env: InitEnv; roles: readonly RoleFlags[]; interactive: boolean },
): number | null {
  const { env, roles } = context;
  const classified = classify(workspace, env.clients, env.which);
  if (classified.state === 'ready') {
    if (roles.some(hasSelectionFlags)) printError('Already initialized; ignoring model selection flags.');
    printAlreadyInitialized();
    printInitNextSteps();
    return 0;
  }
  for (const flags of roles) {
    const problem = roleFlagProblem(flags, context.interactive);
    if (problem !== null) {
      printError(problem);
      return EXIT_CONFIG;
    }
  }
  if (classified.state === 'conflict') {
    printInitConflicts(classified.conflicts);
    return 1;
  }
  return null;
}

function roleFlagsOf(options: InitOptions): [RoleFlags, RoleFlags, RoleFlags] {
  return [
    {
      role: 'planner', client: options.plannerClient ?? null, model: options.plannerModel ?? null,
      pairs: options.plannerOptions ?? [], effort: options.plannerEffort ?? null, prefix: 'planner-',
    },
    {
      role: 'reviewer', client: options.reviewerClient ?? null, model: options.reviewerModel ?? null,
      pairs: options.reviewerOptions ?? [], effort: options.reviewerEffort ?? null, prefix: 'reviewer-',
    },
    {
      role: 'developer', client: options.client ?? null, model: options.model ?? null,
      pairs: options.options ?? [], effort: options.effort ?? null, prefix: 'developer-',
    },
  ];
}

/** Resolves injected seams and memoizes client commands and catalogs for one init run. */
function initEnv(options: InitOptions): InitEnv {
  const clients = options.clients ?? clientRegistry();
  const which = options.which ?? cliHooks.which ?? whichSync;
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
  const catalogs = new Map<string, Promise<ModelCatalog>>();
  const getCatalog = (name: string): Promise<ModelCatalog> => {
    let catalog = catalogs.get(name);
    if (!catalog) {
      catalog = loadCatalog(catalogSourceOf(clients.get(name)), which, execute);
      catalogs.set(name, catalog);
    }
    return catalog;
  };
  return { clients, which, prompt: options.prompter ?? new ClackPrompter(), execute, getCatalog };
}

function hasSelectionFlags(flags: RoleFlags): boolean {
  return flags.client !== null || flags.model !== null || flags.effort !== null || flags.pairs.length > 0;
}

function roleFlagProblem(flags: RoleFlags, interactive: boolean): string | null {
  const { role, prefix } = flags;
  const clientFlag = role === 'developer' ? '--client' : `--${prefix}client`;
  const names = `${clientFlag} and --${prefix}model`;
  if ((flags.client === null) !== (flags.model === null)) {
    return `Pass both ${names} for ${role}, or omit both.\n${INIT_EXAMPLE}`;
  }
  if (flags.pairs.length > 0 && flags.client === null) return `Pass ${names} with --${prefix}option.`;
  if (flags.effort !== null && flags.client === null) return `Pass ${names} with --${prefix}effort.`;
  if (flags.client === null && !interactive) {
    return `Pass ${names} for ${role} when init is not interactive.\n${INIT_EXAMPLE}`;
  }
  return null;
}

/** Every model the installed clients list; null when none is available. */
async function loadModels(env: InitEnv, injectedPrompter: boolean): Promise<ModelSelection[] | null> {
  const models: ModelSelection[] = [];
  const loading = injectedPrompter ? null : spinner();
  loading?.start('Loading models from installed clients...');
  const rows = detected(env.which).filter(([, found]) => found !== null);
  const results = await Promise.allSettled(rows.map(async ([name]) => ({ name, catalog: await env.getCatalog(name) })));
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
    return null;
  }
  return models;
}

function roleChoice(env: InitEnv, flags: RoleFlags, models: readonly ModelSelection[]): Promise<ModelChoice> {
  return choices({ clients: env.clients, which: env.which, prompt: env.prompt }, {
    role: flags.role.charAt(0).toUpperCase() + flags.role.slice(1),
    client: flags.client,
    model: flags.model,
    options: parseOptions(flags.pairs),
    effort: flags.effort,
    runCommand: env.execute,
    models, getCatalog: env.getCatalog,
  });
}

async function writeInitProject(
  workspace: string,
  selected: { planner: ModelChoice; reviewer: ModelChoice; developer: ModelChoice },
  context: { env: InitEnv; interactive: boolean },
): Promise<number> {
  const { planner, reviewer, developer } = selected;
  const { env } = context;
  let files: RenderedFile[];
  try {
    files = renderProject(selected);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return EXIT_CONFIG;
  }
  const paths = writeProject(workspace, files);
  printCreated(
    paths,
    `Planner: ${planner.client}/${planner.model}. Reviewer: ${reviewer.client}/${reviewer.model}. Developer: ${developer.client}/${developer.model}. Workflows: implement, plan.`,
  );
  printRoleDescriptions(workspace);
  if (context.interactive) {
    const doctorCode = await runDoctor(workspace, { which: env.which, runCommand: env.execute });
    if (doctorCode !== 0) writeDoctorProblems(workspace, env.clients, env.which);
  } else {
    writeDoctorProblems(workspace, env.clients, env.which);
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
    if (description !== null) lines.push(`  ${role.padEnd(ROLE_NAME_WIDTH)} ${description}`);
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

type ChoiceEnv = { clients: import('@nodeint/migent-kernel').ClientRegistry; which: Which; prompt: Prompter };

interface ChoiceArgs {
  role: string;
  client: string | null;
  model: string | null;
  options: Record<string, string>;
  effort: string | null;
  runCommand: RunCommand;
  models: readonly ModelSelection[];
  getCatalog: (name: string) => Promise<ModelCatalog>;
}

/** A client and model with the options to store and the effort, before the final model check. */
interface PendingChoice {
  client: string;
  model: string;
  stored: Record<string, string>;
  effort: string | null;
}

async function choices(env: ChoiceEnv, args: ChoiceArgs): Promise<ModelChoice> {
  const pending = args.client === null ? await promptedChoice(env, args) : await givenChoice(env, args, args.client);
  const { client, model, stored, effort } = pending;
  if (model.trim() === '') throw new ConfigurationError('Model is required.');
  const primary = { client, model: model.trim(), options: stored, ...(effort !== null ? { effort } : {}) };
  return primary;
}

async function promptedChoice(env: ChoiceEnv, args: ChoiceArgs): Promise<PendingChoice> {
  const { clients, which, prompt } = env;
  const selected = await prompt.selectModel(args.models, `${args.role} model`);
  if (!args.models.some((item) => item.client === selected.client && item.model === selected.model)) {
    throw new ConfigurationError('Unknown client or model.');
  }
  const { client, model } = selected;
  const impl = clients.get(client);
  const catalog = await args.getCatalog(client);
  const stored = await promptOptions(impl, { model, catalog }, { which, runCommand: args.runCommand, prompt });
  let { effort } = args;
  // The prompt stores effort as a native option; keep it in the dedicated `effort` field instead.
  const promptedOption = impl.effortOption;
  if (promptedOption && Object.hasOwn(stored, promptedOption) && !(promptedOption === 'variant' && model.includes('#'))) {
    effort = stored[promptedOption] ?? null;
    delete stored[promptedOption];
  }
  return { client, model, stored, effort };
}

async function givenChoice(env: ChoiceEnv, args: ChoiceArgs, client: string): Promise<PendingChoice> {
  const impl = env.clients.get(client);
  if (args.model === null) throw new ConfigurationError('Model is required.');
  const catalog = await args.getCatalog(client);
  const model = knownModel(args.model, catalog);
  const { effortOption } = impl;
  checkGivenEffort(args, model, effortOption);
  const requested = args.effort !== null && effortOption
    ? { ...args.options, [effortOption]: args.effort }
    : args.options;
  const stored = await acceptedOptions(impl, {
    model, catalog, which: env.which, runCommand: args.runCommand, options: requested,
  });
  if (args.effort !== null && effortOption) delete stored[effortOption];
  return { client, model, stored, effort: args.effort };
}

function checkGivenEffort(args: ChoiceArgs, model: string, effortOption: string | null | undefined): void {
  if (args.effort === null) return;
  if (!effortOption) throw new ConfigurationError(`${args.role} client does not support effort.`);
  if (Object.hasOwn(args.options, effortOption)) {
    throw new ConfigurationError(`${args.role} effort conflicts with option ${effortOption}; use only one.`);
  }
  if (model.includes('#') && effortOption === 'variant') {
    throw new ConfigurationError(`${args.role} model already selects a #variant; omit effort.`);
  }
}

function classify(
  workspace: string,
  clients: import('@nodeint/migent-kernel').ClientRegistry,
  which: Which,
): { state: 'create' | 'ready' | 'conflict'; conflicts: string[] } {
  const root = path.join(workspace, '.migent');
  const config = path.join(root, 'config.yaml');
  const workflows = path.join(root, 'workflows');
  const owned = ownedPaths(root, workflows);
  if (owned.length === 0) return { state: 'create', conflicts: [] };
  if (isFile(config) && workflowYamlFiles(workflows).length > 0) {
    const checks = diagnose(workspace, { clients, which });
    const byName = new Map(checks.map((check) => [check.name, check]));
    if (byName.get('config')?.ok && byName.get('workflows')?.ok) return { state: 'ready', conflicts: [] };
  }
  return { state: 'conflict', conflicts: owned };
}

/** Migent-owned paths that already exist, in report order. */
function ownedPaths(root: string, workflows: string): string[] {
  const owned: string[] = [];
  if (exists(path.join(root, 'config.yaml'))) owned.push('.migent/config.yaml');
  if (exists(path.join(root, 'config.local.yaml'))) owned.push('.migent/config.local.yaml');
  if (exists(workflows) && !(isDirectory(workflows) && readdirSync(workflows).length === 0)) {
    owned.push('.migent/workflows', ...workflowYamlFiles(workflows).sort().map((name) => `.migent/workflows/${name}`));
  }
  if (exists(path.join(root, '.gitignore'))) owned.push('.migent/.gitignore');
  return owned;
}

function workflowYamlFiles(workflows: string): string[] {
  if (!isDirectory(workflows)) return [];
  return readdirSync(workflows).filter((name) => name.endsWith('.yaml') && isFile(path.join(workflows, name)));
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
  subject: { model: string; catalog: ModelCatalog },
  env: { which: Which; runCommand: RunCommand; prompt: Prompter },
): Promise<Record<string, string>> {
  const { model, catalog } = subject;
  const { which, runCommand, prompt } = env;
  const stored: Record<string, string> = {};
  for (const spec of clientOptions(client)) {
    if (!spec.prompt) continue;
    const values = await loadOptionValues(
      { source: catalogSourceOf(client), name: spec.name, model, catalog },
      { which, runCommand },
    );
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
