import { SCHEMA_BASE } from '../common.js';
import * as contracts from '../index.js';

/** JSON Schema dialect written at the root of every generated file. */
export const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Node = { [key: string]: unknown };

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);
const idOf = (value: unknown): string | null => (isNode(value) && typeof value.$id === 'string' ? value.$id : null);

/** Plain JSON copy: own string keys only, `undefined` and functions dropped. */
function plain(value: unknown, replaceIdentities: boolean, root: unknown): Json {
  if (Array.isArray(value)) return value.map((item) => plain(item, replaceIdentities, root));
  if (!isNode(value)) return (value ?? null) as Json;
  const nested = idOf(value);
  if (replaceIdentities && nested !== null && value !== root) return { $ref: nested };
  const out: Record<string, Json> = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item === undefined || typeof item === 'function') continue;
    out[key] = plain(item, replaceIdentities, root);
  }
  return out;
}

function walk(value: unknown, visit: (node: Node) => void, seen = new Set<unknown>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, seen);
    return;
  }
  const node = value as Node;
  if (idOf(node) !== null) visit(node);
  for (const key of Object.keys(node)) walk(node[key], visit, seen);
}

/** Every identified schema reachable from the package exports, keyed by `$id`, in a stable order. */
export function collectIdentities(): Map<string, Node> {
  const found = new Map<string, Node>();
  const content = new Map<string, string>();
  for (const name of Object.keys(contracts).sort()) {
    walk((contracts as Record<string, unknown>)[name], (node) => {
      const identity = node.$id as string;
      const text = JSON.stringify(plain(node, false, node));
      const previous = content.get(identity);
      if (previous !== undefined && previous !== text) throw new Error(`Two different schemas share the $id ${identity}`);
      content.set(identity, text);
      if (!found.has(identity)) found.set(identity, node);
    });
  }
  return new Map([...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function schemaPath(identity: string): string {
  const prefix = `${SCHEMA_BASE}/`;
  if (!identity.startsWith(prefix)) throw new Error(`$id is outside the schema base: ${identity}`);
  return identity.slice(prefix.length);
}

/** `{ "schemas/<id path>.json": content }`. Nested identities become `$ref`s to their own file. */
export function generateSchemaFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [identity, node] of collectIdentities()) {
    const body = plain(node, true, node) as Record<string, Json>;
    const { $id, ...rest } = body;
    files[`packages/contracts/schemas/${schemaPath(identity)}`] = `${JSON.stringify({ $schema: SCHEMA_DIALECT, $id, ...rest }, null, 2)}\n`;
  }
  return files;
}
