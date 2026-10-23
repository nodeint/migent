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

export function loadYamlMapping(filePath: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`Unable to read configuration: ${filePath} (${reason})`);
  }
  const parsed = parseYamlDocument(text);
  if (!isRecord(parsed)) {
    throw new ConfigurationError("Invalid configuration: expected a mapping.");
  }
  const mapping = mappingSchema.safeParse(parsed);
  if (!mapping.success) throw new ConfigurationError("Invalid configuration: expected a mapping.");
  return mapping.data;
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

/**
 * `config.yaml` with `config.local.yaml` merged over it when that file exists.
 * `schema_version` always comes from `config.yaml`.
 */
export function loadWorkspaceConfig(workspace: string): Record<string, unknown> {
  const base = loadYamlMapping(configPath(workspace));
  if (!hasLocalConfig(workspace)) return base;
  let loaded: Record<string, unknown>;
  try {
    loaded = loadYamlMapping(localConfigPath(workspace));
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    throw new ConfigurationError(`${error.message} (${localConfigPath(workspace)})`);
  }
  const { schema_version: _ignored, ...local } = loaded;
  return mergeConfig(base, local);
}

export function stringifyConfig(config: Record<string, unknown>): string {
  return stringify(config, { lineWidth: 0 });
}

export function resolveStageTarget(
  workspace: string,
  workflowId: string,
  stageId: string,
  override?: ModelOverride,
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
  return resolveStageSpec(config, stage, options);
}

export function resolveStageSpec(
  config: Record<string, unknown>,
  stage: RoleStageSpec,
  options?: Record<string, string> | null,
): StageTarget {
  const modelField =
    stage.modelName !== null
      ? `stages.${stage.id}.model`
      : `roles.${stage.role}.default_model`;
  const declared = resolveRoleCascade(config, stage.role, {
    modelName: stage.modelName,
    modelField,
    options: stage.options,
  });
  return stageTarget(declared.provider, declared.model, mergeOptions(declared.options, options), declared.client);
}

export function resolveRoleTarget(
  workspace: string,
  role: string,
  override?: ModelOverride,
): StageTarget {
  const { provider, model, options } = normalizeOverride(override);
  if ((provider === null) !== (model === null)) {
    throw new ConfigurationError(
      "Pass both --provider and --model to override the resolved model, or omit both.",
    );
  }
  const config = loadWorkspaceConfig(workspace);
  if (provider !== null && model !== null) {
    const roles = mapping(config.roles, "roles");
    mapping(roles[role], `roles.${role}`);
    return stageTarget(provider, model, { ...(options ?? {}) });
  }
  return resolveRoleCascade(config, role, { options });
}

export function loadModelTarget(config: Record<string, unknown>, modelName: string): StageTarget {
  const models = mapping(config.models, "models");
  const modelConfig = mapping(models[modelName], `models.${modelName}`);
  return stageTarget(
    requiredString(modelConfig.provider, `models.${modelName}.provider`),
    requiredString(modelConfig.model, `models.${modelName}.model`),
    readOptions(modelConfig.options, `models.${modelName}.options`),
    optionalString(modelConfig.client, `models.${modelName}.client`),
  );
}

function resolveRoleCascade(
  config: Record<string, unknown>,
  roleKey: string,
  args?: {
    modelName?: string | null;
    modelField?: string | null;
    options?: Record<string, string> | null;
  },
): StageTarget {
  const roles = mapping(config.roles, "roles");
  const role = mapping(roles[roleKey], `roles.${roleKey}`);
  const modelField = args?.modelField ?? `roles.${roleKey}.default_model`;
  const named = args?.modelName ?? null;
  const resolvedName = requiredString(named === null || named === "" ? role.default_model : named, modelField);
  const target = loadModelTarget(config, resolvedName);
  const roleOptions = readOptions(role.options, `roles.${roleKey}.options`);
  return stageTarget(
    target.provider,
    target.model,
    mergeOptions(target.options, roleOptions, args?.options),
    target.client,
  );
}

/** Absent or null instructions are an empty list. A non-list is a configuration error. */
export function loadRoleInstructions(config: Record<string, unknown>, roleKey: string): string[] {
  const roles = mapping(config.roles, "roles");
  const role = mapping(roles[roleKey], `roles.${roleKey}`);
  return stringItems(role.instructions, `roles.${roleKey}.instructions`);
}

function mapping(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ConfigurationError(`Missing or invalid ${field}.`);
  const parsed = mappingSchema.safeParse(value);
  if (!parsed.success) throw new ConfigurationError(`Missing or invalid ${field}.`);
  return parsed.data;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigurationError(`Missing or invalid ${field}.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  return value == null ? undefined : requiredString(value, field);
}

function stringItems(raw: unknown, field: string): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ConfigurationError(`${field} must be a list.`);
  return raw.map((item, index) => requiredString(item, `${field}[${index}]`));
}

function readOptions(value: unknown, field: string): Record<string, string> {
  if (value == null) return {};
  return readOptionMap(mapping(value, field), field);
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
