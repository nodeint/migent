import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigurationError } from "./errors.js";
import { isRecord } from "./record.js";
import { loadNamedWorkflow, readOptionMap, type StageSpec } from "./workflow.js";
import { parseYamlDocument } from "./yaml.js";

export { documentVersion } from "./record.js";

export interface StageTarget {
  provider: string;
  model: string;
  options: Record<string, string>;
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
  const config = loadYamlMapping(path.join(workspace, ".migent", "config.yaml"));
  return resolveStageSpec(config, stage, options);
}

export function resolveStageSpec(
  config: Record<string, unknown>,
  stage: StageSpec,
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
  return stageTarget(declared.provider, declared.model, mergeOptions(declared.options, options));
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
  const config = loadYamlMapping(path.join(workspace, ".migent", "config.yaml"));
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
  return stageTarget(target.provider, target.model, mergeOptions(target.options, roleOptions, args?.options));
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

function stageTarget(provider: string, model: string, options: Record<string, string>): StageTarget {
  return stageTargetSchema.parse({ provider, model, options });
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
