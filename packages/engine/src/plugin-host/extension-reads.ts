import type { ExtensionCatalog, PluginExtensionReads } from '@nodeint/migent-contracts';
import { extensionKeys, PLUGIN_EXTENSIONS } from '@nodeint/migent-contracts';
import { loadWorkspaceConfig } from '@nodeint/migent-kernel';
import { readWorkflowFreeze } from '@nodeint/migent-session';
import { isRecord, withoutOwnedKeys } from '@nodeint/migent-workflow';

/**
 * The frozen extension keys of one plugin, read from the session freeze at call time and never from live files.
 * A missing freeze reads as having no keys; a corrupt one throws.
 */
function frozenExtensionReads(sessionDirectory: string, plugin: string): PluginExtensionReads {
  const read = <T>(pick: (freeze: NonNullable<ReturnType<typeof readWorkflowFreeze>>) => T): T | null => {
    const freeze = readWorkflowFreeze(sessionDirectory);
    return freeze === null ? null : pick(freeze);
  };
  const own = (values: Record<string, Record<string, unknown>> | undefined): Record<string, unknown> | null => {
    const mine = values?.[plugin];
    return mine === undefined || Object.keys(mine).length === 0 ? null : mine;
  };
  return {
    workflow: () => read((freeze) => own(freeze.workflow.extensions)),
    stage: (stageId) => read((freeze) => own(freeze.workflow.stages[stageId]?.extensions)),
    agent: (stageId) => read((freeze) => own(freeze.extensions.targets[stageId])),
    role: (name) => read((freeze) => own(freeze.extensions.roles[name])),
  };
}

/**
 * `config.core('agents' | 'roles')` without any catalog-owned key. Ownership is the current catalog's, because the
 * live config was validated against it. Every field no plugin owns passes through unchanged.
 */
export function coreWithoutExtensions(
  key: string,
  value: unknown,
  catalog: ExtensionCatalog = PLUGIN_EXTENSIONS,
): unknown {
  if (!isRecord(value)) return value;
  const agentKeys = extensionKeys(catalog, 'agent');
  const roleKeys = extensionKeys(catalog, 'role');
  const mapEntries = (entry: (item: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(value).map(([name, item]) => [name, isRecord(item) ? entry(item) : item]));
  if (key === 'agents') return mapEntries((agent) => withoutOwnedKeys(agent, agentKeys));
  if (key === 'roles') {
    return mapEntries((role) => {
      const stripped = withoutOwnedKeys(role, roleKeys);
      return isRecord(stripped.agent) ? { ...stripped, agent: withoutOwnedKeys(stripped.agent, agentKeys) } : stripped;
    });
  }
  return value;
}

/** The config reads of one plugin: live core config without owned keys, and its frozen extension keys. */
export function configSources(
  workspace: string,
  sessionDirectory: string,
  plugin: string,
): { readonly readCore: (key: string) => unknown; readonly extensionReads: PluginExtensionReads } {
  return {
    readCore: (key: string): unknown => coreWithoutExtensions(key, loadWorkspaceConfig(workspace)[key]),
    extensionReads: frozenExtensionReads(sessionDirectory, plugin),
  };
}
