import type { LogicalIdentity } from './operation.js';
import type { RuntimeScope } from './operation-runtime.js';
import type { PlainData } from './plain-data.js';

export type InterceptPhase = 'before' | 'after';

/** What an interceptor proposes. The runtime judges it, and an interceptor never changes a value directly. */
export type InterceptProposal =
  | { readonly kind: 'continue' }
  | { readonly kind: 'patch'; readonly fields: Readonly<Record<string, unknown>> }
  | { readonly kind: 'short_circuit'; readonly output: unknown };

/** The runtime's verdict on one proposal: the value it yields, or the reason it is refused. */
export type Judgement =
  | { readonly kind: 'accepted'; readonly value: PlainData; readonly shortCircuit: boolean }
  | { readonly kind: 'rejected'; readonly reason: string };

/** One pass over the interceptors of one phase of one cycle. */
export type InterceptionCall = {
  readonly phase: InterceptPhase;
  readonly scope: RuntimeScope;
  readonly identity: LogicalIdentity;
  /** The request input (before) or the handler output (after) the first interceptor sees. */
  readonly value: PlainData;
  /** Judges a proposal against the value the proposing interceptor saw. */
  judge(current: PlainData, proposal: InterceptProposal): Judgement;
};

export type InterceptionResult = { readonly value: PlainData; readonly shortCircuit: boolean };

/**
 * Ordered interceptors, supplied by the caller. The runtime names no plugin: it only asks whether a phase of an
 * operation has interceptors, then runs them in order. An implementation applies its own failure policy and
 * returns the value unchanged for an interceptor that fails.
 */
export interface InterceptorChain {
  has(operationId: string, phase: InterceptPhase): boolean;
  run(call: InterceptionCall): Promise<InterceptionResult>;
}
