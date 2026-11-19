import type { TObject, TProperties, TSchema } from 'typebox';
import Type from 'typebox';

/**
 * Plugin extensions: flat keys that a plugin claims on a workflow, stage, agent, or role, next to the core
 * keys. Pure data, declared in the static `PLUGIN_EXTENSIONS` catalog. Contracts, the workflow parser, the
 * kernel, and the session freeze all derive their valid keys from one catalog, and none imports the plugin
 * that owns an entry. This module has no dependency on the core key sets; `extensions.ts` checks them.
 */

export const EXTENSION_LEVELS = ['workflow', 'stage', 'agent', 'role'] as const;
export type ExtensionLevel = (typeof EXTENSION_LEVELS)[number];

/** A plugin id and a claimed key match this pattern. */
export const EXTENSION_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface PluginExtension {
  /** Plugin id. Matches `EXTENSION_KEY_PATTERN`; at most one entry per plugin. */
  readonly plugin: string;
  /** Positive integer. The plugin raises it only when its extension schemas change incompatibly. */
  readonly version: number;
  /** At most one object schema per level. Its property names are the keys the plugin claims there. */
  readonly fields: { readonly [Level in ExtensionLevel]?: TObject };
}

export type ExtensionCatalog = readonly PluginExtension[];

/** Static and core-owned. Empty in production; a feature adds its entry here. */
export const PLUGIN_EXTENSIONS: ExtensionCatalog = [];

/** The keys claimed on one level, in catalog order. */
export function extensionKeys(catalog: ExtensionCatalog, level: ExtensionLevel): string[] {
  return catalog.flatMap((entry) => Object.keys(entry.fields[level]?.properties ?? {}));
}

/** The plugin id that claims `key` on `level`, or `undefined`. */
export function extensionOwner(catalog: ExtensionCatalog, level: ExtensionLevel, key: string): string | undefined {
  return catalog.find((entry) => Object.hasOwn(entry.fields[level]?.properties ?? {}, key))?.plugin;
}

/** The core properties plus one optional property per claimed key, taken from the owner's field schema. */
export function withExtensionProperties<P extends TProperties>(
  core: P,
  catalog: ExtensionCatalog,
  level: ExtensionLevel,
): P & Record<string, TSchema> {
  const claimed: Record<string, TSchema> = {};
  for (const entry of catalog) {
    for (const [key, schema] of Object.entries(entry.fields[level]?.properties ?? {})) {
      claimed[key] = Type.Optional(schema as TSchema);
    }
  }
  return { ...core, ...claimed };
}
