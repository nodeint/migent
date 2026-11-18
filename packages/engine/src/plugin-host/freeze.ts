import { type PluginManifest, type PluginRegistry } from '@nodeint/migent-contracts';
import type { ClientRegistry } from '@nodeint/migent-kernel';
import { pluginEntryIssues, registryManifests, resolvePluginTarget } from '@nodeint/migent-kernel';
import type { PluginFreezeInput, PluginsFrozenEntries } from '@nodeint/migent-session';

/** An enabled entry: anything but a mapping with `enabled: false`. A non-mapping counts as enabled and invalid. */
export function isEnabledEntry(entry: unknown): boolean {
  return !(typeof entry === 'object' && entry !== null && !Array.isArray(entry) && (entry as Record<string, unknown>).enabled === false);
}

export const EMPTY_PLUGIN_REGISTRY: PluginRegistry = { ids: () => [], get: () => undefined };

/** Whether the manifest declares `uses.agents`, so the entry needs an agent target. */
export function declaresAgent(manifest: PluginManifest | undefined): boolean {
  return manifest?.uses.agents === true;
}

/**
 * Classifies a `plugins` entry from the registered manifest: advisory plugins stay live, every other entry is
 * frozen, including a disabled or unregistered one. An id the freeze kept live stays live even when its plugin
 * is no longer registered (design D9, D12).
 */
export function pluginClassifier(registry: PluginRegistry, liveEntries: readonly string[] = []): (id: string) => 'frozen' | 'live' {
  const kept = new Set(liveEntries);
  return (id) => (kept.has(id) || registry.get(id)?.manifest.advisory === true ? 'live' : 'frozen');
}

/** Validates the merged `plugins` section and throws the first issue, so a freeze write fails with exit 2. */
export function assertPluginsValid(config: Record<string, unknown>, registry: PluginRegistry): void {
  const [first] = pluginEntryIssues({ plugins: config.plugins, manifests: registryManifests(registry) });
  if (first !== undefined) throw first;
}

/** What a freeze write needs from the host: the classifier, and the validated `plugins.frozen` snapshot. */
export function pluginFreezeInput(registry: PluginRegistry, clients: ClientRegistry): PluginFreezeInput {
  return {
    classify: pluginClassifier(registry),
    snapshot: (config) => {
      assertPluginsValid(config, registry);
      const plugins = config.plugins as Record<string, unknown>;
      return Object.entries(plugins).map(([id, entry]): PluginsFrozenEntries[number] => {
        const manifest = registry.get(id)?.manifest;
        const enabled = isEnabledEntry(entry);
        const advisory = manifest?.advisory === true;
        const pinned = enabled && !advisory && declaresAgent(manifest);
        return {
          id,
          enabled,
          advisory,
          version: manifest?.version ?? null,
          target: pinned ? { ...resolvePluginTarget(config, { id, entry }, clients) } : null,
        };
      });
    },
  };
}
