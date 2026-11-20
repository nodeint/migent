import {
  type ExtensionCatalog,
  isSupportedPluginApiVersion,
  type Plugin,
  PLUGIN_API_VERSION,
  PLUGIN_EXTENSIONS,
  type PluginRegistry,
} from '@nodeint/migent-contracts';

import { metricsPlugin } from './metrics/index.js';
import { promptCacheTtlPlugin } from './prompt-cache-ttl/index.js';

export type { PluginRegistry };

/** First-party plugins. Features add themselves here (#131, #141, #142). */
const FIRST_PARTY: readonly Plugin[] = [metricsPlugin, promptCacheTtlPlugin];

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
    if (byId.has(plugin.manifest.id)) throw new Error(`Plugin "${plugin.manifest.id}" is registered twice.`);
    byId.set(plugin.manifest.id, plugin);
  }
  return { ids: () => [...byId.keys()].sort(), get: (id) => byId.get(id) };
}
