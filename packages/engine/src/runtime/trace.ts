import type { OperationOutcome, Transition } from './operation.js';
import type { PolicyDecision } from './policy.js';

/** One decision of the cycle. The invocation id is transient and appears only here. */
export type TraceEntry =
  | { readonly kind: 'request'; readonly invocationId: string; readonly executionId: string; readonly operationId: string; readonly attempt: number }
  | { readonly kind: 'policy'; readonly invocationId: string; readonly verdict: PolicyDecision['kind'] }
  | { readonly kind: 'outcome'; readonly invocationId: string; readonly outcome: OperationOutcome<never, never>['kind'] }
  | { readonly kind: 'transition'; readonly invocationId: string; readonly transition: Transition<never, never, never>['kind']; readonly nextOperationId: string | null };

export type TraceSink = {
  record(entry: TraceEntry): void;
};
