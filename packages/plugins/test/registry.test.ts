import { type Plugin, type TObject, type TSchema } from '@nodeint/migent-contracts';
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
  expect(() => createPluginRegistry([plugin('a', { major: 1, minor: 2 })])).toThrow(/needs plugin API 1\.2/);
  expect(() => createPluginRegistry([plugin('a', { major: 0, minor: 0 })])).toThrow(/needs plugin API 0\.0/);
});

const extension = { plugin: 'a', version: 1, fields: { stage: { type: 'object', properties: { a_key: { type: 'string' } } } as unknown as TObject } };
const withExtensions = (id: string, extensions: unknown): Plugin => {
  const base = plugin(id);
  return { ...base, manifest: { ...base.manifest, extensions: extensions as never } };
};

test('a manifest whose extensions match its catalog entry is accepted', () => {
  expect(createPluginRegistry([withExtensions('a', extension)], [extension]).ids()).toEqual(['a']);
});

test('a manifest whose extensions differ from its catalog entry is rejected', () => {
  expect(() => createPluginRegistry([withExtensions('a', { ...extension, version: 2 })], [extension])).toThrow(/must declare the extensions/);
});

test('a manifest that omits extensions while the catalog has an entry is rejected', () => {
  expect(() => createPluginRegistry([plugin('a')], [extension])).toThrow(/must declare the extensions/);
});

test('a manifest that declares extensions the catalog does not list is rejected', () => {
  expect(() => createPluginRegistry([withExtensions('a', extension)], [])).toThrow(/does not list/);
});
