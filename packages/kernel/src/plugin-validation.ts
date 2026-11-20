import {
  type ExtensionLevel, isValid, isWellFormedSchema, LlmPluginConfig, type Plugin, PluginManifest, type PluginRegistry,
  PluginSharedConfig, type PluginValidationInput as PluginValidateInput, type TSchema,
} from '@nodeint/migent-contracts';

import type { ClientRegistry } from './cli-client.js';
import { sectionIssues } from './config-structure.js';
import { ConfigurationError } from './errors.js';

/** The manifest facts validation needs. A caller passes registry data, so kernel never imports plugins. */
export type PluginManifestData = Pick<PluginManifest, 'id' | 'uses' | 'configSchema'> & Partial<PluginManifest>;

export interface PluginValidationInput {
  /** The merged `plugins` section, as read from config. Any value. */
  readonly plugins: unknown;
  /** Manifest data of every registered plugin, keyed by id. Unvalidated. */
  readonly manifests: ReadonlyMap<string, unknown>;
}

const at = (id: string, ...rest: string[]) => ['plugins', id, ...rest];
const label = (id: string) => at(id).join('.');
const field = (id: string) => ({ label: label(id), path: at(id) });

function manifestIssues(id: string, manifest: unknown): ConfigurationError[] {
  if (isValid(PluginManifest, manifest) && manifest.id === id && isWellFormedSchema(manifest.configSchema)) return [];
  return [new ConfigurationError(`Plugin "${id}" has an invalid manifest.`, { code: 'plugin-manifest-invalid', path: at(id) })];
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entryIssues(id: string, entry: unknown, manifest: unknown): ConfigurationError[] {
  if (manifest === undefined) {
    return [new ConfigurationError(`${label(id)} is enabled but no plugin "${id}" is registered.`, { code: 'plugin-unregistered', path: at(id) })];
  }
  const broken = manifestIssues(id, manifest);
  if (broken.length > 0) return broken;
  const data = manifest as PluginManifestData;
  const shared: TSchema = data.uses.agents ? LlmPluginConfig : PluginSharedConfig;
  const issues = sectionIssues(field(id), shared, entry);
  if (issues.length > 0) return issues;
  return sectionIssues(field(id), data.configSchema, entry);
}

/**
 * Issues of the merged `plugins` section against the registered manifests, empty when valid. An enabled
 * entry (`enabled !== false`, including a non-mapping) must be registered and valid. A mapping with
 * `enabled: false` is never checked, so config for a removed plugin may stay. With no `plugins` key
 * (`undefined`), nothing is validated. Pure: no I/O and no registry import.
 */
export function pluginEntryIssues({ plugins, manifests }: PluginValidationInput): ConfigurationError[] {
  if (plugins === undefined) return [];
  if (!isMapping(plugins)) {
    return [new ConfigurationError('plugins must be a mapping of plugin id to configuration.', { code: 'plugins-invalid', path: ['plugins'] })];
  }
  return Object.entries(plugins).flatMap(([id, entry]) => {
    if (isMapping(entry) && entry.enabled === false) return [];
    return entryIssues(id, entry, manifests.get(id));
  });
}

/** The manifest data of every plugin in a registry, keyed by id: the `manifests` input of `pluginEntryIssues`. */
export function registryManifests(registry: PluginRegistry): ReadonlyMap<string, unknown> {
  return new Map(registry.ids().flatMap((id) => {
    const plugin = registry.get(id);
    return plugin === undefined ? [] : [[id, plugin.manifest] as const];
  }));
}

export interface PluginProblem {
  readonly plugin: string;
  /** Document path of the problem, such as `plugins.prompt_cache_ttl.policies.default.cache_ttl`. */
  readonly path: readonly string[];
  readonly message: string;
}

function ownValues(plugin: Plugin, level: ExtensionLevel, body: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(plugin.manifest.extensions?.fields[level]?.properties ?? {});
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]));
}

type AgentEntry = PluginValidateInput['agents'][number];

/** Where an agent body sits in the document, and the registry that can infer its client. */
interface AgentSite {
  readonly path: string[];
  readonly clients?: ClientRegistry | undefined;
}

/** What a validation run reads besides the config: an optional workflow, and the client registry. */
export interface PluginValidationScope {
  readonly workflow?: Record<string, unknown> | null | undefined;
  readonly clients?: ClientRegistry | undefined;
}

/** The one client that lists `model`; null when none, several, or no lookup exists (the resolver reports it). */
function inferredClient(clients: ClientRegistry | undefined, model: string | null): string | null {
  if (clients?.clientsForModel === undefined || model === null) return null;
  try {
    const { matches } = clients.clientsForModel(model);
    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
}

function agentEntry(plugin: Plugin, where: AgentSite, body: Record<string, unknown>): AgentEntry {
  const { path, clients } = where;
  const declared = isMapping(body.client) && typeof body.client.type === 'string' ? body.client.type : null;
  const model = typeof body.model === 'string' ? body.model : null;
  const client = declared ?? inferredClient(clients, model);
  return { path: path.join('.'), client, model, extensions: ownValues(plugin, 'agent', body) };
}

function configAgents(plugin: Plugin, config: Record<string, unknown>, clients?: ClientRegistry): AgentEntry[] {
  const agents: AgentEntry[] = [];
  const named = isMapping(config.agents) ? Object.entries(config.agents) : [];
  for (const [name, body] of named) {
    if (isMapping(body)) agents.push(agentEntry(plugin, { path: ['agents', name], clients }, body));
  }
  const roles = isMapping(config.roles) ? Object.entries(config.roles) : [];
  for (const [name, role] of roles) {
    if (isMapping(role) && isMapping(role.agent)) agents.push(agentEntry(plugin, { path: ['roles', name, 'agent'], clients }, role.agent));
  }
  return agents;
}

function validationInput(
  plugin: Plugin,
  config: Record<string, unknown>,
  scope: PluginValidationScope,
): PluginValidateInput {
  const { workflow, clients } = scope;
  const agents = configAgents(plugin, config, clients);
  const stages: PluginValidateInput['stages'][number][] = [];
  for (const raw of Array.isArray(workflow?.stages) ? workflow.stages : []) {
    if (!isMapping(raw) || typeof raw.id !== 'string') continue;
    stages.push({ path: `stages.${raw.id}`, extensions: ownValues(plugin, 'stage', raw) });
    if (isMapping(raw.agent)) agents.push(agentEntry(plugin, { path: ['stages', raw.id, 'agent'], clients }, raw.agent));
  }
  const entry = isMapping(config.plugins) ? config.plugins[plugin.manifest.id] : undefined;
  return { options: isMapping(entry) ? entry : {}, agents, stages };
}

/**
 * The problems every enabled plugin with a `validate` member reports for a config and, optionally, a workflow
 * (plugin API 1.1). The validators come from the registry the caller injects; kernel imports no plugin. A
 * problem path is the plugin's own relative path, prefixed with `plugins.<id>` when it names an option.
 */
export function pluginValidationProblems(
  registry: PluginRegistry,
  config: Record<string, unknown>,
  scope: PluginValidationScope = {},
): PluginProblem[] {
  const found: PluginProblem[] = [];
  for (const id of registry.ids()) {
    const plugin = registry.get(id);
    if (plugin?.validate === undefined) continue;
    const entry = isMapping(config.plugins) ? config.plugins[id] : undefined;
    if (isMapping(entry) && entry.enabled === false) continue;
    for (const problem of plugin.validate(validationInput(plugin, config, scope))) {
      found.push({ plugin: id, path: problem.path.split('.'), message: problem.message });
    }
  }
  return found;
}

export type { PluginRegistry };
