import { type ExtensionCatalog, type ExtensionLevel, PLUGIN_EXTENSIONS } from '@nodeint/migent-contracts';
import {
  type ExtensionIssue,
  extensionIssues,
  type ExtensionTarget,
  type ExtensionValues,
  groupExtensions,
} from '@nodeint/migent-workflow';

import { ConfigurationError } from './errors.js';

/** A claimed-key problem in the vocabulary of the structural config errors. */
export function extensionError(issue: ExtensionIssue): ConfigurationError {
  return new ConfigurationError(issue.message, { code: issue.code, path: issue.path });
}

/** Every invalid claimed key of one config mapping (role, named agent, or inline agent), as errors. */
export function extensionConfigErrors(
  catalog: ExtensionCatalog,
  level: ExtensionLevel,
  target: ExtensionTarget,
): ConfigurationError[] {
  return extensionIssues(catalog, level, target).map((issue) => extensionError(issue));
}

/** Throws the first invalid claimed key of one config mapping. Plugin enablement plays no part (AC8). */
export function throwFirstExtensionIssue(
  catalog: ExtensionCatalog,
  level: ExtensionLevel,
  target: ExtensionTarget,
): void {
  const [first] = extensionConfigErrors(catalog, level, target);
  if (first !== undefined) throw first;
}

/**
 * Every invalid claimed key of an effective config, in document order: each role, each named agent, and each
 * inline role agent. Used by `migent doctor`, which reports all problems in one run.
 */
export function configExtensionErrors(
  config: Record<string, unknown>,
  catalog: ExtensionCatalog = PLUGIN_EXTENSIONS,
): ConfigurationError[] {
  const errors: ConfigurationError[] = [];
  const check = (level: ExtensionLevel, value: unknown, base: readonly string[]): void => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    errors.push(...extensionConfigErrors(catalog, level, {
      mapping: value as Record<string, unknown>,
      label: base.join('.'),
      base,
    }));
  };
  const {agents} = config;
  if (typeof agents === 'object' && agents !== null && !Array.isArray(agents)) {
    for (const [name, agent] of Object.entries(agents)) check('agent', agent, ['agents', name]);
  }
  const {roles} = config;
  if (typeof roles === 'object' && roles !== null && !Array.isArray(roles)) {
    for (const [name, role] of Object.entries(roles)) {
      check('role', role, ['roles', name]);
      if (typeof role === 'object' && role !== null) check('agent', (role as Record<string, unknown>).agent, ['roles', name, 'agent']);
    }
  }
  return errors;
}

/** Validates the claimed keys of one agent mapping and returns them grouped by owner. Throws the first problem. */
export function readAgentExtensions(
  catalog: ExtensionCatalog,
  agentConfig: Record<string, unknown>,
  here: { readonly label: string; readonly path: readonly (string | number)[] },
): ExtensionValues {
  throwFirstExtensionIssue(catalog, 'agent', { mapping: agentConfig, label: here.label, base: here.path });
  return groupExtensions(catalog, 'agent', agentConfig);
}

/** Validates the claimed keys of one role mapping and returns them grouped by owner. Throws the first problem. */
export function readRoleExtensions(
  catalog: ExtensionCatalog,
  role: Record<string, unknown>,
  roleKey: string,
): ExtensionValues {
  throwFirstExtensionIssue(catalog, 'role', { mapping: role, label: `roles.${roleKey}`, base: ['roles', roleKey] });
  return groupExtensions(catalog, 'role', role);
}

/** The target with its extension groups. A group is carried only when it holds a key. */
export function withTargetExtensions<T extends object>(
  target: T,
  groups: { extensions?: ExtensionValues; roleExtensions?: ExtensionValues },
): T & { extensions?: ExtensionValues; roleExtensions?: ExtensionValues } {
  const { extensions = {}, roleExtensions = {} } = groups;
  return {
    ...target,
    ...(Object.keys(extensions).length === 0 ? {} : { extensions }),
    ...(Object.keys(roleExtensions).length === 0 ? {} : { roleExtensions }),
  };
}
