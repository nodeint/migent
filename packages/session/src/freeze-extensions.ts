import type { ExtensionCatalog, ExtensionLevel, PluginExtension } from '@nodeint/migent-contracts';
import { EXTENSION_LEVELS } from '@nodeint/migent-contracts';
import type { StageTarget } from '@nodeint/migent-kernel';
import type { ExtensionValues, WorkflowDocument } from '@nodeint/migent-workflow';
import { isRecord } from '@nodeint/migent-workflow';

import { corrupt } from './freeze-corrupt.js';

/** What a freeze recorded about one plugin's extensions: its extension version and the keys it owned per level. */
export interface FrozenExtensionRecord {
  readonly version: number;
  readonly keys: Readonly<Record<ExtensionLevel, readonly string[]>>;
}

/** The extension data of one freeze, read from the freeze alone. Empty for a freeze written without any. */
export interface FrozenExtensions {
  /** The `extensions` map: one record per plugin that had a catalog entry at freeze time. */
  readonly records: Readonly<Record<string, FrozenExtensionRecord>>;
  /** `targets.<stage>.extensions`: the resolved agent's claimed keys, by owner. */
  readonly targets: Readonly<Record<string, ExtensionValues>>;
  /** `role_extensions`: the claimed keys of each role, by owner. */
  readonly roles: Readonly<Record<string, ExtensionValues>>;
}

type KeyLists = Record<ExtensionLevel, string[]>;
type FieldSchema = NonNullable<PluginExtension['fields'][ExtensionLevel]>;

/** The distinct keys `plugin` owns across a list of claimed-key groups. */
function ownedKeys(plugin: string, groups: readonly (ExtensionValues | undefined)[]): string[] {
  return [...new Set(groups.flatMap((group) => Object.keys(group?.[plugin] ?? {})))];
}

/** The inputs of the freeze `extensions` map. */
export interface ExtensionSources {
  readonly workflow: WorkflowDocument;
  readonly targets: Record<string, StageTarget>;
  readonly roleTargets: Record<string, StageTarget>;
}

/**
 * The freeze keys for plugin extensions. Each key is present only when non-empty, so an empty catalog adds
 * nothing to the freeze.
 */
export function freezeExtensionKeys(
  catalog: ExtensionCatalog,
  sources: ExtensionSources,
): Record<string, unknown> {
  if (catalog.length === 0) return {};
  const { workflow, targets, roleTargets } = sources;
  const records: Record<string, unknown> = {};
  for (const entry of catalog) {
    const keys: KeyLists = {
      workflow: ownedKeys(entry.plugin, [workflow.extensions]),
      stage: ownedKeys(entry.plugin, Object.values(workflow.stages).map((stage) => stage.extensions)),
      agent: ownedKeys(entry.plugin, Object.values(targets).map((target) => target.extensions)),
      role: ownedKeys(entry.plugin, Object.values(roleTargets).map((target) => target.roleExtensions)),
    };
    records[entry.plugin] = { version: entry.version, keys };
  }
  const roleExtensions = Object.fromEntries(
    Object.entries(roleTargets).filter(([, target]) => hasKeys(target.roleExtensions)).map(
      ([role, target]) => [role, target.roleExtensions],
    ),
  );
  return {
    ...(Object.keys(roleExtensions).length === 0 ? {} : { role_extensions: roleExtensions }),
    extensions: records,
  };
}

function hasKeys(groups: ExtensionValues | undefined): groups is ExtensionValues {
  return groups !== undefined && Object.keys(groups).length > 0;
}

/** The `targets.<stage>.extensions` field of one written target; absent when the agent claims no key. */
export function targetExtensionField(target: StageTarget): { extensions?: ExtensionValues } {
  return hasKeys(target.extensions) ? { extensions: target.extensions } : {};
}

function readKeyList(value: unknown, where: string, filePath: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((key) => typeof key !== 'string')) {
    throw corrupt(filePath, `${where} must be a list of strings`);
  }
  return [...(value as string[])];
}

function readRecord(plugin: string, raw: unknown, filePath: string): FrozenExtensionRecord {
  const where = `extensions.${plugin}`;
  if (!isRecord(raw)) throw corrupt(filePath, `${where} must be a mapping`);
  const { version } = raw;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw corrupt(filePath, `${where}.version must be a positive integer`);
  }
  if (!isRecord(raw.keys)) throw corrupt(filePath, `${where}.keys must be a mapping`);
  const keys = Object.fromEntries(
    EXTENSION_LEVELS.map((level) => [level, readKeyList(raw.keys && (raw.keys as Record<string, unknown>)[level], `${where}.keys.${level}`, filePath)]),
  ) as Record<ExtensionLevel, string[]>;
  return { version, keys };
}

/** A mapping of owner to claimed keys. Values are checked for mapping shape only, never against a schema. */
function readGroups(value: unknown, where: string, filePath: string): ExtensionValues {
  if (!isRecord(value)) throw corrupt(filePath, `${where} must be a mapping`);
  const groups: ExtensionValues = {};
  for (const [owner, keys] of Object.entries(value)) {
    if (!isRecord(keys)) throw corrupt(filePath, `${where}.${owner} must be a mapping`);
    groups[owner] = { ...keys };
  }
  return groups;
}

function readGroupsByName(value: unknown, where: string, filePath: string): Record<string, ExtensionValues> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw corrupt(filePath, `${where} must be a mapping`);
  return Object.fromEntries(Object.entries(value).map(([name, raw]) => [name, readGroups(raw, `${where}.${name}`, filePath)]));
}

/** The `extensions` map and the per-target and per-role extension mappings of a freeze body. */
export function readFrozenExtensions(parsed: Record<string, unknown>, filePath: string): FrozenExtensions {
  const records: Record<string, FrozenExtensionRecord> = {};
  if (parsed.extensions !== undefined) {
    if (!isRecord(parsed.extensions)) throw corrupt(filePath, 'extensions must be a mapping');
    for (const [plugin, raw] of Object.entries(parsed.extensions)) records[plugin] = readRecord(plugin, raw, filePath);
  }
  const targets: Record<string, ExtensionValues> = {};
  if (isRecord(parsed.targets)) {
    for (const [stageId, raw] of Object.entries(parsed.targets)) {
      if (!isRecord(raw) || raw.extensions === undefined) continue;
      targets[stageId] = readGroups(raw.extensions, `targets.${stageId}.extensions`, filePath);
    }
  }
  return { records, targets, roles: readGroupsByName(parsed.role_extensions, 'role_extensions', filePath) };
}

/** An object schema whose properties accept any value. TypeBox schemas are plain JSON Schema objects. */
function acceptAny(keys: readonly string[]): FieldSchema {
  const properties = Object.fromEntries(keys.map((key) => [key, {}]));
  const schema: Record<string, unknown> = { type: 'object', properties };
  return schema as never;
}

function recordedFields(record: FrozenExtensionRecord): PluginExtension['fields'] {
  const fields: { -readonly [Level in ExtensionLevel]?: FieldSchema } = {};
  for (const level of EXTENSION_LEVELS) {
    if (record.keys[level].length > 0) fields[level] = acceptAny(record.keys[level]);
  }
  return fields;
}

/**
 * A catalog derived from the freeze's own `extensions` map: each recorded plugin claims its recorded keys with an
 * accept-any schema. Parsing the frozen body with it never consults the current catalog.
 */
export function recordedCatalog(records: FrozenExtensions['records']): ExtensionCatalog {
  return Object.entries(records).map(([plugin, record]) => ({
    plugin,
    version: record.version,
    fields: recordedFields(record),
  }));
}
