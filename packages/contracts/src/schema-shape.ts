import type { TSchema } from 'typebox';

/**
 * Structural check of a JSON Schema given as data. The validator accepts malformed schemas silently, so a
 * caller that takes a schema from a plugin manifest checks it here first.
 */

const MAX_DEPTH = 64;
const SCHEMA_TYPES: ReadonlySet<unknown> = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const MAP_KEYS = ['properties', 'patternProperties', '$defs', 'definitions'] as const;
const ONE_KEYS = [
  'items', 'additionalProperties', 'additionalItems', 'not', 'if', 'then', 'else', 'contains',
  'propertyNames', 'unevaluatedItems', 'unevaluatedProperties',
] as const;
const LIST_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;

const NUMBER_KEYS = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'minContains', 'maxContains',
] as const;
const STRING_KEYS = ['format', 'title', 'description', '$id'] as const;
const BOOLEAN_KEYS = ['uniqueItems'] as const;

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);

function pointerTarget(root: unknown, ref: string): unknown {
  let node: unknown = root;
  for (const raw of ref.slice(1).split('/').slice(1)) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Node)[raw.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  return node;
}

const typeOk = (type: unknown): boolean => {
  if (type === undefined || SCHEMA_TYPES.has(type)) return true;
  return Array.isArray(type) && type.length > 0 && type.every((item) => SCHEMA_TYPES.has(item));
};

const requiredOk = (required: unknown): boolean =>
  required === undefined || (Array.isArray(required) && required.every((item) => typeof item === 'string'));

const refOk = (ref: unknown, root: unknown): boolean =>
  ref === undefined || (typeof ref === 'string' && ref.startsWith('#') && (ref === '#' || isNode(pointerTarget(root, ref))));

const regexOk = (source: string): boolean => {
  try {
    void new RegExp(source, 'u');
    return true;
  } catch {
    return false;
  }
};

const patternOk = (node: Node): boolean => {
  if (node.pattern !== undefined && !(typeof node.pattern === 'string' && regexOk(node.pattern))) return false;
  return !isNode(node.patternProperties) || Object.keys(node.patternProperties).every(regexOk);
};

function constraintsOk(node: Node): boolean {
  const number = NUMBER_KEYS.every((key) => node[key] === undefined || (typeof node[key] === 'number' && Number.isFinite(node[key])));
  const text = STRING_KEYS.every((key) => node[key] === undefined || typeof node[key] === 'string');
  const flag = BOOLEAN_KEYS.every((key) => node[key] === undefined || typeof node[key] === 'boolean');
  return number && text && flag && patternOk(node);
}

function scalarsOk(node: Node, root: unknown): boolean {
  return constraintsOk(node) && typeOk(node.type) && requiredOk(node.required) && refOk(node.$ref, root)
    && (node.enum === undefined || Array.isArray(node.enum));
}

function childrenOk(node: Node, root: unknown, depth: number): boolean {
  const sub = (value: unknown) => wellFormed(value, root, depth + 1);
  const maps = MAP_KEYS.every((key) => {
    const value = node[key];
    return value === undefined || (isNode(value) && Object.values(value).every(sub));
  });
  const ones = ONE_KEYS.every((key) => node[key] === undefined || sub(node[key]));
  const lists = LIST_KEYS.every((key) => {
    const value = node[key];
    return value === undefined || (Array.isArray(value) && value.every(sub));
  });
  return maps && ones && lists;
}

function wellFormed(node: unknown, root: unknown, depth: number): boolean {
  if (typeof node === 'boolean') return true;
  return isNode(node) && depth <= MAX_DEPTH && scalarsOk(node, root) && childrenOk(node, root, depth);
}

/**
 * Known `type` names, numeric, string and boolean constraints of the right type, `pattern` and
 * `patternProperties` keys that compile, schema-valued sub-schemas, `required` as strings, and local `$ref`
 * pointers that resolve.
 */
export function isWellFormedSchema(schema: unknown): schema is TSchema {
  return isNode(schema) && wellFormed(schema, schema, 0);
}
