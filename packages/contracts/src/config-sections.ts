import type { TSchema } from 'typebox';

/**
 * Config sections: namespaced top-level config keys that a feature registers, next to the core
 * keys (`schema_version`, `agents`, `roles`, `resume_policies`). Pure data. The kernel merges and
 * validates sections, the session package freezes and resolves them, and neither imports the
 * feature that owns one. The list lives in `config-section-registry.ts`; an unregistered top-level key stays ignored.
 */

/** How a section is merged when `config.local.yaml` overrides `config.yaml`. */
export type ConfigSectionMerge = 'deep' | 'replace';

/**
 * How a section is frozen into `workflow.frozen.yaml`:
 * `frozen` pins the whole section, `live` never freezes it, and `per_entry` treats the section as a
 * mapping of entry id to entry value where a classifier decides per entry.
 */
export type ConfigSectionFreeze = 'frozen' | 'live' | 'per_entry';

export interface ConfigSection {
  /** Top-level config key. Matches `CONFIG_SECTION_KEY_PATTERN`; never a core or legacy key. */
  readonly key: string;
  /** Validates the merged section. */
  readonly schema: TSchema;
  readonly merge: ConfigSectionMerge;
  readonly freeze: ConfigSectionFreeze;
  /** Validates one frozen entry of a `per_entry` section. */
  readonly entrySchema?: TSchema;
}

/**
 * Decides whether one entry of a `per_entry` section is frozen or live. The caller supplies it,
 * keyed by section key, because the fact it needs (for example a plugin manifest) is not visible
 * to contracts.
 */
export type EntryClassifier = (entryId: string, entryValue: unknown) => 'frozen' | 'live';

export const CONFIG_SECTION_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Top-level keys a section may not use: the core keys and the legacy `models`. */
export const RESERVED_CONFIG_KEYS: readonly string[] = ['schema_version', 'agents', 'roles', 'resume_policies', 'models'];

/** Throws when a list breaks the namespace rules: key pattern, no reserved key, unique keys. */
export function assertConfigSections(sections: readonly ConfigSection[]): void {
  const seen = new Set<string>();
  for (const { key } of sections) {
    if (!CONFIG_SECTION_KEY_PATTERN.test(key)) {
      throw new Error(`Config section key "${key}" must match ${CONFIG_SECTION_KEY_PATTERN.source}.`);
    }
    if (RESERVED_CONFIG_KEYS.includes(key)) throw new Error(`Config section key "${key}" is a core or legacy config key.`);
    if (seen.has(key)) throw new Error(`Config section key "${key}" is registered twice.`);
    seen.add(key);
  }
}
