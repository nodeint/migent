/** Comment-preserving YAML line-patching primitives shared by the config and workflow text patchers. */
import { isRecord } from '@nodeint/migent-workflow';

import { ConfigurationError } from './errors.js';

const PLAIN_SCALAR = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export class ConfigEditError extends ConfigurationError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigEditError';
  }
}

export type Edit = [number, number, string[]];

/** Quote a scalar the way Python `_yaml_scalar` does. Plain tokens stay bare. */
export function yamlScalar(value: string): string {
  if (PLAIN_SCALAR.test(value) && value !== 'true' && value !== 'false' && value !== 'null') {
    return value;
  }
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${escaped}"`;
}

export function splitComment(line: string): [string, string] {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === '#' && !inSingle && !inDouble) {
      return [line.slice(0, index).trimEnd(), line.slice(index)];
    }
  }
  return [line.trimEnd(), ''];
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

export function deepCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => deepCopy(item));
  if (isRecord(value)) return deepCopyRecord(value);
  return value;
}

export function deepCopyRecord(value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) copy[key] = deepCopy(item);
  return copy;
}

// Python str.splitlines(): `\r\n` is one break, and a trailing break does not yield an empty line.
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function applyEdits(original: string, lines: string[], edits: Edit[]): string {
  const numbered = edits.map((edit, order) => ({ order, edit }));
  numbered.sort((left, right) => {
    if (left.edit[0] !== right.edit[0]) return right.edit[0] - left.edit[0];
    if (left.edit[1] !== right.edit[1]) return right.edit[1] - left.edit[1];
    return right.order - left.order;
  });
  for (const { edit } of numbered) {
    const [start, end, replacement] = edit;
    lines.splice(start, end - start, ...replacement);
  }
  let text = lines.join('\n');
  if (original.endsWith('\n') || original === '') text += '\n';
  return text;
}
