import { isSupportedPluginApiVersion, type Plugin, PLUGIN_API_VERSION, type PluginRegistry } from '@nodeint/migent-contracts';

import { metricsPlugin } from './metrics/index.js';

export type { PluginRegistry };

/** First-party plugins. Features add themselves here (#131, #141, #142). */
const FIRST_PARTY: readonly Plugin[] = [metricsPlugin];

/** Builds a registry. The default is the first-party list; tests inject their own plugins. */
export function createPluginRegistry(plugins: readonly Plugin[] = FIRST_PARTY): PluginRegistry {
  const byId = new Map<string, Plugin>();
  for (const plugin of plugins) {
    const { apiVersion } = plugin.manifest;
    if (!isSupportedPluginApiVersion(apiVersion)) {
      throw new Error(
        `Plugin "${plugin.manifest.id}" needs plugin API ${apiVersion.major}.${apiVersion.minor}; ` +
        `this core supports ${PLUGIN_API_VERSION.major}.${PLUGIN_API_VERSION.minor}.`,
      );
    }
    if (byId.has(plugin.manifest.id)) throw new Error(`Plugin "${plugin.manifest.id}" is registered twice.`);
    byId.set(plugin.manifest.id, plugin);
  }
  return { ids: () => [...byId.keys()].sort(), get: (id) => byId.get(id) };
}
