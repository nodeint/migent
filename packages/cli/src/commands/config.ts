import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { confirm as clackConfirm, isCancel, select as clackSelect, text as clackText } from "@clack/prompts";
import type { ModelCatalog } from "@nodeint/migent-adapters";
import {
  ConfigEditError,
  ConfigurationError,
  LOCAL_CONFIG_FILE,
  assignRoles,
  configPath,
  describeChange,
  diagnose,
  hasLocalConfig,
  inspectConfig,
  loadModelTarget,
  loadWorkflowCatalog,
  loadWorkspaceConfig,
  loadYamlMapping,
  matchingModelName,
  patchConfigText,
  placeRoleModel,
  isRoleStage,
  resolveStageSpec,
  setRoleOptions,
  stringifyConfig,
  upsertModel,
  whichSync,
  type Provider,
  type ConfigChange,
  type ConfigView,
  type ModelView,
  type RoleView,
  type StageTarget,
  type WorkflowDocument,
} from "@nodeint/migent-kernel";
import { printError } from "../display.js";
import { PromptCancelled } from "../errors.js";
import { cliHooks } from "../hooks.js";
import { requireCurrentSchema } from "../migrate.js";
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
import { runDoctor } from "./doctor.js";

const NEW = "__new__";
const UNSET = Symbol("unset");
type OptionUpdates = Record<string, string | null> | typeof UNSET;

export interface ConfigPrompter {
  select(message: string, choices: ReadonlyArray<readonly [string, string]>, defaultValue?: string | null): string | Promise<string>;
  confirm(message: string): boolean | Promise<boolean>;
  text(message: string, defaultValue?: string): string | Promise<string>;
}

export function runConfigShow(workspace: string): number {
  if (!hasLocalConfig(workspace)) {
    process.stdout.write(readFileSync(configPath(workspace), "utf8"));
    return 0;
  }
  process.stdout.write(stringifyConfig(loadWorkspaceConfig(workspace)));
  process.stderr.write(`Merged with .migent/${LOCAL_CONFIG_FILE}.
`);
  return 0;
}

export async function runConfigModel(
  workspace: string,
  options: {
    key?: string | null;
    provider?: string | null;
    model?: string | null;
    options?: readonly string[];
    clearOptions?: readonly string[];
    asJson?: boolean;
    interactive?: boolean;
    providers?: Record<string, Provider> | null;
    which?: Which | null;
    prompter?: ConfigPrompter | null;
    runCommand?: RunCommand | null;
  } = {},
): Promise<number> {
  try {
    return await runModel(workspace, {
      ...options,
      providers: options.providers ?? providerMap(),
      which: options.which ?? cliHooks.which ?? whichSync,
      prompter: options.prompter ?? new ClackConfigPrompter(),
      runCommand: options.runCommand ?? runProviderCommand,
    });
  } catch (error) {
    if (error instanceof PromptCancelled) throw error;
    if (error instanceof ConfigurationError || error instanceof ConfigEditError || error instanceof Error) {
      printError(error.message);
      return 2;
    }
    throw error;
  }
}

export async function runConfigRole(
  workspace: string,
  options: {
    roles?: readonly string[];
    modelName?: string | null;
    provider?: string | null;
    model?: string | null;
    options?: readonly string[];
    clearOptions?: readonly string[];
    asJson?: boolean;
    interactive?: boolean;
    providers?: Record<string, Provider> | null;
    which?: Which | null;
    prompter?: ConfigPrompter | null;
    runCommand?: RunCommand | null;
  } = {},
): Promise<number> {
  try {
    return await runRole(workspace, {
      ...options,
      providers: options.providers ?? providerMap(),
      which: options.which ?? cliHooks.which ?? whichSync,
      prompter: options.prompter ?? new ClackConfigPrompter(),
      runCommand: options.runCommand ?? runProviderCommand,
    });
  } catch (error) {
    if (error instanceof PromptCancelled) throw error;
    if (error instanceof ConfigurationError || error instanceof ConfigEditError || error instanceof Error) {
      printError(error.message);
      return 2;
    }
    throw error;
  }
}

async function runModel(
  workspace: string,
  args: {
    key?: string | null;
    provider?: string | null;
    model?: string | null;
    options?: readonly string[];
    clearOptions?: readonly string[];
    asJson?: boolean;
    interactive?: boolean;
    providers: Record<string, Provider>;
    which: Which;
    prompter: ConfigPrompter;
    runCommand: RunCommand;
  },
): Promise<number> {
  const key = args.key ?? null;
  let provider = args.provider ?? null;
  let model = args.model ?? null;
  const asJson = args.asJson ?? false;
  const interactive = args.interactive ?? false;
  let optionUpdates = optionUpdatesOf(args.options ?? [], args.clearOptions ?? []);
  if ((provider === null) !== (model === null)) {
    throw new ConfigEditError("Pass both --provider and --model, or omit both.");
  }
  const [config, workflows, view] = loaded(workspace);
  const mutating = provider !== null || optionUpdates !== UNSET;
  if (key === null && !mutating) {
    if (interactive) {
      return interactiveModels(workspace, config, workflows, view, args.providers, args.which, args.prompter, args.runCommand, asJson);
    }
    emitView(view, asJson, true, false);
    return 0;
  }
  if (key === null) throw new ConfigEditError("Pass a name.");
  if (!mutating) {
    if (interactive) {
      return editModel(workspace, config, workflows, view, key, args.providers, args.which, args.prompter, args.runCommand, asJson);
    }
    emitModels(selectedModels(view, [key]), asJson);
    return 0;
  }
  let catalog: ModelCatalog | null = null;
  if (provider !== null && model !== null) {
    [provider, model, catalog] = await catalogModel(args.providers, args.which, args.runCommand, provider, model);
  }
  if (optionUpdates !== UNSET) {
    const currentProvider = provider ?? modelProvider(config, key);
    const currentModel = model ?? loadModelTarget(config, key).model;
    optionUpdates = await checkedOptions(
      args.providers,
      args.which,
      args.runCommand,
      currentProvider,
      currentModel,
      optionUpdates,
      provider !== null ? catalog : null,
    );
  }
  const change = upsertModel(config, key, {
    provider,
    model,
    ...(optionUpdates === UNSET ? {} : { options: optionUpdates }),
    workflows,
  });
  validateChange(config, change.config, workflows, args.providers);
  return await commit(workspace, change, { asJson, which: args.which });
}

async function runRole(
  workspace: string,
  args: {
    roles?: readonly string[];
    modelName?: string | null;
    provider?: string | null;
    model?: string | null;
    options?: readonly string[];
    clearOptions?: readonly string[];
    asJson?: boolean;
    interactive?: boolean;
    providers: Record<string, Provider>;
    which: Which;
    prompter: ConfigPrompter;
    runCommand: RunCommand;
  },
): Promise<number> {
  const roles = args.roles ?? [];
  const modelName = args.modelName ?? null;
  let provider = args.provider ?? null;
  let model = args.model ?? null;
  const asJson = args.asJson ?? false;
  const interactive = args.interactive ?? false;
  let optionUpdates = optionUpdatesOf(args.options ?? [], args.clearOptions ?? []);
  if (modelName !== null && (provider !== null || model !== null)) {
    throw new ConfigEditError("Pass --model-name or --provider and --model.");
  }
  if ((provider === null) !== (model === null)) {
    throw new ConfigEditError("Pass both --provider and --model, or omit both.");
  }
  const [config, workflows, view] = loaded(workspace);
  const mutating = modelName !== null || provider !== null || optionUpdates !== UNSET;
  if (roles.length === 0 && !mutating) {
    if (interactive) {
      return interactiveRoles(workspace, config, workflows, view, args.providers, args.which, args.prompter, args.runCommand, asJson);
    }
    emitView(view, asJson, false, true);
    return 0;
  }
  if (roles.length === 0) throw new ConfigEditError("Pass a role.");
  if (roles.length > 1 && (provider !== null || optionUpdates !== UNSET)) {
    throw new ConfigEditError("Pass one role to set options or a provider model.");
  }
  if (!mutating) {
    if (interactive && roles.length === 1) {
      knownRole(view, roles[0] ?? "");
      return pointRole(workspace, config, workflows, view, roles[0] ?? "", args.providers, args.which, args.prompter, args.runCommand, asJson);
    }
    emitRoles(selectedRoles(view, roles), asJson);
    return 0;
  }
  let change: ConfigChange;
  if (provider !== null && model !== null) {
    let catalog: ModelCatalog;
    [provider, model, catalog] = await catalogModel(args.providers, args.which, args.runCommand, provider, model);
    if (optionUpdates !== UNSET) {
      optionUpdates = await checkedOptions(args.providers, args.which, args.runCommand, provider, model, optionUpdates, catalog);
    }
    change = placeRoleModel(config, roles[0] ?? "", {
      provider,
      model,
      ...(optionUpdates === UNSET ? {} : { options: optionUpdates }),
      workflows,
    });
  } else if (modelName !== null) {
    change = assignRoles(config, roles, modelName, { workflows });
    if (optionUpdates !== UNSET) {
      const target = loadModelTarget(change.config, modelName);
      optionUpdates = await checkedOptions(
        args.providers,
        args.which,
        args.runCommand,
        target.provider,
        target.model,
        optionUpdates,
      );
      const follow = setRoleOptions(change.config, roles[0] ?? "", optionUpdates, { workflows });
      change = describeChange(config, follow.config, workflows);
    }
  } else {
    const target = roleModel(config, roles[0] ?? "");
    if (optionUpdates === UNSET) throw new ConfigEditError("Pass a role.");
    optionUpdates = await checkedOptions(
      args.providers,
      args.which,
      args.runCommand,
      target.provider,
      target.model,
      optionUpdates,
    );
    change = setRoleOptions(config, roles[0] ?? "", optionUpdates, { workflows });
  }
  validateChange(config, change.config, workflows, args.providers);
  return await commit(workspace, change, { asJson, which: args.which });
}

async function interactiveModels(
  workspace: string,
  config: Record<string, unknown>,
  workflows: readonly WorkflowDocument[],
  view: ConfigView,
  providers: Record<string, Provider>,
  which: Which,
  prompter: ConfigPrompter,
  runCommand: RunCommand,
  asJson: boolean,
): Promise<number> {
  const choices = view.models.map((model) => [modelLabel(model), model.key] as const);
  choices.push(["New model", NEW]);
  const selected = await prompter.select("Model", choices, view.models[0]?.key ?? NEW);
  if (selected === NEW) return addModel(workspace, config, workflows, null, providers, which, prompter, runCommand, asJson);
  return editModel(workspace, config, workflows, view, selected, providers, which, prompter, runCommand, asJson);
}

async function editModel(
  workspace: string,
  config: Record<string, unknown>,
  workflows: readonly WorkflowDocument[],
  view: ConfigView,
  key: string,
  providers: Record<string, Provider>,
  which: Which,
  prompter: ConfigPrompter,
  runCommand: RunCommand,
  asJson: boolean,
): Promise<number> {
  const current = selectedModels(view, [key])[0];
  if (current === undefined) throw new ConfigEditError(`Unknown name: ${key}.`);
  const provider = await selectProvider(prompter, providers, which, "Provider", current.provider);
  const impl = requireProvider(providers, provider);
  const catalog = await loadCatalog(impl, which, runCommand);
  const initial = catalog.ids.includes(current.model) ? current.model : (catalog.defaultId ?? undefined);
  let modelId = knownModel(
    await prompter.select("Model", catalog.ids.map((item) => [item, item] as const), initial),
    catalog,
  );
  const stored = await promptedOptions(prompter, impl, modelId, catalog, which, runCommand, current.options);
  const change = upsertModel(config, key, { provider, model: modelId, options: stored, workflows });
  validateChange(config, change.config, workflows, providers);
  return confirmAndCommit(workspace, change, prompter, asJson, which);
}

async function addModel(
  workspace: string,
  config: Record<string, unknown>,
  workflows: readonly WorkflowDocument[],
  role: string | null,
  providers: Record<string, Provider>,
  which: Which,
  prompter: ConfigPrompter,
  runCommand: RunCommand,
  asJson: boolean,
): Promise<number> {
  const provider = await selectProvider(prompter, providers, which, "Provider", null);
  const impl = requireProvider(providers, provider);
  const catalog = await loadCatalog(impl, which, runCommand);
  const modelId = knownModel(
    await prompter.select("Model", catalog.ids.map((item) => [item, item] as const), catalog.defaultId),
    catalog,
  );
  const options = await promptedOptions(prompter, impl, modelId, catalog, which, runCommand, {});
  const present = presentOptions(options);
  const existing = matchingModelName(config, { provider, model: modelId, options: present });
  let change: ConfigChange;
  if (existing !== null) {
    if (role === null) {
      process.stdout.write(`Model ${existing} already has this provider and model.\n`);
      return 0;
    }
    const assigned = assignRoles(config, [role], existing, { workflows });
    change = describeChange(config, assigned.config, workflows, { reusedModel: existing });
  } else {
    const key = (await prompter.text("Name")).trim();
    if (key === "") throw new ConfigEditError("Name is required.");
    const models = config.models;
    if (isRecord(models) && Object.hasOwn(models, key)) throw new ConfigEditError(`Name ${key} already exists.`);
    const created = upsertModel(config, key, { provider, model: modelId, options, workflows });
    if (role === null) change = created;
    else {
      const assigned = assignRoles(created.config, [role], key, { workflows });
      change = describeChange(config, assigned.config, workflows);
    }
  }
  validateChange(config, change.config, workflows, providers);
  return confirmAndCommit(workspace, change, prompter, asJson, which);
}

async function interactiveRoles(
  workspace: string,
  config: Record<string, unknown>,
  workflows: readonly WorkflowDocument[],
  view: ConfigView,
  providers: Record<string, Provider>,
  which: Which,
  prompter: ConfigPrompter,
  runCommand: RunCommand,
  asJson: boolean,
): Promise<number> {
  const choices = view.roles.map((role) => [roleLabel(role), role.role] as const);
  choices.push(["New role", NEW]);
  const selected = await prompter.select("Role", choices, view.roles[0]?.role ?? NEW);
  if (selected === NEW) {
    const name = (await prompter.text("Role name")).trim();
    if (name === "") throw new ConfigEditError("Role name is required.");
    if (view.roles.some((role) => role.role === name)) throw new ConfigEditError(`Role ${name} already exists.`);
    return pointRole(workspace, config, workflows, view, name, providers, which, prompter, runCommand, asJson);
  }
  return pointRole(workspace, config, workflows, view, selected, providers, which, prompter, runCommand, asJson);
}

async function pointRole(
  workspace: string,
  config: Record<string, unknown>,
  workflows: readonly WorkflowDocument[],
  view: ConfigView,
  role: string,
  providers: Record<string, Provider>,
  which: Which,
  prompter: ConfigPrompter,
  runCommand: RunCommand,
  asJson: boolean,
): Promise<number> {
  const current = view.roles.find((item) => item.role === role) ?? null;
  const choices = view.models.map((model) => [modelLabel(model), model.key] as const);
  choices.push(["New model", NEW]);
  const selected = await prompter.select("Model", choices, current?.modelName ?? NEW);
  if (selected === NEW) {
    return addModel(workspace, config, workflows, role, providers, which, prompter, runCommand, asJson);
  }
  const change = assignRoles(config, [role], selected, { workflows });
  validateChange(config, change.config, workflows, providers);
  return confirmAndCommit(workspace, change, prompter, asJson, which);
}

async function confirmAndCommit(
  workspace: string,
  change: ConfigChange,
  prompter: ConfigPrompter,
  asJson: boolean,
  which: Which,
): Promise<number> {
  printChange(change);
  if (!(await prompter.confirm("Save this change?"))) {
    process.stdout.write("Left unchanged.\n");
    return 0;
  }
  return commit(workspace, change, { asJson, which, echo: false });
}

async function commit(
  workspace: string,
  change: ConfigChange,
  args: { asJson: boolean; which: Which; echo?: boolean },
): Promise<number> {
  // Edits patch config.yaml only, so config.local.yaml values never reach the committed file.
  const filePath = configPath(workspace);
  const original = readFileSync(filePath, "utf8");
  const updated = patchConfigText(original, change.config);
  if (updated === original) {
    if (args.asJson) process.stdout.write(`${JSON.stringify(changePayload(change, false, null))}\n`);
    else process.stdout.write("Left unchanged.\n");
    return 0;
  }
  writeFileSync(filePath, updated, "utf8");
  if (args.asJson) {
    const checks = diagnose(workspace, { providers: providerMap(), which: args.which });
    const doctor = doctorPayload(checks);
    process.stdout.write(`${JSON.stringify(changePayload(change, true, doctor))}\n`);
    return doctor.ok ? 0 : 1;
  }
  if (args.echo !== false) printChange(change);
  return runDoctor(workspace, { which: args.which });
}

function validateChange(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  workflows: readonly WorkflowDocument[],
  providers: Record<string, Provider>,
): void {
  const beforeModels = isRecord(before.models) ? before.models : {};
  const afterModels = isRecord(after.models) ? after.models : {};
  const changed = new Set<string>();
  for (const key of Object.keys(afterModels)) {
    if (!Object.hasOwn(beforeModels, key) || !sameTarget(safeTarget(before, key), safeTarget(after, key))) {
      changed.add(key);
    }
  }
  for (const key of changed) {
    const target = loadModelTarget(after, key);
    requireProvider(providers, target.provider).validateOptions(target.options);
  }
  const beforeRoles = isRecord(before.roles) ? before.roles : {};
  const afterRoles = isRecord(after.roles) ? after.roles : {};
  for (const [name, body] of Object.entries(afterRoles)) {
    const usesChanged = isRecord(body) && typeof body.default_model === "string" && changed.has(body.default_model);
    if (deepEqual(beforeRoles[name], body) && !usesChanged) continue;
    if (!isRecord(body) || typeof body.default_model !== "string") continue;
    const target = loadModelTarget(after, body.default_model);
    const options = { ...target.options };
    if (isRecord(body.options)) {
      for (const [optionName, value] of Object.entries(body.options)) {
        if (typeof value === "string" && value.trim() !== "") options[optionName] = value.trim();
      }
    }
    requireProvider(providers, target.provider).validateOptions(options);
  }
  for (const document of workflows) {
    for (const stage of Object.values(document.stages)) {
      if (!isRoleStage(stage)) continue;
      let beforeTarget: StageTarget;
      let afterTarget: StageTarget;
      try {
        beforeTarget = resolveStageSpec(before, stage);
        afterTarget = resolveStageSpec(after, stage);
      } catch (error) {
        if (error instanceof ConfigurationError) continue;
        throw error;
      }
      if (sameTarget(beforeTarget, afterTarget)) continue;
      requireProvider(providers, afterTarget.provider).validateOptions(afterTarget.options);
    }
  }
}

async function catalogModel(
  providers: Record<string, Provider>,
  which: Which,
  runCommand: RunCommand,
  provider: string,
  model: string,
): Promise<[string, string, ModelCatalog]> {
  const impl = requireProvider(providers, provider);
  const catalog = await loadCatalog(impl, which, runCommand);
  return [provider, knownModel(model, catalog), catalog];
}

async function checkedOptions(
  providers: Record<string, Provider>,
  which: Which,
  runCommand: RunCommand,
  provider: string,
  model: string,
  updates: Record<string, string | null>,
  catalog: ModelCatalog | null = null,
): Promise<Record<string, string | null>> {
  const impl = requireProvider(providers, provider);
  const resolved = catalog ?? (await loadCatalog(impl, which, runCommand));
  const present: Record<string, string> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value !== null) present[key] = value;
  }
  if (Object.keys(present).length > 0) {
    await acceptedOptions(impl, model, resolved, which, runCommand, present);
  }
  return { ...updates };
}

async function promptedOptions(
  prompter: ConfigPrompter,
  provider: Provider,
  model: string,
  catalog: ModelCatalog,
  which: Which,
  runCommand: RunCommand,
  current: Readonly<Record<string, string>>,
): Promise<Record<string, string | null>> {
  const stored: Record<string, string | null> = {};
  const catalogProvider = asCatalog(provider);
  for (const spec of catalogProvider.providerOptions()) {
    if (!spec.prompt) continue;
    const values = await loadOptionValues(provider, spec.name, model, catalog, which, runCommand);
    if (values === null || values.length === 0) continue;
    const choices: Array<readonly [string, string]> = values.map((value) => [value, value] as const);
    if (spec.allowDefault) choices.unshift(["provider default", ""]);
    const currentValue = current[spec.name] ?? "";
    const picked = await prompter.select(spec.name, choices, values.includes(currentValue) ? currentValue : "");
    stored[spec.name] = picked || null;
  }
  return stored;
}

function optionUpdatesOf(options: readonly string[], clearOptions: readonly string[]): OptionUpdates {
  if (options.length === 0 && clearOptions.length === 0) return UNSET;
  const parsed = parseOptions(options);
  const overlap = Object.keys(parsed).filter((name) => clearOptions.includes(name)).sort();
  if (overlap.length > 0) throw new ConfigEditError(`Pass either --option or --clear-option for ${overlap.join(", ")}.`);
  const updates: Record<string, string | null> = { ...parsed };
  for (const name of clearOptions) {
    if (name.trim() === "") throw new ConfigEditError("Option name is required.");
    updates[name.trim()] = null;
  }
  return updates;
}

async function selectProvider(
  prompter: ConfigPrompter,
  providers: Record<string, Provider>,
  which: Which,
  message: string,
  defaultValue: string | null,
): Promise<string> {
  const rows = detected(providers, which);
  if (rows.length === 0) throw new ConfigurationError("No providers are available.");
  const names = new Set(rows.map(([name]) => name));
  return prompter.select(
    message,
    rows.map(([name, found]) => [`${name}  ${found ?? "not found"}`, name] as const),
    defaultValue !== null && names.has(defaultValue) ? defaultValue : rows[0]?.[0],
  );
}

function loaded(workspace: string): [Record<string, unknown>, WorkflowDocument[], ConfigView] {
  requireCurrentSchema(workspace);
  // Base file only: this snapshot feeds validation and patching of config.yaml.
  const config = loadYamlMapping(configPath(workspace));
  const workflows = Object.values(loadWorkflowCatalog(workspace).documents);
  return [config, workflows, inspectConfig(config, workflows)];
}

function modelProvider(config: Record<string, unknown>, key: string): string {
  return loadModelTarget(config, key).provider;
}

function roleModel(config: Record<string, unknown>, role: string): StageTarget {
  const roles = config.roles;
  if (!isRecord(roles) || !isRecord(roles[role])) throw new ConfigEditError(`Unknown role: ${role}.`);
  const modelName = roles[role].default_model;
  if (typeof modelName !== "string") throw new ConfigurationError(`Missing or invalid roles.${role}.default_model.`);
  return loadModelTarget(config, modelName);
}

function selectedModels(view: ConfigView, keys: readonly string[]): ModelView[] {
  const byKey = new Map(view.models.map((model) => [model.key, model]));
  return keys.map((key) => {
    const found = byKey.get(key);
    if (found === undefined) throw new ConfigEditError(`Unknown name: ${key}.`);
    return found;
  });
}

function selectedRoles(view: ConfigView, names: readonly string[]): RoleView[] {
  return names.map((name) => knownRole(view, name));
}

function knownRole(view: ConfigView, name: string): RoleView {
  const found = view.roles.find((role) => role.role === name);
  if (found === undefined) throw new ConfigEditError(`Unknown role: ${name}.`);
  return found;
}

function emitView(view: ConfigView, asJson: boolean, models: boolean, roles: boolean): void {
  if (asJson) {
    const payload: Record<string, unknown> = {};
    if (models) payload.models = view.models.map(modelJson);
    if (roles) payload.roles = view.roles.map(roleJson);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (models) emitModels(view.models, false);
  if (roles) emitRoles(view.roles, false);
}

function emitModels(models: readonly ModelView[], asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ models: models.map(modelJson) })}\n`);
    return;
  }
  process.stdout.write("Models\n");
  if (models.length === 0) {
    process.stdout.write("  none\n");
    return;
  }
  for (const model of models) process.stdout.write(`  ${modelLabel(model)}\n`);
}

function emitRoles(roles: readonly RoleView[], asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ roles: roles.map(roleJson) })}\n`);
    return;
  }
  process.stdout.write("Roles\n");
  if (roles.length === 0) {
    process.stdout.write("  none\n");
    return;
  }
  for (const role of roles) process.stdout.write(`  ${roleLabel(role)}\n`);
}

function modelLabel(model: ModelView): string {
  return `${model.key} - ${model.model}`;
}

function roleLabel(role: RoleView): string {
  return `${role.role} - ${role.model}`;
}

function modelJson(model: ModelView): Record<string, unknown> {
  return {
    key: model.key,
    provider: model.provider,
    model: model.model,
    options: { ...model.options },
    roles: [...model.roles],
    stages: model.stages.map((stage) => ({ workflow: stage.workflow, stage: stage.stage })),
  };
}

function roleJson(role: RoleView): Record<string, unknown> {
  return {
    role: role.role,
    model_name: role.modelName,
    provider: role.provider,
    model: role.model,
    options: { ...role.options },
    instructions: [...role.instructions],
    shared_with: [...role.sharedWith],
    stages: role.stages.map((stage) => ({
      workflow: stage.workflow,
      stage: stage.stage,
      model_name: stage.modelName,
      options: { ...stage.options },
    })),
  };
}

function printChange(change: ConfigChange): void {
  if (change.createdModel) process.stdout.write(`Created model ${change.createdModel}.\n`);
  if (change.reusedModel) process.stdout.write(`Reused model ${change.reusedModel}.\n`);
  if (change.updatedModel) process.stdout.write(`Updated model ${change.updatedModel}.\n`);
  if (change.roles.length > 0) process.stdout.write(`Roles: ${change.roles.join(", ")}\n`);
  if (change.stagesUpdated.length > 0) {
    process.stdout.write(`Stages: ${change.stagesUpdated.map(([workflow, stage]) => `${workflow}.${stage}`).join(", ")}\n`);
  }
  for (const stage of change.stagesUnchanged) {
    process.stdout.write(`Unchanged: ${stage.workflow}.${stage.stage} (${stage.ignores.join(", ")})\n`);
  }
  if (change.orphanedModels.length > 0) process.stdout.write(`Orphaned models: ${change.orphanedModels.join(", ")}\n`);
}

function changePayload(
  change: ConfigChange,
  wrote: boolean,
  doctor: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    wrote,
    created_model: change.createdModel,
    reused_model: change.reusedModel,
    updated_model: change.updatedModel,
    roles: [...change.roles],
    stages_updated: change.stagesUpdated.map(([workflow, stage]) => ({ workflow, stage })),
    stages_unchanged: change.stagesUnchanged.map((stage) => ({
      workflow: stage.workflow,
      stage: stage.stage,
      ignores: [...stage.ignores],
    })),
    orphaned_models: [...change.orphanedModels],
    doctor,
  };
}

function doctorPayload(checks: readonly { name: string; ok: boolean; items: readonly string[]; problems: readonly string[] }[]): {
  ok: boolean;
  checks: Array<Record<string, unknown>>;
} {
  return {
    ok: checks.every((check) => check.ok),
    checks: checks.map((check) => ({
      name: check.name,
      ok: check.ok,
      items: [...check.items],
      problems: [...check.problems],
    })),
  };
}

function presentOptions(options: Record<string, string | null>): Record<string, string> {
  const present: Record<string, string> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== null) present[key] = value;
  }
  return present;
}

function safeTarget(config: Record<string, unknown>, key: string): StageTarget | null {
  try {
    return loadModelTarget(config, key);
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

function sameTarget(left: StageTarget | null, right: StageTarget | null): boolean {
  if (left === null || right === null) return left === right;
  return left.provider === right.provider && left.model === right.model && deepEqual(left.options, right.options);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => deepEqual(left[key], right[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ClackConfigPrompter implements ConfigPrompter {
  async select(
    message: string,
    choices: ReadonlyArray<readonly [string, string]>,
    defaultValue?: string | null,
  ): Promise<string> {
    if (choices.length === 0) throw new ConfigurationError("Choose a value.");
    const values = new Set(choices.map(([, value]) => value));
    const initial = defaultValue != null && values.has(defaultValue) ? defaultValue : choices[0]?.[1];
    const result = await clackSelect({
      message,
      options: choices.map(([label, value]) => ({ label, value })),
      initialValue: initial,
    });
    if (isCancel(result)) throw new PromptCancelled();
    if (typeof result !== "string" || !values.has(result)) throw new ConfigurationError("Choose a value.");
    return result;
  }

  async confirm(message: string): Promise<boolean> {
    const result = await clackConfirm({ message, initialValue: true });
    if (isCancel(result)) throw new PromptCancelled();
    if (typeof result !== "boolean") throw new ConfigurationError("Answer yes or no.");
    return result;
  }

  async text(message: string, defaultValue = ""): Promise<string> {
    const result = await clackText({ message, initialValue: defaultValue });
    if (isCancel(result)) throw new PromptCancelled();
    if (typeof result !== "string") throw new ConfigurationError("Enter a value.");
    return result;
  }
}
