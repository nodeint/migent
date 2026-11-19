import { AGENT_CORE_PROPERTIES, ROLE_CORE_PROPERTIES } from './config.js';
import {
  EXTENSION_KEY_PATTERN,
  EXTENSION_LEVELS,
  type ExtensionCatalog,
  type ExtensionLevel,
  PLUGIN_EXTENSIONS,
  type PluginExtension,
} from './extension-catalog.js';
import { STAGE_CORE_PROPERTIES, WORKFLOW_CORE_PROPERTIES } from './workflow.js';

/** Keys that earlier schema versions removed. A plugin may not claim them. */
export const LEGACY_EXTENSION_KEYS: Readonly<Record<ExtensionLevel, readonly string[]>> = {
  workflow: ['outputs', 'requires'],
  stage: ['produces', 'model', 'options'],
  agent: ['options', 'provider'],
  role: ['options', 'default_model', 'instructions'],
};

const CORE_KEYS: Readonly<Record<ExtensionLevel, readonly string[]>> = {
  workflow: Object.keys(WORKFLOW_CORE_PROPERTIES),
  stage: Object.keys(STAGE_CORE_PROPERTIES),
  agent: Object.keys(AGENT_CORE_PROPERTIES),
  role: Object.keys(ROLE_CORE_PROPERTIES),
};

/** The core keys of a level, without any plugin key. */
export function coreExtensionLevelKeys(level: ExtensionLevel): readonly string[] {
  return CORE_KEYS[level];
}

function entryIssues(entry: PluginExtension, seen: Set<string>): string[] {
  const issues: string[] = [];
  if (!EXTENSION_KEY_PATTERN.test(entry.plugin)) {
    issues.push(`Extension plugin id "${entry.plugin}" must match ${EXTENSION_KEY_PATTERN.source}.`);
  }
  if (seen.has(entry.plugin)) issues.push(`Plugin "${entry.plugin}" has more than one extension entry.`);
  seen.add(entry.plugin);
  if (!Number.isInteger(entry.version) || entry.version < 1) {
    issues.push(`Plugin "${entry.plugin}" extension version must be a positive integer.`);
  }
  return issues;
}

function keyIssues(where: { plugin: string; level: ExtensionLevel }, key: string, claimed: Set<string>): string[] {
  const { plugin, level } = where;
  const issues: string[] = [];
  if (!EXTENSION_KEY_PATTERN.test(key)) issues.push(`Plugin "${plugin}" ${level} key "${key}" must match ${EXTENSION_KEY_PATTERN.source}.`);
  if (claimed.has(key)) issues.push(`The ${level} key "${key}" is claimed twice (plugin "${plugin}").`);
  claimed.add(key);
  if (CORE_KEYS[level].includes(key)) issues.push(`Plugin "${plugin}" claims the core ${level} key "${key}".`);
  if (LEGACY_EXTENSION_KEYS[level].includes(key)) issues.push(`Plugin "${plugin}" claims the legacy ${level} key "${key}".`);
  return issues;
}

/** Every rule violation of a catalog, as messages. Empty when the catalog is valid. */
export function extensionCatalogIssues(catalog: ExtensionCatalog): string[] {
  const seen = new Set<string>();
  const issues = catalog.flatMap((entry) => entryIssues(entry, seen));
  for (const level of EXTENSION_LEVELS) {
    const claimed = new Set<string>();
    for (const entry of catalog) {
      const keys = Object.keys(entry.fields[level]?.properties ?? {});
      issues.push(...keys.flatMap((key) => keyIssues({ plugin: entry.plugin, level }, key, claimed)));
    }
  }
  return issues;
}

/** Throws when a catalog breaks a rule. Runs when the module loads, as `assertConfigSections` does. */
export function assertExtensionCatalog(catalog: ExtensionCatalog): void {
  const issues = extensionCatalogIssues(catalog);
  if (issues.length > 0) throw new Error(`Invalid plugin extension catalog: ${issues.join(' ')}`);
}

assertExtensionCatalog(PLUGIN_EXTENSIONS);
