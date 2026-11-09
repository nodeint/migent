import type { ClientInfo, ClientRegistry } from "./cli-client.js";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import {
  mapping,
  readClient,
  requiredString,
  roleDescription,
  stringItems,
  type Field,
  type StructuralIndex,
} from "./config-structure.js";
import { ConfigurationError } from "./errors.js";
import { isRecord } from "@nodeint/migent-workflow";
import { isRoleStage, loadNamedWorkflow, type RoleStageSpec, type StageAgent } from "@nodeint/migent-workflow";
import { parseYamlDocument } from "@nodeint/migent-workflow";

export { documentVersion } from "@nodeint/migent-workflow";

export interface StageTarget {
  /** CLI client id, resolved through the registry. Always present on an effective agent. */
  client: string;
  model: string;
  options: Record<string, string>;
}

export interface ModelOverride {
  client?: string | null;
  model?: string | null;
  options?: Record<string, string> | null;
}

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
  return parsed;
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
 * A role's `agent` that the local layer declares replaces the project's wholesale, even when
 * both are mappings. Any other non-mapping value replaces. Neither input is mutated.
 */
export function mergeConfigLayers(
  project: Record<string, unknown>,
  local?: Record<string, unknown> | null,
): MergedConfig {
  if (local == null) return { config: project, ownerOf: () => "project" };
  const { schema_version: _ignored, ...layer } = local;
  const merged = mergeConfig(project, layer);
  // A role agent is a complete selection, including when both values are objects.
  if (isRecord(layer.roles) && isRecord(merged.roles)) {
    for (const [name, role] of Object.entries(layer.roles)) {
      const target = merged.roles[name];
      if (isRecord(role) && isRecord(target) && Object.hasOwn(role, "agent")) {
        target.agent = role.agent;
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
      const wholesale = index === 2 && path[0] === "roles" && key === "agent";
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

export interface AgentDefinitionEntry {
  /** The name of an `agents` entry, or the field path for an inline `roles.*.agent`. */
  key: string;
  value: unknown;
  /** Dotted field path, used as the label in messages. */
  field: string;
  path: readonly string[];
}

/**
 * Every agent definition of an effective config: the `agents` entries sorted by name, then each
 * role's inline `agent` mapping. A malformed `agents` or `roles` yields no entries.
 */
export function listAgentDefinitions(config: Record<string, unknown>): AgentDefinitionEntry[] {
  const entries: AgentDefinitionEntry[] = [];
  if (isRecord(config.agents)) {
    for (const name of Object.keys(config.agents).sort()) {
      entries.push({ key: name, value: config.agents[name], field: `agents.${name}`, path: ["agents", name] });
    }
  }
  if (isRecord(config.roles)) {
    for (const [name, role] of Object.entries(config.roles)) {
      if (!isRecord(role) || !isRecord(role.agent)) continue;
      const field = `roles.${name}.agent`;
      entries.push({ key: field, value: role.agent, field, path: ["roles", name, "agent"] });
    }
  }
  return entries;
}

export interface EffectiveClientFailure {
  code: "client-required" | "client-unsupported" | "options-invalid";
  /** Text that follows the field label, e.g. `is not supported: x`. For options it is the bare reason. */
  message: string;
  /** Which part of the target failed, relative to its field. */
  part: "client" | "options";
}

/**
 * Binds a target to its CLI client and validates its options against that client.
 * Uses client metadata only: no process is spawned and PATH is not consulted. A failure other than
 * `options-invalid` leaves `client` unset.
 */
export function resolveEffectiveClient(
  registry: ClientRegistry,
  target: StageTarget,
): { client?: ClientInfo; failure?: EffectiveClientFailure } {
  if (target.client.trim() === "") {
    return {
      failure: { code: "client-required", part: "client", message: "is required: the agent names no client.type." },
    };
  }
  let client: ClientInfo;
  try {
    client = registry.get(target.client);
  } catch (error) {
    return {
      failure: {
        code: "client-unsupported",
        part: "client",
        message: `is not supported: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  try {
    client.validateOptions(target.options);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // The client is still bound, so callers can report its executable next to the options problem.
    return { client, failure: { code: "options-invalid", part: "options", message: error.message } };
  }
  return { client };
}

export function stringifyConfig(config: Record<string, unknown>): string {
  return stringify(config, { lineWidth: 0 });
}

export function resolveStageTarget(
  workspace: string,
  workflowId: string,
  stageId: string,
  override?: ModelOverride,
  registry?: ClientRegistry,
): StageTarget {
  const { client, model, options } = normalizeOverride(override);
  if ((client === null) !== (model === null)) {
    throw new ConfigurationError(
      "Pass both --client and --model to override the resolved stage model, or omit both.",
    );
  }
  if (client !== null && model !== null) {
    return stageTarget(client, model, { ...(options ?? {}) });
  }
  const workflow = loadNamedWorkflow(workspace, workflowId);
  const stage = workflow.stages[stageId];
  if (stage === undefined) throw new ConfigurationError(`Stage not found: ${stageId}`);
  if (!isRoleStage(stage)) throw new ConfigurationError(`Stage ${stageId} has no role.`);
  const config = loadWorkspaceConfig(workspace);
  return resolveStageSpec(config, stage, options, registry);
}

export function resolveStageSpec(
  config: Record<string, unknown>,
  stage: RoleStageSpec,
  options?: Record<string, string> | null,
  registry?: ClientRegistry,
): StageTarget {
  const agentField =
    stage.agent !== null ? field("stages", stage.id, "agent") : field("roles", stage.role, "agent");
  const declared = resolveRoleCascade(config, stage.role, {
    agent: stage.agent,
    agentField,
    options: stage.options,
  }, registry);
  return stageTarget(declared.client, declared.model, mergeOptions(declared.options, options));
}

export function resolveRoleTarget(
  workspace: string,
  role: string,
  override?: ModelOverride,
  registry?: ClientRegistry,
): StageTarget {
  const { client, model, options } = normalizeOverride(override);
  if ((client === null) !== (model === null)) {
    throw new ConfigurationError(
      "Pass both --client and --model to override the resolved model, or omit both.",
    );
  }
  const config = loadWorkspaceConfig(workspace);
  if (client !== null && model !== null) {
    const roles = mapping(config.roles, field("roles"));
    validateRoleKeys(mapping(roles[role], field("roles", role)), role);
    return stageTarget(client, model, { ...(options ?? {}) });
  }
  return resolveRoleCascade(config, role, { options }, registry);
}

export function loadAgentTarget(
  config: Record<string, unknown>,
  agentName: string,
  registry?: ClientRegistry,
  index?: StructuralIndex,
): StageTarget {
  rejectLegacyConfigKeys(config);
  const agents = mapping(config.agents, field("agents"), index);
  const label = field("agents", agentName);
  return loadAgentDefinition(mapping(agents[agentName], label, index), label, registry, index);
}

/**
 * Named and inline agents share exactly the same validation and option handling. `where` is a
 * dotted label, or a label with its literal key path when a key may itself contain dots.
 */
export function loadAgentDefinition(
  value: unknown,
  where: string | Field,
  registry?: ClientRegistry,
  index?: StructuralIndex,
): StageTarget {
  const here = toField(where);
  const label = here.label;
  const agentConfig = mapping(value, here, index);
  if (Object.hasOwn(agentConfig, "options")) {
    throw new ConfigurationError(
      `${label}.options moved to ${label}.client.options. Run \`migent migrate\`.`,
      { code: "agent-options-moved", path: [...here.path, "options"] },
    );
  }
  if (Object.hasOwn(agentConfig, "provider")) {
    throw new ConfigurationError(
      `${label}.provider was removed in schema_version 6; set ${label}.client.type. Run \`migent migrate\`.`,
      { code: "legacy-key", path: [...here.path, "provider"] },
    );
  }
  const clientField = child(here, "client");
  let client: string | undefined;
  let options: Record<string, string> = {};
  let optionsSet = false;
  if (agentConfig.client != null) {
    ({ type: client, options, optionsSet } = readClient(agentConfig.client, clientField, index));
  }
  const model = requiredString(agentConfig.model, child(here, "model"), index);
  if (client === undefined) {
    const typeField = child(clientField, "type");
    if (optionsSet) {
      throw new ConfigurationError(
        `${typeField.label} is required when ${clientField.label}.options is set: native options belong to one client.`,
        { code: "client-required", path: typeField.path },
      );
    }
    client = inferClient(registry, model, typeField);
  }
  if (Object.hasOwn(agentConfig, "effort")) {
    const effortField = child(here, "effort");
    const effort = requiredString(agentConfig.effort, effortField, index);
    const details = { code: "effort-unsupported", path: effortField.path };
    if (registry === undefined) {
      throw new ConfigurationError(`${label}.effort requires a client registry.`, details);
    }
    let option: string | undefined;
    try {
      option = registry.get(client).effortOption;
    } catch (error) {
      throw new ConfigurationError(`${label}.effort: ${error instanceof Error ? error.message : String(error)}`, details);
    }
    if (option === undefined) {
      throw new ConfigurationError(`${label}.effort is not supported by the selected CLI client.`, details);
    }
    if (Object.hasOwn(options, option)) {
      throw new ConfigurationError(
        `${label}.effort conflicts with ${label}.client.options.${option}; keep only one.`,
        { code: "effort-conflict", path: effortField.path },
      );
    }
    options[option] = effort;
  }
  return stageTarget(client, model, options);
}

/** Picks the one client that lists `model`. Runs only when an agent omits `client.type`. */
function inferClient(registry: ClientRegistry | undefined, model: string, typeField: Field): string {
  const details = (code: string) => ({ code, path: typeField.path });
  if (registry?.clientsForModel === undefined) {
    throw new ConfigurationError(
      `Missing ${typeField.label}. Set the agent's CLI client (for example, ${typeField.label}: opencode).`,
      details("client-required"),
    );
  }
  const lookup = registry.clientsForModel(model);
  if (lookup.matches.length === 1) return lookup.matches[0]!;
  if (lookup.matches.length > 1) {
    throw new ConfigurationError(
      `Model ${model} is listed by several clients (${lookup.matches.join(", ")}); set ${typeField.label}.`,
      details("client-ambiguous"),
    );
  }
  const parts = [`searched: ${lookup.searched.join(", ") || "none"}`];
  if (lookup.skipped.length > 0) parts.push(`not on PATH: ${lookup.skipped.join(", ")}`);
  if (lookup.failed.length > 0) {
    parts.push(`failed: ${lookup.failed.map((entry) => `${entry.client} (${entry.reason})`).join("; ")}`);
  }
  throw new ConfigurationError(
    `No client lists model ${model} (${parts.join("; ")}); set ${typeField.label}.`,
    details("client-not-found"),
  );
}

export function resolveRoleCascade(
  config: Record<string, unknown>,
  roleKey: string,
  args?: {
    agent?: StageAgent | null;
    agentField?: string | Field | null;
    options?: Record<string, string> | null;
  },
  registry?: ClientRegistry,
  index?: StructuralIndex,
): StageTarget {
  rejectLegacyConfigKeys(config);
  const roles = mapping(config.roles, field("roles"), index);
  const role = mapping(roles[roleKey], field("roles", roleKey), index);
  validateRoleKeys(role, roleKey);
  const agentField = args?.agentField == null ? field("roles", roleKey, "agent") : toField(args.agentField);
  const stageAgent = args?.agent ?? null;
  const selection: unknown =
    stageAgent === null ? role.agent : stageAgent.kind === "named" ? stageAgent.name : stageAgent.value;
  let target: StageTarget;
  if (isRecord(selection)) {
    target = loadAgentDefinition(selection, agentField, registry, index);
  } else {
    const name = requiredString(selection, agentField, index);
    if (!isRecord(config.agents) || !Object.hasOwn(config.agents, name)) {
      throw new ConfigurationError(`${agentField.label}: unknown agent "${name}" in agents.`, {
        code: "unknown-agent",
        path: agentField.path,
      });
    }
    target = loadAgentTarget(config, name, registry, index);
  }
  return stageTarget(
    target.client,
    target.model,
    mergeOptions(target.options, args?.options),
  );
}

/** A v4 top-level key in a current document names its v5 replacement. */
export function rejectLegacyConfigKeys(config: Record<string, unknown>): void {
  if (Object.hasOwn(config, "models")) {
    throw new ConfigurationError("models was renamed to agents in schema_version 5. Run `migent migrate`.", {
      code: "legacy-key",
      path: ["models"],
    });
  }
}

/** Keys a role no longer accepts, each with the v5 key that replaces it. */
export function validateRoleKeys(role: Record<string, unknown>, roleKey: string): void {
  if (Object.hasOwn(role, "options")) {
    throw new ConfigurationError(
      `roles.${roleKey}.options is no longer supported. Move options into roles.${roleKey}.agent (inline agent) or the referenced agents entry, under client.options.`,
      { code: "role-options-unsupported", path: ["roles", roleKey, "options"] },
    );
  }
  for (const [old, replacement] of [["default_model", "agent"], ["instructions", "responsibilities"]] as const) {
    if (Object.hasOwn(role, old)) {
      throw new ConfigurationError(
        `roles.${roleKey}.${old} was renamed to roles.${roleKey}.${replacement} in schema_version 5. Run \`migent migrate\`.`,
        { code: "legacy-key", path: ["roles", roleKey, old] },
      );
    }
  }
}

/** Absent or null responsibilities are an empty list. A non-list is a configuration error. */
export function loadRoleResponsibilities(
  config: Record<string, unknown>,
  roleKey: string,
  index?: StructuralIndex,
): string[] {
  const roles = mapping(config.roles, field("roles"), index);
  const role = mapping(roles[roleKey], field("roles", roleKey), index);
  validateRoleKeys(role, roleKey);
  return stringItems(role.responsibilities, field("roles", roleKey, "responsibilities"), index);
}

/** The optional one-line description of a role, or null. */
export function loadRoleDescription(
  config: Record<string, unknown>,
  roleKey: string,
  index?: StructuralIndex,
): string | null {
  const roles = mapping(config.roles, field("roles"), index);
  const role = mapping(roles[roleKey], field("roles", roleKey), index);
  if (role.description == null) return null;
  const description = roleDescription(role.description, field("roles", roleKey, "description"), index);
  if (/[\r\n]/.test(description)) {
    throw new ConfigurationError(`roles.${roleKey}.description must be one line.`, {
      code: "not-one-line",
      path: ["roles", roleKey, "description"],
    });
  }
  return description;
}

export type { Field, StructuralIndex } from "./config-structure.js";

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
  client: string,
  model: string,
  options: Record<string, string>,
): StageTarget {
  return { client, model, options };
}

function normalizeOverride(override?: ModelOverride): {
  client: string | null;
  model: string | null;
  options: Record<string, string> | null;
} {
  return {
    client: override?.client ?? null,
    model: override?.model ?? null,
    options: override?.options ?? null,
  };
}
