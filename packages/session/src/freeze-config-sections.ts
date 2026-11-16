import { CONFIG_SECTIONS, type ConfigSection, type EntryClassifier, isValid } from '@nodeint/migent-contracts';
import { ConfigurationError } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';

/** Classifier per `per_entry` section key. Engine supplies it; it is empty while no section exists. */
export type EntryClassifiers = Readonly<Record<string, EntryClassifier>>;

/** What `workflow.frozen.yaml` holds under `config.<key>` for a registered section. */
export type FrozenSection =
  | { readonly kind: 'frozen'; readonly value: unknown }
  | {
    readonly kind: 'per_entry';
    /** The frozen subset of entries. May be empty. */
    readonly entries: Readonly<Record<string, unknown>>;
    /** Ids that were live at creation, sorted and unique. May be empty. */
    readonly liveEntries: readonly string[];
  };

/** A `live` entry that runs from live config. `since` says whether the freeze already knew it. */
export interface LiveEntry {
  readonly id: string;
  readonly value: unknown;
  readonly since: 'freeze' | 'added';
}

export type EffectiveConfigSection =
  | { readonly kind: 'frozen'; readonly value: unknown }
  | { readonly kind: 'live'; readonly value: unknown }
  | {
    readonly kind: 'per_entry';
    readonly entries: Readonly<Record<string, unknown>>;
    readonly live: readonly LiveEntry[];
    /** Live ids the classifier marks frozen that the freeze never pinned. They are not used. */
    readonly addedAfterFreeze: readonly string[];
  };

function sectionFor(key: string): ConfigSection {
  const section = CONFIG_SECTIONS.find((candidate) => candidate.key === key);
  if (section === undefined) throw new Error(`Config section "${key}" is not registered.`);
  return section;
}

function classifierFor(section: ConfigSection, classifiers: EntryClassifiers): EntryClassifier {
  // Own properties only: a key such as `constructor` must not find an inherited function.
  const classifier = Object.hasOwn(classifiers, section.key) ? classifiers[section.key] : undefined;
  if (classifier === undefined) {
    throw new Error(`Config section "${section.key}" is per_entry and needs an entry classifier.`);
  }
  return classifier;
}

function invalid(key: string): ConfigurationError {
  return new ConfigurationError(`Missing or invalid ${key}.`, { code: 'missing-or-invalid', path: [key] });
}

function entrySchemaOf(section: ConfigSection): NonNullable<ConfigSection['entrySchema']> {
  if (section.entrySchema === undefined) throw new Error(`Config section "${section.key}" is per_entry and has no entrySchema.`);
  return section.entrySchema;
}

function freezePerEntry(
  section: ConfigSection,
  value: unknown,
  classifiers: EntryClassifiers,
): Record<string, unknown> {
  const classify = classifierFor(section, classifiers);
  const entrySchema = entrySchemaOf(section);
  if (!isRecord(value)) throw invalid(section.key);
  const frozen: [string, unknown][] = [];
  const live: string[] = [];
  for (const [id, entry] of Object.entries(value)) {
    if (!isValid(entrySchema, entry)) throw invalid(`${section.key}.${id}`);
    if (classify(id, entry) === 'live') live.push(id);
    else frozen.push([id, entry]);
  }
  // `fromEntries` defines own properties, so an id such as `__proto__` is kept like any other.
  return { entries: Object.fromEntries(frozen), live_entries: [...live].sort() };
}

/**
 * The `config` mapping for a new freeze: one value per registered section present in the merged
 * config, or null when none is written. A live section writes nothing.
 */
export function freezeConfigSections(
  config: Record<string, unknown>,
  classifiers: EntryClassifiers,
): Record<string, unknown> | null {
  const written: Record<string, unknown> = {};
  for (const section of CONFIG_SECTIONS) {
    if (!Object.hasOwn(config, section.key) || section.freeze === 'live') continue;
    const value = config[section.key];
    if (!isValid(section.schema, value)) throw invalid(section.key);
    written[section.key] = section.freeze === 'frozen' ? value : freezePerEntry(section, value, classifiers);
  }
  return Object.keys(written).length === 0 ? null : written;
}

/** Reads and validates the frozen `config` mapping. Anything unregistered is ignored. */
export function readFrozenConfigSections(
  value: unknown,
  fail: (message: string) => never,
): Record<string, FrozenSection> {
  const sections: Record<string, FrozenSection> = {};
  if (value === undefined) return sections;
  if (!isRecord(value)) return fail('config must be a mapping');
  for (const section of CONFIG_SECTIONS) {
    if (section.freeze === 'live' || !Object.hasOwn(value, section.key)) continue;
    const raw = value[section.key];
    if (section.freeze === 'frozen') {
      if (!isValid(section.schema, raw)) return fail(`config.${section.key} is invalid`);
      sections[section.key] = { kind: 'frozen', value: raw };
    } else {
      sections[section.key] = readPerEntry(section, raw, fail);
    }
  }
  return sections;
}

function readPerEntry(section: ConfigSection, raw: unknown, fail: (message: string) => never): FrozenSection {
  const where = `config.${section.key}`;
  if (!isRecord(raw)) return fail(`${where} must be a mapping`);
  if (!isRecord(raw.entries)) return fail(`${where}.entries must be a mapping`);
  const entrySchema = entrySchemaOf(section);
  for (const [id, entry] of Object.entries(raw.entries)) {
    if (!isValid(entrySchema, entry)) return fail(`${where}.entries.${id} is invalid`);
  }
  const ids = raw.live_entries;
  const wellFormed = Array.isArray(ids)
    && ids.every((id) => typeof id === 'string' && id.trim() !== '')
    && new Set(ids).size === ids.length;
  if (!wellFormed) return fail(`${where}.live_entries must be a list of unique non-blank strings`);
  const liveEntries = [...(ids as string[])].sort();
  const both = liveEntries.find((id) => Object.hasOwn(raw.entries as Record<string, unknown>, id));
  if (both !== undefined) return fail(`${where}: "${both}" is in both entries and live_entries`);
  return { kind: 'per_entry', entries: { ...raw.entries }, liveEntries };
}

/** Which section to resolve, and the per-entry classifiers of the caller. */
export interface SectionRequest {
  readonly key: string;
  readonly classifiers: EntryClassifiers;
}

/**
 * Resolves one registered section on resume. Frozen data never reads live config; a live section
 * reads live config and validates it. A frozen section with no record is absent, with no live
 * fallback. Only the facts are reported: the caller decides what `addedAfterFreeze` means.
 */
export function effectiveConfigSection(
  freeze: { readonly config: Readonly<Record<string, FrozenSection>> },
  liveConfig: Record<string, unknown>,
  request: SectionRequest,
): EffectiveConfigSection | null {
  const section = sectionFor(request.key);
  const liveValue = Object.hasOwn(liveConfig, request.key) ? liveConfig[request.key] : undefined;
  if (section.freeze === 'live') {
    if (liveValue === undefined) return null;
    if (!isValid(section.schema, liveValue)) throw invalid(request.key);
    return { kind: 'live', value: liveValue };
  }
  const record = Object.hasOwn(freeze.config, request.key) ? freeze.config[request.key] : undefined;
  if (section.freeze === 'frozen') return record?.kind === 'frozen' ? { kind: 'frozen', value: record.value } : null;
  const frozen = record?.kind === 'per_entry' ? record : null;
  return resolvePerEntry(section, { frozen, liveValue, classifiers: request.classifiers });
}

function resolvePerEntry(
  section: ConfigSection,
  input: {
    frozen: Extract<FrozenSection, { kind: 'per_entry' }> | null;
    liveValue: unknown;
    classifiers: EntryClassifiers;
  },
): EffectiveConfigSection {
  const { frozen, liveValue, classifiers } = input;
  const classify = classifierFor(section, classifiers);
  const entrySchema = entrySchemaOf(section);
  const entries = frozen?.entries ?? {};
  const known = new Set(frozen?.liveEntries ?? []);
  const live: LiveEntry[] = [];
  const addedAfterFreeze: string[] = [];
  const current = liveValue === undefined ? {} : liveValue;
  if (!isRecord(current)) throw invalid(section.key);
  for (const [id, value] of Object.entries(current)) {
    if (Object.hasOwn(entries, id)) continue;
    if (!isValid(entrySchema, value)) throw invalid(`${section.key}.${id}`);
    if (classify(id, value) === 'live') live.push({ id, value, since: known.has(id) ? 'freeze' : 'added' });
    else addedAfterFreeze.push(id);
  }
  return { kind: 'per_entry', entries: { ...entries }, live, addedAfterFreeze };
}
