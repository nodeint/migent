import { SESSION_EVENT_SCHEMAS } from './session-events.js';

/** How core treats one event kind. Read-only; derived from the event catalog. */
export interface EventKindTraits {
  /** Written to the execution's `stream.jsonl` when the record carries an execution id. */
  readonly stream: boolean;
  /** Triggers a `status.json` fold after the record is appended. */
  readonly folds: boolean;
  /** Appended, but never folded into `status.json`. */
  readonly skipsStatusWrite: boolean;
  /** Reported on stderr by the engine's provider-event reporter. */
  readonly stderr: boolean;
}

const STREAM_PREFIX = 'provider.item_';
const STREAM_KINDS: ReadonlySet<string> = new Set(['provider.heartbeat']);

const FOLDING_KINDS: ReadonlySet<string> = new Set([
  'provider.stage_started',
  'provider.turn_completed',
  'provider.turn_failed',
  'provider.quota',
  'provider.cancelled',
  'provider.error',
  'provider.warning',
  'provider.heartbeat',
  'verify.started',
  'verify.heartbeat',
  'verify.failed',
  'verify.passed',
]);

const SKIPS_STATUS_WRITE_KINDS: ReadonlySet<string> = new Set(['provider.heartbeat', 'verify.heartbeat']);

const STDERR_KINDS: ReadonlySet<string> = new Set([
  'provider.turn_failed',
  'provider.quota',
  'provider.error',
  'provider.warning',
  'provider.cancelled',
  'verify.failed',
]);

function traitsFor(kind: string): EventKindTraits {
  return Object.freeze({
    stream: STREAM_KINDS.has(kind) || kind.startsWith(STREAM_PREFIX),
    folds: FOLDING_KINDS.has(kind),
    skipsStatusWrite: SKIPS_STATUS_WRITE_KINDS.has(kind),
    stderr: STDERR_KINDS.has(kind),
  });
}

const NO_TRAITS: EventKindTraits = traitsFor('');

/** Traits of every kind in `SESSION_EVENT_SCHEMAS`. The set of kinds is closed. */
export const EVENT_KIND_TRAITS: ReadonlyMap<string, EventKindTraits> = new Map(
  SESSION_EVENT_SCHEMAS.map((entry) => [entry.event, traitsFor(entry.event)]),
);

/** Traits of `kind`. An unregistered kind follows the stream-name rule and has no other trait. */
export function eventKindTraits(kind: string): EventKindTraits {
  return EVENT_KIND_TRAITS.get(kind) ?? (kind.startsWith(STREAM_PREFIX) ? traitsFor(kind) : NO_TRAITS);
}
