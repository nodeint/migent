import { CONFIG_SECTIONS } from '@nodeint/migent-contracts';

import type { ConfigOwner } from './config.js';
import { sectionIssues } from './config-structure.js';
import type { ConfigurationError } from './errors.js';

type OwnerOf = (path: readonly (string | number)[]) => ConfigOwner;

/**
 * Applies the `replace` merge of registered config sections to a deep-merged config: a section
 * the local layer declares replaces the project's wholesale. Returns the owner lookup, which
 * attributes a replaced section to the local layer. With no section registered it is `ownerOf`.
 */
export function withSectionOwners(
  merged: Record<string, unknown>,
  layer: Record<string, unknown>,
  ownerOf: OwnerOf,
): OwnerOf {
  const replaced = new Set<string>();
  for (const section of CONFIG_SECTIONS) {
    if (section.merge !== 'replace' || !Object.hasOwn(layer, section.key)) continue;
    Object.assign(merged, { [section.key]: layer[section.key] });
    replaced.add(section.key);
  }
  return (path) => (typeof path[0] === 'string' && replaced.has(path[0]) ? 'local' : ownerOf(path));
}

/**
 * Errors of the registered config sections present in a merged config, empty when none is
 * registered. Unregistered top-level keys are ignored, as they always were.
 */
export function configSectionIssues(config: Record<string, unknown>): ConfigurationError[] {
  return CONFIG_SECTIONS.flatMap((section) =>
    Object.hasOwn(config, section.key) ? sectionIssues(section.key, section.schema, config[section.key]) : []);
}
