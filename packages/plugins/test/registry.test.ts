import { type Plugin, type TSchema } from '@nodeint/migent-contracts';
import { expect, test } from 'vitest';

import { createPluginRegistry } from '../src/index.ts';

const plugin = (id: string, apiVersion = { major: 1, minor: 0 }): Plugin => ({
  manifest: {
    id, version: '1.0.0', apiVersion, advisory: false,
    uses: { operations: [], events: [], session: [], artifacts: [], agents: false, config: [] },
    configSchema: { type: 'object' } as unknown as TSchema,
  },
  activate: () => undefined,
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

test('an unsupported apiVersion is refused: another major or a greater minor', () => {
  expect(() => createPluginRegistry([plugin('a', { major: 2, minor: 0 })])).toThrow(/needs plugin API 2\.0/);
  expect(() => createPluginRegistry([plugin('a', { major: 1, minor: 1 })])).toThrow(/needs plugin API 1\.1/);
  expect(() => createPluginRegistry([plugin('a', { major: 0, minor: 0 })])).toThrow(/needs plugin API 0\.0/);
});
