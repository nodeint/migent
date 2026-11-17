import type { PluginRegistry } from '@nodeint/migent-contracts';

import type { ClientRegistry } from './cli-client.js';
import { field, loadAgentDefinition, loadAgentTarget, type StageTarget } from './config.js';
import { ConfigurationError } from './errors.js';

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether the entry takes part in a freeze as a pinned target: enabled, non-advisory, and calls an agent. */
export function needsPluginTarget(registry: PluginRegistry, id: string, entry: unknown): boolean {
  const manifest = registry.get(id)?.manifest;
  if (manifest === undefined || manifest.advisory || !manifest.capabilities.includes('invokeAgent')) return false;
  return !(isMapping(entry) && entry.enabled === false);
}

/**
 * The agent target of one plugin entry, resolved like a role's agent: a named agent or an inline one.
 * Throws a `ConfigurationError` when it cannot be resolved.
 */
export function resolvePluginTarget(
  config: Record<string, unknown>,
  target: { id: string; entry: unknown },
  clients: ClientRegistry,
): StageTarget {
  const { id, entry } = target;
  const agent = isMapping(entry) ? entry.agent : undefined;
  if (typeof agent === 'string') return loadAgentTarget(config, agent, { registry: clients });
  return loadAgentDefinition(agent, field('plugins', id, 'agent'), { registry: clients });
}

/**
 * The issues a freeze would raise for the pinned targets of the non-advisory `invokeAgent` entries in `plugins`.
 * Advisory entries are not frozen, so an unresolved agent there is a runtime unavailability, not an issue.
 * Call only after `pluginEntryIssues` found no issue.
 */
export function pluginTargetIssues(
  config: Record<string, unknown>,
  context: { plugins: unknown; registry: PluginRegistry; clients: ClientRegistry },
): ConfigurationError[] {
  const { plugins, registry, clients } = context;
  if (!isMapping(plugins)) return [];
  const issues: ConfigurationError[] = [];
  for (const [id, entry] of Object.entries(plugins)) {
    if (!needsPluginTarget(registry, id, entry)) continue;
    try {
      resolvePluginTarget(config, { id, entry }, clients);
    } catch (caught) {
      if (!(caught instanceof ConfigurationError)) throw caught;
      issues.push(caught);
    }
  }
  return issues;
}
