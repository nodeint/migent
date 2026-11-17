import type { OperationRequest } from './operation.js';

/** Detached data (D9): identifiers only. */
export type PolicyContext = {
  readonly sessionId: string;
  readonly stageId: string;
  readonly executionId: string;
  readonly role: string;
  readonly operationId: string;
  readonly attempt: number;
};

export type PolicyDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string };

export type Policy = {
  evaluate(request: OperationRequest, context: PolicyContext): PolicyDecision;
};

export const ALLOW_ALL_POLICY: Policy = {
  evaluate: () => ({ kind: 'allow' }),
};
