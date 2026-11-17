import type { OperationOutcome } from '../../../src/runtime/operation.ts';
import type { PlainData } from '../../../src/runtime/plain-data.ts';

type Outcome = OperationOutcome<PlainData, never>;
type Paused = { readonly kind: 'paused' };

function assertNever(value: never): never {
  throw new Error(String(value));
}

// The built-in definitions decide succeeded, failed and denied explicitly; this shape compiles.
export function decide(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'denied':
      return 'denied';
    default:
      return assertNever(outcome);
  }
}

// A new outcome variant fails to compile until a definition decides it.
export function decideWithNewVariant(outcome: Outcome | Paused): string {
  switch (outcome.kind) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'denied':
      return 'denied';
    default:
      // @ts-expect-error a new outcome variant must be decided before this compiles
      return assertNever(outcome);
  }
}
