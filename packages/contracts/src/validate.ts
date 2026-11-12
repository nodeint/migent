import type { Static, TSchema } from 'typebox';
import Value from 'typebox/value';

export interface ValidationIssue {
  path: string;
  message: string;
}

export function isValid<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
  return Value.Check(schema, value);
}

/** Empty when the value matches. */
export function validationIssues(schema: TSchema, value: unknown): ValidationIssue[] {
  return Value.Errors(schema, value).map((error) => ({ path: error.instancePath, message: error.message }));
}

export interface SchemaIssue {
  /** JSON Schema keyword that failed, e.g. `type`, `pattern`, `additionalProperties`, `propertyNames`. */
  keyword: string;
  /** JSON Schema location of the failing keyword, e.g. `#/properties/options/propertyNames`. */
  schemaPath: string;
  /** Author-coordinate path of the failing node: literal keys, numbers for array indexes. */
  path: (string | number)[];
  message: string;
  /** Keyword parameters, e.g. `requiredProperties` for `required`. */
  params: Record<string, unknown>;
  /** The value at `path`. */
  value: unknown;
}

/**
 * Like `validationIssues`, with the instance path decoded from JSON Pointer into literal segments
 * (a key may contain `.`, `/` or `~`). `additionalProperties` issues point at the offending key.
 */
export function schemaIssues(schema: TSchema, value: unknown): SchemaIssue[] {
  return Value.Errors(schema, value).map((error) => {
    const path: (string | number)[] = [];
    let node: unknown = value;
    for (const raw of error.instancePath.split('/').slice(1)) {
      const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
      path.push(Array.isArray(node) ? Number(key) : key);
      node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[key] : undefined;
    }
    return {
      keyword: error.keyword,
      schemaPath: error.schemaPath,
      path,
      message: error.message,
      params: error.params as Record<string, unknown>,
      value: node,
    };
  });
}
