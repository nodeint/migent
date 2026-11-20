import {
  type ExtensionCatalog,
  isSupportedPluginApiVersion,
  type Plugin,
  PLUGIN_API_VERSION,
  PLUGIN_EXTENSIONS,
  type PluginRegistry,
} from '@nodeint/migent-contracts';

import { metricsPlugin } from './metrics/index.js';
import { nextPlugin } from './next/index.js';
import { promptCacheTtlPlugin } from './prompt-cache-ttl/index.js';

export type { PluginRegistry };

/** First-party plugins. Features add themselves here (#131, #141, #142). */
const FIRST_PARTY: readonly Plugin[] = [metricsPlugin, promptCacheTtlPlugin, nextPlugin];

/** Structural equality of plain data: schemas are JSON-like objects, arrays and scalars. */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  const sameKeys = keys.length === Object.keys(right).length;
  return sameKeys && keys.every((key) => Object.hasOwn(right, key) && sameData(left[key], right[key]));
}

/** The plugin API minor that introduced `responseContract`. */
const RESPONSE_CONTRACT_MINOR = 2;

/** The response entry and `responseContract` go together, and the member needs plugin API 1.2. */
function assertResponseContract(plugin: Plugin, entry: ExtensionCatalog[number] | undefined): void {
  const { id, apiVersion } = plugin.manifest;
  const declared = entry?.fields.response !== undefined;
  const member = plugin.responseContract !== undefined;
  if (member && !declared) throw new Error(`Plugin "${id}" has responseContract but its catalog entry has no response field.`);
  if (declared && !member) throw new Error(`Plugin "${id}" has a response field in its catalog entry but no responseContract.`);
  if (member && apiVersion.minor < RESPONSE_CONTRACT_MINOR) throw new Error(`Plugin "${id}" has responseContract and needs plugin API 1.2 or later; it declares ${apiVersion.major}.${apiVersion.minor}.`);
}

/**
 * Builds a registry. The default is the first-party list; tests inject their own plugins and catalog. A manifest's
 * `extensions` must equal the catalog entry for its id, and may be omitted only when the catalog has none.
 */
export function createPluginRegistry(
  plugins: readonly Plugin[] = FIRST_PARTY,
  catalog: ExtensionCatalog = PLUGIN_EXTENSIONS,
): PluginRegistry {
  const byId = new Map<string, Plugin>();
  for (const plugin of plugins) {
    const { apiVersion } = plugin.manifest;
    if (!isSupportedPluginApiVersion(apiVersion)) {
      throw new Error(
        `Plugin "${plugin.manifest.id}" needs plugin API ${apiVersion.major}.${apiVersion.minor}; ` +
        `this core supports ${PLUGIN_API_VERSION.major}.${PLUGIN_API_VERSION.minor}.`,
      );
    }
    const entry = catalog.find((candidate) => candidate.plugin === plugin.manifest.id);
    if (!sameData(plugin.manifest.extensions, entry)) {
      throw new Error(
        entry
          ? `Plugin "${plugin.manifest.id}" must declare the extensions of its catalog entry in its manifest.`
          : `Plugin "${plugin.manifest.id}" declares extensions that the catalog does not list.`,
      );
    }
    assertResponseContract(plugin, entry);
    if (byId.has(plugin.manifest.id)) throw new Error(`Plugin "${plugin.manifest.id}" is registered twice.`);
    byId.set(plugin.manifest.id, plugin);
  }
  return { ids: () => [...byId.keys()].sort(), get: (id) => byId.get(id) };
}
