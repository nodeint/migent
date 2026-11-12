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
  runOptionsCommand,
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
import {
  type AgentSlot,
  discoverAgentSlots,
  type ModelChoice,
  PRESETS,
  type RenderedFile,
  renderProject,
} from '../project-template.js';
import { runDoctor } from './doctor.js';

/** Column width of role names in the init summary. */
const ROLE_NAME_WIDTH = 10;

const EXAMPLE_CHOICES = ['codex:gpt-5', 'grok:grok-4.7'];

/** A generated example invocation that fills every slot of the template. */
function initExample(slots: readonly AgentSlot[]): string {
  const flags = slots.map((slot, index) => `--agent ${slot.name}=${EXAMPLE_CHOICES[index % EXAMPLE_CHOICES.length]}`);
  return `Example: migent init ${flags.join(' ')} --no-input`;
}

/** The slot name with the roles it serves, for prompts, errors, and the summary. */
function slotLabel(slot: AgentSlot): string {
  return `${slot.name} (${slot.roles.join(', ')})`;
}

export interface ModelSelection { client: string; model: string }

export interface Prompter {
  selectModel(models: readonly ModelSelection[], message: string): ModelSelection | Promise<ModelSelection>;
  selectOption(name: string, values: readonly string[], allowDefault: boolean): string | Promise<string>;
}

export interface InitOptions {
  /** Raw `--agent NAME=CLIENT:MODEL` values. */
  agents?: readonly string[];
  /** Raw `--agent-effort NAME=EFFORT` values. */
  agentEfforts?: readonly string[];
  /** Raw `--agent-option NAME:KEY=VALUE` values. */
  agentOptions?: readonly string[];
  /** Project template directory; defaults to the packaged template. */
  templateDirectory?: string;
  interactive?: boolean;
  clients?: import('@nodeint/migent-kernel').ClientRegistry | null;
  which?: Which | null;
  prompter?: Prompter | null;
  runCommand?: RunCommand | null;
}

/** The model selection flags given for one agent slot. */
interface SlotFlags {
  slot: AgentSlot;
  client: string | null;
  model: string | null;
  pairs: string[];
  effort: string | null;
}

interface InitEnv {
  clients: import('@nodeint/migent-kernel').ClientRegistry;
  which: Which;
  prompt: Prompter;
  execute: RunCommand;
  /** Reads client help, which some CLIs print on stderr. */
  help: RunCommand;
  getCatalog: (name: string) => Promise<ModelCatalog>;
}

export async function runInit(workspace: string, options: InitOptions = {}): Promise<number> {
  const interactive = options.interactive ?? false;
  const env = initEnv(options);
  const classified = classify(workspace, env.clients, env.which);
  if (alreadyInitialized(classified, options)) return 0;
  let slots: AgentSlot[];
  let flags: SlotFlags[];
  try {
    slots = discoverAgentSlots(options.templateDirectory);
    flags = parseSlotFlags(slots, options);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return EXIT_CONFIG;
  }
  const early = preflight(classified, { slots: flags, interactive });
  if (early !== null) return early;
  const models = flags.some((item) => item.client === null) ? await loadModels(env, Boolean(options.prompter)) : [];
  if (models === null) return EXIT_CONFIG;
  const selected = await selectAll(env, flags, models);
  if (selected === null) return EXIT_CONFIG;
  const context = { env, interactive, templateDirectory: options.templateDirectory };
  return writeInitProject(workspace, { slots, selected }, context);
}

/** The choice for every slot; null after reporting a configuration problem. */
async function selectAll(
  env: InitEnv,
  flags: readonly SlotFlags[],
  models: readonly ModelSelection[],
): Promise<Record<string, ModelChoice> | null> {
  const selected: Record<string, ModelChoice> = {};
  try {
    for (const item of flags) selected[item.slot.name] = await slotChoice(env, item, models);
  } catch (error) {
    if (error instanceof PromptCancelled) throw error;
    printError(error instanceof Error ? error.message : String(error));
    return null;
  }
  return selected;
}

/** Reports an existing valid project before parsing model selection flags. */
function alreadyInitialized(classified: ReturnType<typeof classify>, options: InitOptions): boolean {
  if (classified.state !== 'ready') return false;
  if (hasSelectionFlags(options)) printError('Already initialized; ignoring model selection flags.');
  printAlreadyInitialized();
  printInitNextSteps();
  return true;
}

/** The exit code when init stops before selecting models; null to continue. */
function preflight(
  classified: ReturnType<typeof classify>,
  context: { slots: readonly SlotFlags[]; interactive: boolean },
): number | null {
  const { slots } = context;
  if (!context.interactive) {
    const missing = slots.filter((item) => item.client === null).map((item) => slotLabel(item.slot));
    if (missing.length > 0) {
      printError(`Pass --agent NAME=CLIENT:MODEL for ${missing.join(', ')} when init is not interactive.\n${initExample(slots.map((item) => item.slot))}`);
      return EXIT_CONFIG;
    }
  }
  if (classified.state === 'conflict') {
    printInitConflicts(classified.conflicts);
    return 1;
  }
  return null;
}

/** Splits `text` at the first `separator`; null when the separator is absent or a side is empty. */
function splitFirst(text: string, separator: string): [string, string] | null {
  const at = text.indexOf(separator);
  if (at <= 0 || at === text.length - 1) return null;
  return [text.slice(0, at), text.slice(at + 1)];
}

/** Maps the raw agent flags onto the template slots; throws a `ConfigurationError` for malformed input. */
function parseSlotFlags(slots: readonly AgentSlot[], options: InitOptions): SlotFlags[] {
  const bySlot = new Map<string, SlotFlags>(
    slots.map((slot) => [slot.name, { slot, client: null, model: null, pairs: [], effort: null }]),
  );
  const known = `Agents in this template: ${slots.map(slotLabel).join(', ')}.`;
  const find = (name: string, flag: string): SlotFlags => {
    const found = bySlot.get(name);
    if (!found) throw new ConfigurationError(`Unknown agent "${name}" for ${flag}. ${known}`);
    return found;
  };
  for (const value of options.agents ?? []) applyAgent(find, slots, value);
  for (const value of options.agentEfforts ?? []) applyEffort(find, value);
  for (const value of options.agentOptions ?? []) applyOption(find, value);
  return [...bySlot.values()];
}

type FindSlot = (name: string, flag: string) => SlotFlags;

function applyAgent(find: FindSlot, slots: readonly AgentSlot[], value: string): void {
  const named = splitFirst(value, '=');
  const choice = named === null ? null : splitFirst(named[1], ':');
  if (named === null || choice === null) {
    throw new ConfigurationError(`Invalid --agent "${value}"; use NAME=CLIENT:MODEL.
${initExample(slots)}`);
  }
  const target = find(named[0], '--agent');
  if (target.client !== null) throw new ConfigurationError(`--agent ${named[0]} was given more than once.`);
  [target.client, target.model] = choice;
}

function applyEffort(find: FindSlot, value: string): void {
  const named = splitFirst(value, '=');
  if (named === null) throw new ConfigurationError(`Invalid --agent-effort "${value}"; use NAME=EFFORT.`);
  const target = find(named[0], '--agent-effort');
  if (target.client === null) throw new ConfigurationError(`Pass --agent ${named[0]}=CLIENT:MODEL with --agent-effort.`);
  if (target.effort !== null) throw new ConfigurationError(`--agent-effort ${named[0]} was given more than once.`);
  target.effort = named[1];
}

function applyOption(find: FindSlot, value: string): void {
  const named = splitFirst(value, ':');
  if (named === null) throw new ConfigurationError(`Invalid --agent-option "${value}"; use NAME:KEY=VALUE.`);
  const target = find(named[0], '--agent-option');
  if (target.client === null) throw new ConfigurationError(`Pass --agent ${named[0]}=CLIENT:MODEL with --agent-option.`);
  target.pairs.push(named[1]);
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
  const help: RunCommand = options.runCommand ?? cliHooks.runCommand ?? runOptionsCommand;
  return { clients, which, prompt: options.prompter ?? new ClackPrompter(), execute, help, getCatalog };
}

function hasSelectionFlags(options: InitOptions): boolean {
  return [options.agents, options.agentEfforts, options.agentOptions].some((values) => (values?.length ?? 0) > 0);
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

function slotChoice(env: InitEnv, flags: SlotFlags, models: readonly ModelSelection[]): Promise<ModelChoice> {
  return choices({ clients: env.clients, which: env.which, prompt: env.prompt }, {
    role: slotLabel(flags.slot),
    client: flags.client,
    model: flags.model,
    options: parseOptions(flags.pairs),
    effort: flags.effort,
    runCommand: env.execute,
    helpCommand: env.help,
    models, getCatalog: env.getCatalog,
  });
}

async function writeInitProject(
  workspace: string,
  chosen: { slots: readonly AgentSlot[]; selected: Record<string, ModelChoice> },
  context: { env: InitEnv; interactive: boolean; templateDirectory?: string },
): Promise<number> {
  const { env } = context;
  let files: RenderedFile[];
  try {
    files = renderProject(chosen.selected, context.templateDirectory);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return EXIT_CONFIG;
  }
  const paths = writeProject(workspace, files);
  const picks = chosen.slots.flatMap((slot) => {
    const choice = chosen.selected[slot.name];
    return choice ? [`${slotLabel(slot)}: ${choice.client}/${choice.model}`] : [];
  });
  printCreated(paths, `${picks.join('. ')}. Workflows: ${PRESETS.join(', ')}.`);
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
  helpCommand?: RunCommand;
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
    model, catalog, which: env.which, runCommand: args.runCommand, helpCommand: args.helpCommand, options: requested,
    warn: (message) => process.stderr.write(`Warning: ${message}\n`),
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
