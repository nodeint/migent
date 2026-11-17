import { type Plugin, type TSchema } from '@nodeint/migent-contracts';
import { expect, test } from 'vitest';

import { createPluginRegistry } from '../src/index.ts';

const plugin = (id: string): Plugin => ({
  manifest: { id, version: '1.0.0', advisory: false, hooks: [], capabilities: [], configSchema: { type: 'object' } as unknown as TSchema },
  handlers: {},
});

test('the first-party registry is empty', () => {
  expect(createPluginRegistry().ids()).toEqual([]);
});

test('an injected registry resolves plugins by id, sorted', () => {
  const registry = createPluginRegistry([plugin('b'), plugin('a')]);
  expect(registry.ids()).toEqual(['a', 'b']);
  expect(registry.get('a')?.manifest.id).toBe('a');
  expect(registry.get('zzz')).toBeUndefined();
});

test('a duplicate id is rejected', () => {
  expect(() => createPluginRegistry([plugin('a'), plugin('a')])).toThrow(/twice/);
});
