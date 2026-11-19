import type { ExtensionCatalog, ExtensionLevel, PluginExtension } from '@nodeint/migent-contracts';
import { schemaIssues } from '@nodeint/migent-contracts';

import { isRecord } from './record.js';

/** Optional catalog of plugin extensions for the parse entry points. The default is `PLUGIN_EXTENSIONS`. */
export interface WorkflowParseOptions {
  readonly extensions?: ExtensionCatalog;
}

/** Claimed keys of a document or stage, grouped by owning plugin id, in catalog order. */
export type ExtensionValues = Record<string, Record<string, unknown>>;

/** An invalid plugin value, in the vocabulary of the structural config errors. */
export interface ExtensionIssue {
  code: 'missing-or-invalid';
  message: string;
  path: (string | number)[];
}

/** The mapping to check and where it sits in the document. */
export interface ExtensionTarget {
  readonly mapping: Record<string, unknown>;
  /** Dotted author label of the mapping, e.g. `stages.plan`; empty for the document. */
  readonly label: string;
  /** Author-coordinate path of the mapping. */
  readonly base: readonly (string | number)[];
}

type LevelSchema = NonNullable<PluginExtension['fields'][ExtensionLevel]>;
type PropertySchema = LevelSchema['properties'][string];

interface KeyCheck {
  readonly key: string;
  readonly schema: PropertySchema;
  readonly target: ExtensionTarget;
}

/** Where a required field is missing, the error names that field. */
function issueTails(schema: PropertySchema, value: unknown): (string | number)[][] {
  const tails: (string | number)[][] = [];
  for (const issue of schemaIssues(schema, value)) {
    if (issue.keyword === 'anyOf') continue;
    if (issue.keyword === 'required') {
      for (const name of issue.params.requiredProperties as string[]) tails.push([...issue.path, name]);
    } else {
      tails.push(issue.path);
    }
  }
  return tails;
}

/** One error per invalid path of one claimed key. */
function keyIssues({ key, schema, target }: KeyCheck): ExtensionIssue[] {
  const prefix = target.label === '' ? [] : [target.label];
  return issueTails(schema, target.mapping[key]).map((tail) => ({
    code: 'missing-or-invalid',
    message: `Missing or invalid ${[...prefix, key, ...tail].join('.')}.`,
    path: [...target.base, key, ...tail],
  }));
}

/**
 * Validates the claimed keys present in `target.mapping` against their owners' schemas. Reports every invalid
 * path, so a caller that collects problems sees them all. Plugin enablement plays no part.
 */
export function extensionIssues(
  catalog: ExtensionCatalog,
  level: ExtensionLevel,
  target: ExtensionTarget,
): ExtensionIssue[] {
  const checks: KeyCheck[] = [];
  for (const entry of catalog) {
    for (const [key, schema] of claimedProperties(entry.fields[level])) {
      if (Object.hasOwn(target.mapping, key)) checks.push({ key, schema, target });
    }
  }
  const issues = checks.flatMap((check) => keyIssues(check));
  return dedupeByPath(issues);
}

function dedupeByPath(issues: ExtensionIssue[]): ExtensionIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const id = JSON.stringify(issue.path);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function claimedProperties(schema: LevelSchema | undefined): [string, PropertySchema][] {
  return Object.entries(schema?.properties ?? {});
}

/** The claimed keys present in `mapping`, grouped by owner in catalog order. Owners with no key are omitted. */
export function groupExtensions(
  catalog: ExtensionCatalog,
  level: ExtensionLevel,
  mapping: Record<string, unknown>,
): ExtensionValues {
  const grouped: ExtensionValues = {};
  for (const entry of catalog) {
    const found = Object.keys(entry.fields[level]?.properties ?? {}).filter((key) => Object.hasOwn(mapping, key));
    if (found.length > 0) grouped[entry.plugin] = Object.fromEntries(found.map((key) => [key, mapping[key]]));
  }
  return grouped;
}

/** A copy of `mapping` without exactly the listed keys. Every other field is kept. */
export function withoutOwnedKeys(
  mapping: Record<string, unknown>,
  ownedKeys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(mapping).filter(([key]) => !ownedKeys.includes(key)));
}

/** Problems of the document's own claimed keys and of those on each stage, in document order. */
export function workflowExtensionIssues(catalog: ExtensionCatalog, data: Record<string, unknown>): ExtensionIssue[] {
  const issues = extensionIssues(catalog, 'workflow', { mapping: data, label: '', base: [] });
  if (!Array.isArray(data.stages)) return issues;
  data.stages.forEach((stage, index) => {
    if (!isRecord(stage)) return;
    // An unreadable id must not hide the stage's own plugin errors: fall back to the list index for the label.
    const id = typeof stage.id === 'string' && stage.id.trim() !== '' ? stage.id.trim() : String(index);
    const target = { mapping: stage, label: `stages.${id}`, base: ['stages', index] };
    issues.push(...extensionIssues(catalog, 'stage', target));
    if (isRecord(stage.agent)) {
      const agent = { mapping: stage.agent, label: `${target.label}.agent`, base: ['stages', index, 'agent'] };
      issues.push(...extensionIssues(catalog, 'agent', agent));
    }
  });
  return issues;
}
