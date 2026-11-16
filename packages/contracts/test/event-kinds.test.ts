import { expect, test } from 'vitest';

import { EVENT_KIND_TRAITS, eventKindTraits, SESSION_EVENT_SCHEMAS } from '../src/index.ts';

/** The set that kernel and adapters kept before the registry. */
const FORMER_STATUS_PROVIDER_EVENTS = [
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
];

const FORMER_STDERR_EVENTS = [
  'provider.turn_failed',
  'provider.quota',
  'provider.error',
  'provider.warning',
  'provider.cancelled',
  'verify.failed',
];

test('the registry covers every session event kind', () => {
  for (const { event } of SESSION_EVENT_SCHEMAS) expect(EVENT_KIND_TRAITS.has(event), event).toBe(true);
  expect(EVENT_KIND_TRAITS.size).toBe(new Set(SESSION_EVENT_SCHEMAS.map((entry) => entry.event)).size);
});

test('folds is exactly the former STATUS_PROVIDER_EVENTS', () => {
  const folding = [...EVENT_KIND_TRAITS].filter(([, traits]) => traits.folds).map(([kind]) => kind);
  expect(folding.toSorted()).toEqual([...FORMER_STATUS_PROVIDER_EVENTS].toSorted());
});

test('stream, skipsStatusWrite and stderr keep their former rules', () => {
  const stream = [...EVENT_KIND_TRAITS].filter(([, traits]) => traits.stream).map(([kind]) => kind);
  expect(stream.toSorted()).toEqual(['provider.heartbeat', 'provider.item_completed', 'provider.item_started']);
  const skips = [...EVENT_KIND_TRAITS].filter(([, traits]) => traits.skipsStatusWrite).map(([kind]) => kind);
  expect(skips.toSorted()).toEqual(['provider.heartbeat', 'verify.heartbeat']);
  const stderr = [...EVENT_KIND_TRAITS].filter(([, traits]) => traits.stderr).map(([kind]) => kind);
  expect(stderr.toSorted()).toEqual([...FORMER_STDERR_EVENTS].toSorted());
});

test('an unregistered kind has no trait except the item-stream name rule', () => {
  expect(eventKindTraits('plugin.something')).toEqual({ stream: false, folds: false, skipsStatusWrite: false, stderr: false });
  expect(eventKindTraits('provider.item_other').stream).toBe(true);
});
