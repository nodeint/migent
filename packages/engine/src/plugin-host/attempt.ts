import type { AgentCaller } from './agent-call.js';
import type { PluginFailure } from './holds.js';

/** A failed invocation. */
export type Failure = { readonly kind: 'fail'; readonly reason: PluginFailure['reason']; readonly error: string };

/** One run of a handler. `stale` means the core discarded its proposals because the facts it read changed. */
export interface Attempt {
  readonly failure: Failure | null;
  readonly stale: boolean;
  /** Every call and note of this invocation so far, earlier attempts included. */
  readonly calls: readonly unknown[];
  readonly notes: readonly unknown[];
  /** The highest agent call index issued, so a retry continues the numbering. */
  readonly issued: number;
}

export const FIRST_ATTEMPT: Attempt = { failure: null, stale: false, calls: [], notes: [], issued: 0 };

export const STALE_FAILURE: Failure = {
  kind: 'fail', reason: 'stale', error: 'The facts the handler read changed again; its proposals were discarded.',
};

/** A failed outcome, or the `unavailable` failure when the agent target could not be bound. */
export function failureOf(outcome: Failure, caller: AgentCaller | null): Failure {
  const unavailable = caller?.unavailable;
  return unavailable !== null && unavailable !== undefined && outcome.reason === 'error'
    ? { kind: 'fail', reason: 'unavailable', error: unavailable }
    : outcome;
}
