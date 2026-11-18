import { expect, test } from 'vitest';

import { eventKindTraits } from '../src/index.ts';

test('an unregistered kind has no trait except the item-stream name rule', () => {
  expect(eventKindTraits('plugin.something')).toEqual({ stream: false, folds: false, skipsStatusWrite: false, stderr: false });
  expect(eventKindTraits('provider.item_other').stream).toBe(true);
});
