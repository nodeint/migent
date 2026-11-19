import type { ExtensionCatalog, PluginExtensionReads } from '@nodeint/migent-contracts';
import { extensionKeys, PLUGIN_EXTENSIONS } from '@nodeint/migent-contracts';
import { loadWorkspaceConfig } from '@nodeint/migent-kernel';
import type { FrozenExtensions } from '@nodeint/migent-session';
import { readRoleFreeze, readWorkflowFreeze } from '@nodeint/migent-session';
import type { ExtensionValues } from '@nodeint/migent-workflow';
import { isRecord, withoutOwnedKeys } from '@nodeint/migent-workflow';

/** The fields of a freeze that extension reads use, shared by a workflow freeze and a role freeze. */
interface ExtensionSource {
  readonly workflow: {
    readonly extensions?: ExtensionValues | undefined;
    readonly stages: Readonly<Record<string, { readonly extensions?: ExtensionValues | undefined }>>;
  };
  readonly extensions: FrozenExtensions;
}

/**
 * The frozen extension keys of one plugin, read from the session freeze at call time and never from live files.
 * A missing freeze reads as having no keys; a corrupt one throws.
 */
function frozenExtensionReads(sessionDirectory: string, plugin: string): PluginExtensionReads {
  // A role session keeps its freeze in the event log and has no workflow; a workflow session uses its freeze file.
  const read = <T>(pick: (freeze: ExtensionSource) => T): T | null => {
    const role = readRoleFreeze(sessionDirectory);
    if (role !== null) return pick({ workflow: { extensions: undefined, stages: {} }, extensions: role.extensions });
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
