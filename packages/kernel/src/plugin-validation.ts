import { isValid, isWellFormedSchema, LlmPluginConfig, PluginManifest, type PluginRegistry, PluginSharedConfig, type TSchema } from '@nodeint/migent-contracts';

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

export type { PluginRegistry };
