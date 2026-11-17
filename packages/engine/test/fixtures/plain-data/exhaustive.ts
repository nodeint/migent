import type { HandlerResult } from '../../../src/runtime/operation.ts';
import type { PlainData } from '../../../src/runtime/plain-data.ts';

type Paused = { readonly kind: 'paused'; readonly resumeAfter: number };

function assertNever(value: never): never {
  throw new Error(String(value));
}

// Handling every current kind compiles.
export function handle(result: HandlerResult<PlainData, never>): string {
  switch (result.kind) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    default:
      return assertNever(result);
  }
}

// Adding a variant makes the same switch fail until it is handled explicitly.
export function handleWithNewVariant(result: HandlerResult<PlainData, never> | Paused): string {
  switch (result.kind) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    default:
      // @ts-expect-error a new variant must be handled before this compiles
      return assertNever(result);
  }
}
