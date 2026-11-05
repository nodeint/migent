import type { ProviderInfo, ProviderResolver } from "./provider-contract.js";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { ConfigurationError } from "./errors.js";
import { isRecord } from "./record.js";
import { isRoleStage, loadNamedWorkflow, readOptionMap, type RoleStageSpec } from "./workflow.js";
import { parseYamlDocument } from "./yaml.js";

export { documentVersion } from "./record.js";

export interface StageTarget {
  provider: string;
  model: string;
  options: Record<string, string>;
  /** CLI client id the provider should drive this model with. Absent means the provider's own. */
  client?: string;
}

export interface ModelOverride {
  provider?: string | null;
  model?: string | null;
  options?: Record<string, string> | null;
}

const stageTargetSchema = z.object({
  provider: z.string(),
  model: z.string(),
  options: z.record(z.string(), z.string()),
  client: z.string().optional(),
});

const mappingSchema = z.record(z.string(), z.unknown());

export type ConfigLayer = "project" | "local";

export function loadYamlMapping(filePath: string, layer?: ConfigLayer): Record<string, unknown> {
  const withLayer = layer === undefined ? {} : { layer };
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`Unable to read configuration: ${filePath} (${reason})`, {
      code: "config-unreadable",
      ...withLayer,
    });
  }
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(text);
  } catch (error) {
    if (error instanceof ConfigurationError && layer !== undefined) {
      throw new ConfigurationError(error.message, {
        ...(error.code === undefined ? {} : { code: error.code }),
        ...(error.position === undefined ? {} : { position: error.position }),
        layer,
      });
    }
    throw error;
  }
  if (!isRecord(parsed)) {
    throw new ConfigurationError("Invalid configuration: expected a mapping.", { code: "config-not-mapping", ...withLayer });
  }
  const mapping = mappingSchema.safeParse(parsed);
  if (!mapping.success) {
    throw new ConfigurationError("Invalid configuration: expected a mapping.", { code: "config-not-mapping", ...withLayer });
  }
  return mapping.data;
}

/** Reads one config layer (a single file) into a mapping. Errors name the layer. */
export function readConfigLayer(filePath: string, layer: ConfigLayer): Record<string, unknown> {
  return loadYamlMapping(filePath, layer);
}

export const LOCAL_CONFIG_FILE = "config.local.yaml";

export function configPath(workspace: string): string {
  return path.join(workspace, ".migent", "config.yaml");
}

export function localConfigPath(workspace: string): string {
  return path.join(workspace, ".migent", LOCAL_CONFIG_FILE);
}

export function hasLocalConfig(workspace: string): boolean {
  try {
    return statSync(localConfigPath(workspace)).isFile();
  } catch {
    return false;
  }
}

/**
 * Plain mappings merge recursively. Any other local value, lists included, replaces
 * the base value. Neither input is mutated.
 */
export function mergeConfig(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(local)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? mergeConfig(current, value) : value;
  }
  return merged;
}

/** Who supplies the value at a path of the effective config. */
export type ConfigOwner = "project" | "local" | "merged";

export interface MergedConfig {
  config: Record<string, unknown>;
  /**
   * The layer that supplies the node at `path`, derived from the boundaries of the merge itself:
   * a value one layer replaces belongs to that layer with its whole subtree. Mappings both layers
   * define are `merged`, and so is a field missing directly under such a mapping.
   */
  ownerOf(path: readonly (string | number)[]): ConfigOwner;
}

/**
 * The one definition of how layers combine. `schema_version` always comes from the project layer.
 * A role's `default_model` that the local layer declares replaces the project's wholesale, even when
 * both are mappings. Any other non-mapping value replaces. Neither input is mutated.
 */
export function mergeConfigLayers(
  project: Record<string, unknown>,
  local?: Record<string, unknown> | null,
): MergedConfig {
  if (local == null) return { config: project, ownerOf: () => "project" };
  const { schema_version: _ignored, ...layer } = local;
  const merged = mergeConfig(project, layer);
  // A role default is a complete selection, including when both values are objects.
  if (isRecord(layer.roles) && isRecord(merged.roles)) {
    for (const [name, role] of Object.entries(layer.roles)) {
      const target = merged.roles[name];
      if (isRecord(role) && isRecord(target) && Object.hasOwn(role, "default_model")) {
        target.default_model = role.default_model;
      }
    }
  }
  const ownerOf = (path: readonly (string | number)[]): ConfigOwner => {
    if (path[0] === "schema_version") return "project";
    let base: unknown = project;
    let over: unknown = layer;
    for (const [index, key] of path.entries()) {
      const baseHas = isRecord(base) && Object.hasOwn(base, key);
      const overHas = isRecord(over) && Object.hasOwn(over, key);
      if (!baseHas && !overHas) return "merged";
      if (!overHas) return "project";
      if (!baseHas) return "local";
      const baseValue = (base as Record<string, unknown>)[key];
      const overValue = (over as Record<string, unknown>)[key];
      const wholesale = index === 2 && path[0] === "roles" && key === "default_model";
      if (wholesale || !isRecord(baseValue) || !isRecord(overValue)) return "local";
      base = baseValue;
      over = overValue;
    }
    return "merged";
  };
  return { config: merged, ownerOf };
}

/**
 * `config.yaml` with `config.local.yaml` merged over it when that file exists.
 * `schema_version` always comes from `config.yaml`.
 */
export function loadWorkspaceConfig(workspace: string): Record<string, unknown> {
  return loadMergedConfig(workspace).config;
}

/** Like `loadWorkspaceConfig`, with the path-ownership lookup of the merge. */
export function loadMergedConfig(workspace: string): MergedConfig {
  const base = readConfigLayer(configPath(workspace), "project");
  if (!hasLocalConfig(workspace)) return mergeConfigLayers(base, null);
  let loaded: Record<string, unknown>;
  try {
    loaded = readConfigLayer(localConfigPath(workspace), "local");
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    throw new ConfigurationError(`${error.message} (${localConfigPath(workspace)})`, {
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.position === undefined ? {} : { position: error.position }),
      layer: "local",
    });
  }
  return mergeConfigLayers(base, loaded);
}

export interface ModelDefinitionEntry {
  /** The alias for a `models` entry, or the field path for an inline `roles.*.default_model`. */
  key: string;
  value: unknown;
  /** Dotted field path, used as the label in messages. */
  field: string;
  path: readonly string[];
}

/**
 * Every model definition of an effective config: the `models` entries sorted by alias, then each
 * role's inline `default_model` mapping. A malformed `models` or `roles` yields no entries.
 */
export function listModelDefinitions(config: Record<string, unknown>): ModelDefinitionEntry[] {
  const entries: ModelDefinitionEntry[] = [];
  if (isRecord(config.models)) {
    for (const alias of Object.keys(config.models).sort()) {
      entries.push({ key: alias, value: config.models[alias], field: `models.${alias}`, path: ["models", alias] });
    }
  }
  if (isRecord(config.roles)) {
    for (const [name, role] of Object.entries(config.roles)) {
      if (!isRecord(role) || !isRecord(role.default_model)) continue;
      const field = `roles.${name}.default_model`;
      entries.push({ key: field, value: role.default_model, field, path: ["roles", name, "default_model"] });
    }
  }
  return entries;
}

export interface EffectiveProviderFailure {
  code: "provider-unsupported" | "client-required" | "client-unsupported" | "options-invalid";
  /** Text that follows the field label, e.g. `is not supported: x`. For options it is the bare reason. */
  message: string;
  /** Which part of the target failed, relative to its field. */
  part: "provider" | "client" | "options";
}

/**
 * Binds a target to its provider and CLI client and validates its options against that provider.
 * Uses provider metadata only: no process is spawned and PATH is not consulted. A failure other than
 * `options-invalid` leaves `provider` unset.
 */
export function resolveEffectiveProvider(
  providers: Readonly<Record<string, ProviderInfo>>,
  target: StageTarget,
): { provider?: ProviderInfo; failure?: EffectiveProviderFailure } {
  const provider = Object.hasOwn(providers, target.provider) ? providers[target.provider] : undefined;
  if (provider === undefined) {
    return { failure: { code: "provider-unsupported", part: "provider", message: `is not supported: ${target.provider}` } };
  }
  if (provider.requiresClient === true && target.client === undefined) {
    return {
      failure: { code: "client-required", part: "client", message: `is required: ${target.provider} has no default CLI client.` },
    };
  }
  let effective = provider;
  if (target.client !== undefined) {
    try {
      if (provider.withClient === undefined) throw new Error(`${target.provider} cannot switch CLI client.`);
      effective = provider.withClient(target.client);
    } catch (error) {
      return {
        failure: {
          code: "client-unsupported",
          part: "client",
          message: `is not supported: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }
  try {
    effective.validateOptions(target.options);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // The provider is still bound, so callers can report its executable next to the options problem.
    return { provider: effective, failure: { code: "options-invalid", part: "options", message: error.message } };
  }
  return { provider: effective };
}

export function stringifyConfig(config: Record<string, unknown>): string {
  return stringify(config, { lineWidth: 0 });
}

export function resolveStageTarget(
  workspace: string,
  workflowId: string,
  stageId: string,
  override?: ModelOverride,
  resolveProvider?: ProviderResolver,
): StageTarget {
  const { provider, model, options } = normalizeOverride(override);
  if ((provider === null) !== (model === null)) {
    throw new ConfigurationError(
      "Pass both --provider and --model to override the resolved stage model, or omit both.",
    );
  }
  if (provider !== null && model !== null) {
    return stageTarget(provider, model, { ...(options ?? {}) });
  }
  const workflow = loadNamedWorkflow(workspace, workflowId);
  const stage = workflow.stages[stageId];
  if (stage === undefined) throw new ConfigurationError(`Stage not found: ${stageId}`);
  if (!isRoleStage(stage)) throw new ConfigurationError(`Stage ${stageId} has no role.`);
  const config = loadWorkspaceConfig(workspace);
  return resolveStageSpec(config, stage, options, resolveProvider);
}

export function resolveStageSpec(
  config: Record<string, unknown>,
  stage: RoleStageSpec,
  options?: Record<string, string> | null,
  resolveProvider?: ProviderResolver,
): StageTarget {
  const modelField =
    stage.modelName !== null ? field("stages", stage.id, "model") : field("roles", stage.role, "default_model");
  const declared = resolveRoleCascade(config, stage.role, {
    modelName: stage.modelName,
    modelField,
    options: stage.options,
  }, resolveProvider);
  return stageTarget(declared.provider, declared.model, mergeOptions(declared.options, options), declared.client);
}

export function resolveRoleTarget(
  workspace: string,
  role: string,
  override?: ModelOverride,
  resolveProvider?: ProviderResolver,
): StageTarget {
  const { provider, model, options } = normalizeOverride(override);
  if ((provider === null) !== (model === null)) {
    throw new ConfigurationError(
      "Pass both --provider and --model to override the resolved model, or omit both.",
    );
  }
  const config = loadWorkspaceConfig(workspace);
  if (provider !== null && model !== null) {
    const roles = mapping(config.roles, field("roles"));
    validateRoleOptions(mapping(roles[role], field("roles", role)), role);
    return stageTarget(provider, model, { ...(options ?? {}) });
  }
  return resolveRoleCascade(config, role, { options }, resolveProvider);
}

export function loadModelTarget(
  config: Record<string, unknown>,
  modelName: string,
  resolveProvider?: ProviderResolver,
): StageTarget {
  const models = mapping(config.models, field("models"));
  const alias = field("models", modelName);
  const modelConfig = mapping(models[modelName], alias);
  return loadModelDefinition(modelConfig, alias, resolveProvider);
}

/**
 * Named and inline models share exactly the same validation and option handling. `where` is a
 * dotted label, or a label with its literal key path when a key may itself contain dots.
 */
export function loadModelDefinition(
  value: unknown,
  where: string | Field,
  resolveProvider?: ProviderResolver,
): StageTarget {
  const here = toField(where);
  const label = here.label;
  const modelConfig = mapping(value, here);
  const provider = requiredString(modelConfig.provider, child(here, "provider"));
  const client = optionalString(modelConfig.client, child(here, "client"));
  const options = readOptions(modelConfig.options, child(here, "options"));
  if (Object.hasOwn(modelConfig, "effort")) {
    const effortField = child(here, "effort");
    const effort = requiredString(modelConfig.effort, effortField);
    const details = { code: "effort-unsupported", path: effortField.path };
    if (resolveProvider === undefined) {
      throw new ConfigurationError(`${label}.effort requires a provider resolver.`, details);
    }
    let option: string | undefined;
    try {
      option = resolveProvider(provider, client).effortOption;
    } catch (error) {
      throw new ConfigurationError(`${label}.effort: ${error instanceof Error ? error.message : String(error)}`, details);
    }
    if (option === undefined) {
      throw new ConfigurationError(`${label}.effort is not supported by the selected CLI client.`, details);
    }
    if (Object.hasOwn(options, option)) {
      throw new ConfigurationError(
        `${label}.effort conflicts with ${label}.options.${option}; keep only one.`,
        { code: "effort-conflict", path: effortField.path },
      );
    }
    options[option] = effort;
  }
  return stageTarget(provider, requiredString(modelConfig.model, child(here, "model")), options, client);
}

export function resolveRoleCascade(
  config: Record<string, unknown>,
  roleKey: string,
  args?: {
    modelName?: string | null;
    modelField?: string | Field | null;
    options?: Record<string, string> | null;
  },
  resolveProvider?: ProviderResolver,
): StageTarget {
  const roles = mapping(config.roles, field("roles"));
  const role = mapping(roles[roleKey], field("roles", roleKey));
  validateRoleOptions(role, roleKey);
  const modelField = args?.modelField == null ? field("roles", roleKey, "default_model") : toField(args.modelField);
  const named = args?.modelName ?? null;
  const selection = named === null || named === "" ? role.default_model : named;
  let target: StageTarget;
  if (isRecord(selection)) {
    target = loadModelDefinition(selection, modelField, resolveProvider);
  } else {
    const alias = requiredString(selection, modelField);
    if (!isRecord(config.models) || !Object.hasOwn(config.models, alias)) {
      throw new ConfigurationError(`${modelField.label}: unknown model alias "${alias}" in models.`, {
        code: "unknown-model-alias",
        path: modelField.path,
      });
    }
    target = loadModelTarget(config, alias, resolveProvider);
  }
  return stageTarget(
    target.provider,
    target.model,
    mergeOptions(target.options, args?.options),
    target.client,
  );
}

export function validateRoleOptions(role: Record<string, unknown>, roleKey: string): void {
  if (Object.hasOwn(role, "options")) {
    throw new ConfigurationError(
      `roles.${roleKey}.options is no longer supported. Move options into roles.${roleKey}.default_model (inline model) or the referenced models entry.`,
      { code: "role-options-unsupported", path: ["roles", roleKey, "options"] },
    );
  }
}

/** Absent or null instructions are an empty list. A non-list is a configuration error. */
export function loadRoleInstructions(config: Record<string, unknown>, roleKey: string): string[] {
  const roles = mapping(config.roles, field("roles"));
  const role = mapping(roles[roleKey], field("roles", roleKey));
  validateRoleOptions(role, roleKey);
  return stringItems(role.instructions, field("roles", roleKey, "instructions"));
}

/**
 * A config location: `label` is the dotted text shown in messages, `path` the literal key segments.
 * Keys may contain dots or brackets, so the path is never recovered by parsing the label.
 */
export interface Field {
  label: string;
  path: readonly (string | number)[];
}

/** A `Field` from literal key segments. */
export function field(...keys: string[]): Field {
  return { label: keys.join("."), path: keys };
}

function child(parent: Field, key: string): Field {
  return { label: `${parent.label}.${key}`, path: [...parent.path, key] };
}

function toField(value: string | Field): Field {
  return typeof value === "string" ? { label: value, path: value.split(".") } : value;
}

function mapping(value: unknown, where: Field): Record<string, unknown> {
  const details = { code: "missing-or-invalid", path: where.path };
  if (!isRecord(value)) throw new ConfigurationError(`Missing or invalid ${where.label}.`, details);
  const parsed = mappingSchema.safeParse(value);
  if (!parsed.success) throw new ConfigurationError(`Missing or invalid ${where.label}.`, details);
  return parsed.data;
}

function requiredString(value: unknown, where: Field): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigurationError(`Missing or invalid ${where.label}.`, { code: "missing-or-invalid", path: where.path });
  }
  return value.trim();
}

function optionalString(value: unknown, where: Field): string | undefined {
  return value == null ? undefined : requiredString(value, where);
}

function stringItems(raw: unknown, where: Field): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigurationError(`${where.label} must be a list.`, { code: "not-a-list", path: where.path });
  }
  return raw.map((item, index) =>
    requiredString(item, { label: `${where.label}[${index}]`, path: [...where.path, index] }));
}

function readOptions(value: unknown, where: Field): Record<string, string> {
  if (value == null) return {};
  return readOptionMap(mapping(value, where), where.label, where.path);
}

function mergeOptions(
  ...layers: Array<Record<string, string> | null | undefined>
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const layer of layers) {
    if (layer == null) continue;
    Object.assign(merged, layer);
  }
  return merged;
}

function stageTarget(
  provider: string,
  model: string,
  options: Record<string, string>,
  client?: string,
): StageTarget {
  return stageTargetSchema.parse(client === undefined ? { provider, model, options } : { provider, model, options, client });
}

function normalizeOverride(override?: ModelOverride): {
  provider: string | null;
  model: string | null;
  options: Record<string, string> | null;
} {
  return {
    provider: override?.provider ?? null,
    model: override?.model ?? null,
    options: override?.options ?? null,
  };
}
