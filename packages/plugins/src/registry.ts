import type { Plugin, PluginRegistry } from '@nodeint/migent-contracts';

export type { PluginRegistry };

/** First-party plugins. Empty in this step: features add themselves here (#131, #141, #142). */
const FIRST_PARTY: readonly Plugin[] = [];

/** Builds a registry. The default is the first-party list; tests inject their own plugins. */
export function createPluginRegistry(plugins: readonly Plugin[] = FIRST_PARTY): PluginRegistry {
  const byId = new Map<string, Plugin>();
  for (const plugin of plugins) {
    if (byId.has(plugin.manifest.id)) throw new Error(`Plugin "${plugin.manifest.id}" is registered twice.`);
    byId.set(plugin.manifest.id, plugin);
  }
  return { ids: () => [...byId.keys()].sort(), get: (id) => byId.get(id) };
}
