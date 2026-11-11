import { createHash } from 'node:crypto';

import { documentVersion, isRecord } from '@nodeint/migent-workflow';
import { SCHEMA_VERSION } from '@nodeint/migent-workflow';
import { parseYamlDocument } from '@nodeint/migent-workflow';
import { type Document, isMap, isNode, isSeq, type Node as YamlNode, type Pair, parseDocument, stringify, visit, type YAMLMap, type YAMLSeq } from 'yaml';

import { YAML_DEFAULT_INDENT as DEFAULT_INDENT } from './constants.js';
import { ConfigurationError } from './errors.js';

/** Largest indent width accepted when sniffing a document. */
const MAX_INDENT = 10;

export type DraftFormat = 'yaml' | 'json';

/** SHA-256 of raw bytes, lowercase hex. The hash `save --base-hash` compares. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function jsonErrorPosition(text: string, message: string): { line: number; column: number } | undefined {
  const lineColumn = /\(line (\d+) column (\d+)\)/.exec(message);
  if (lineColumn) return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  const offset = /position (\d+)/.exec(message);
  if (!offset) return undefined;
  const lines = text.slice(0, Number(offset[1])).split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/**
 * Parses draft text into a mapping. JSON must satisfy the strict JSON grammar first; the data then
 * comes from the YAML parser so both formats treat duplicate keys the same way.
 */
export function parseDraftText(text: string, format: DraftFormat): Record<string, unknown> {
  if (format === 'json') {
    try {
      JSON.parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const position = jsonErrorPosition(text, message);
      throw new ConfigurationError(message, { code: 'json-syntax', ...(position === undefined ? {} : { position }) });
    }
  }
  const parsed = parseYamlDocument(text);
  if (!isRecord(parsed)) {
    throw new ConfigurationError('Invalid document: expected a mapping.', { code: 'not-a-mapping' });
  }
  return parsed;
}

/** The bytes `render`/`save` should write, and whether a given base kept its comments. */
export interface AuthoringRender {
  text: string;
  /** False when a base was given but its comments could not be preserved; `reason` says why. */
  preserved: boolean;
  reason?: string;
}

/**
 * The one rendering. It depends only on the draft mapping, keeps its key order, and is what both
 * `render` and `save` emit. With `base` (the target's current text) it keeps that file's comments,
 * key order and line endings: unchanged data returns the base bytes verbatim, a changed document is
 * reconciled into the base's syntax tree and re-serialized, and anything it cannot preserve falls
 * back to the canonical bytes with a reason.
 */
export function renderAuthoringYaml(mapping: Record<string, unknown>, base?: string): AuthoringRender {
  const canonical = stringify(mapping, { lineWidth: 0 });
  if (base === undefined) return { text: canonical, preserved: true };
  let data: unknown;
  try {
    data = parseYamlDocument(base);
  } catch {
    return { text: canonical, preserved: false, reason: 'the base is not valid YAML' };
  }
  // Tier 1: the base already holds this data, so its bytes are the output.
  if (deepEqual(data, mapping)) return { text: base, preserved: true };

  let doc: Document.Parsed;
  try {
    doc = parseDocument(base);
  } catch {
    return { text: canonical, preserved: false, reason: 'the base could not be read as YAML' };
  }
  const unsupported = unsupportedBaseReason(doc);
  if (unsupported !== null) return { text: canonical, preserved: false, reason: unsupported };
  if (!isMap(doc.contents)) {
    return { text: canonical, preserved: false, reason: 'the base is not a mapping' };
  }
  let text: string;
  try {
    reconcileMap(doc, doc.contents, mapping);
    text = applyLineEnding(doc.toString({ lineWidth: 0, indent: indentWidth(base) }), lineEndingOf(base));
  } catch {
    return { text: canonical, preserved: false, reason: 'the base could not be updated in place' };
  }
  // Tier 2 is only trusted once the result holds exactly the draft's data.
  try {
    if (!deepEqual(parseYamlDocument(text), mapping)) {
      return { text: canonical, preserved: false, reason: 'updating the base in place changed its data' };
    }
  } catch {
    return { text: canonical, preserved: false, reason: 'updating the base in place produced invalid YAML' };
  }
  return { text, preserved: true };
}

/** Order-insensitive for mappings (YAML keys are a set), ordered for lists. */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

function lineEndingOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function applyLineEnding(text: string, ending: string): string {
  return ending === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
}

/** The indentation width the base uses, so a kept document keeps its shape. */
function indentWidth(text: string): number {
  const match = /\n( +)\S/.exec(text.replace(/\r\n/g, '\n'));
  const width = match === null ? DEFAULT_INDENT : match[1].length;
  return width >= 1 && width <= MAX_INDENT ? width : DEFAULT_INDENT;
}

/** Anchors, aliases, merge keys and custom tags cannot be reconciled node by node. */
function unsupportedBaseReason(doc: Document.Parsed): string | null {
  if (doc.errors.length > 0) return 'the base is not valid YAML';
  let reason: string | null = null;
  visit(doc, {
    Alias() {
      reason ??= 'the base uses an alias';
    },
    Node(_key, node: YamlNode) {
      if (node.anchor !== undefined) reason ??= 'the base uses an anchor';
      const {tag} = node;
      if (tag !== undefined && !tag.startsWith('tag:yaml.org,2002:')) reason ??= 'the base uses a custom tag';
    },
    Pair(_key, pair: Pair) {
      if (isNode(pair.key) && String(pair.key.toJSON()) === '<<') reason ??= 'the base uses a merge key';
    },
  });
  return reason;
}

/** A new node for `value` that carries the comments of the node it replaces. */
function createNodeLike(doc: Document, value: unknown, replaced: YamlNode | null | undefined): YamlNode {
  const created = doc.createNode(value) as YamlNode;
  if (replaced !== null && replaced !== undefined && isNode(replaced)) {
    if (created.comment === undefined) created.comment = replaced.comment;
    if (created.commentBefore === undefined) created.commentBefore = replaced.commentBefore;
  }
  return created;
}

function reconcileMap(doc: Document, map: YAMLMap, data: Record<string, unknown>): void {
  const wanted = new Map<string, unknown>(Object.entries(data));
  const kept = new Set<string>();
  const removed: number[] = [];
  map.items.forEach((pair, index) => {
    const key = isNode(pair.key) ? String(pair.key.toJSON()) : String(pair.key);
    if (!wanted.has(key)) {
      removed.push(index);
      return;
    }
    kept.add(key);
    map.set(pair.key, reconcileValue(doc, pair.value as YamlNode | null, wanted.get(key)));
  });
  for (const index of removed.reverse()) map.items.splice(index, 1);
  // Keys the draft adds go last, in draft order; every kept key keeps the file's order.
  for (const [key, value] of Object.entries(data)) {
    if (kept.has(key)) continue;
    map.items.push(doc.createPair(key, value));
  }
}

/** The node that holds `value`: `node` itself, reconciled in place, or a replacement for it. */
function reconcileValue(doc: Document, node: YamlNode | null | undefined, value: unknown): YamlNode {
  if (Array.isArray(value)) {
    if (isSeq(node)) {
      reconcileSeq(doc, node, value);
      return node;
    }
    return createNodeLike(doc, value, node);
  }
  if (isRecord(value)) {
    if (isMap(node)) {
      reconcileMap(doc, node, value);
      return node;
    }
    return createNodeLike(doc, value, node);
  }
  const unchanged =
    node !== null && node !== undefined && isNode(node) && !isMap(node) && !isSeq(node)
    && deepEqual(node.toJSON(), value);
  if (unchanged) return node;
  return createNodeLike(doc, value, node);
}

/** Stages and outputs are matched by `id` when every item has one, so reordering keeps comments. */
function reconcileSeq(doc: Document, seq: YAMLSeq, items: readonly unknown[]): void {
  const ids = items.map((item) => (isRecord(item) && typeof item.id === 'string' ? item.id : null));
  const baseIds = seq.items.map((item) => {
    if (!isMap(item)) return null;
    const pair = item.items.find((entry) => isNode(entry.key) && String(entry.key.toJSON()) === 'id');
    return pair !== undefined && isNode(pair.value) && typeof pair.value.toJSON() === 'string'
      ? String(pair.value.toJSON())
      : null;
  });
  const byId = ids.every((id) => id !== null) && baseIds.every((id) => id !== null);
  let nodes: YamlNode[];
  if (byId) {
    const existing = new Map<string, YamlNode>();
    seq.items.forEach((node, index) => existing.set(baseIds[index], node as YamlNode));
    nodes = items.map((item, index) => {
      const id = ids[index];
      if (id === null) return doc.createNode(item) as YamlNode;
      const node = existing.get(id);
      if (node === undefined) return doc.createNode(item) as YamlNode;
      existing.delete(id);
      return reconcileValue(doc, node, item);
    });
  } else {
    nodes = items.map((item, index) => {
      if (index >= seq.items.length) return doc.createNode(item) as YamlNode;
      return reconcileValue(doc, seq.items[index] as YamlNode, item);
    });
  }
  installItems(seq, nodes);
}

/** Make `nodes` the sequence's items, through the yaml API so the sequence keeps its own comments and flow style. */
function installItems(seq: YAMLSeq, nodes: readonly YamlNode[]): void {
  nodes.forEach((node, index) => {
    if (index < seq.items.length) seq.set(index, node);
    else seq.add(node);
  });
  while (seq.items.length > nodes.length) seq.delete(seq.items.length - 1);
}

/** True when the YAML text carries any comment. */
export function yamlHasComments(text: string): boolean {
  try {
    const doc = parseDocument(text);
    if (doc.comment || doc.commentBefore) return true;
    let found = false;
    visit(doc, {
      Node(_key, node) {
        if (node.comment || node.commentBefore) found = true;
      },
      Pair(_key, pair) {
        const key = pair.key as { comment?: string; commentBefore?: string } | null;
        if (key && (key.comment || key.commentBefore)) found = true;
      },
    });
    return found;
  } catch {
    return false;
  }
}

export type SchemaVersionStatus =
  | { status: 'current'; version: number }
  | { status: 'outdated'; version: number }
  | { status: 'newer'; version: number }
  | { status: 'invalid'; message: string };

/** The per-document schema rule runtime applies: only the current version is accepted. Missing is 0. */
export function checkDocumentSchemaVersion(document: Record<string, unknown>): SchemaVersionStatus {
  let version: number;
  try {
    version = documentVersion(document);
  } catch (error) {
    return { status: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
  if (version === SCHEMA_VERSION) return { status: 'current', version };
  return { status: version > SCHEMA_VERSION ? 'newer' : 'outdated', version };
}
