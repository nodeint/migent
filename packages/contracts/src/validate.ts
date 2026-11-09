import Value from "typebox/value";
import type { Static, TSchema } from "typebox";

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
