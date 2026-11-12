import type { Static, TSchema } from '@nodeint/migent-contracts';
import { JSON_INDENT } from '@nodeint/migent-kernel';

import { cliHooks } from './hooks.js';

/**
 * The only place that serializes `--json` / `-o json` output. The value is typed from the
 * contract schema, so drift is a compile error at the call site. Runtime validation is a test seam.
 */
export function serializeJson<S extends TSchema>(schema: S, value: Static<S>, pretty = false): string {
  cliHooks.validateJson?.(schema, value);
  return pretty ? JSON.stringify(value, null, JSON_INDENT) : JSON.stringify(value);
}

/** One JSON document (or one JSON line) followed by a newline. */
export function writeJson<S extends TSchema>(schema: S, value: Static<S>, options: { pretty?: boolean } = {}): void {
  process.stdout.write(`${serializeJson(schema, value, options.pretty === true)}\n`);
}
