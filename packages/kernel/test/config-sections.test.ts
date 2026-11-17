import { CONFIG_SECTIONS, type ConfigSection, type TSchema } from '@nodeint/migent-contracts';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { configSectionIssues, mergeConfigLayers } from '../src/index.ts';

const schema = (value: object): TSchema => value as TSchema;

/** A test-only registration: the production list stays empty and has no registration API. */
const registered = CONFIG_SECTIONS as ConfigSection[];
const production = [...CONFIG_SECTIONS];
const restoreProduction = (): void => { registered.splice(0, registered.length, ...production); };
beforeEach(() => {
  registered.push(
    { key: 'deepsec', merge: 'deep', freeze: 'frozen', schema: schema({ type: 'object', properties: { enabled: { type: 'boolean' }, name: { type: 'string' } }, required: ['enabled'], additionalProperties: false }) },
    { key: 'replacesec', merge: 'replace', freeze: 'frozen', schema: schema({ type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } }) },
  );
});
afterEach(() => { restoreProduction(); });

test('a deep section merges like any mapping and is owned by both layers', () => {
  const merged = mergeConfigLayers({ deepsec: { enabled: true } }, { deepsec: { name: 'x' } });
  expect(merged.config.deepsec).toEqual({ enabled: true, name: 'x' });
  expect(merged.ownerOf(['deepsec'])).toBe('merged');
  expect(merged.ownerOf(['deepsec', 'enabled'])).toBe('project');
  expect(merged.ownerOf(['deepsec', 'name'])).toBe('local');
});

test('a replace section declared by the local layer replaces the project one wholesale', () => {
  const merged = mergeConfigLayers({ replacesec: { a: 1 } }, { replacesec: { b: 2 } });
  expect(merged.config.replacesec).toEqual({ b: 2 });
  expect(merged.ownerOf(['replacesec', 'b'])).toBe('local');
  expect(merged.ownerOf(['replacesec'])).toBe('local');
});

test('a replace section the local layer omits keeps the project value', () => {
  const merged = mergeConfigLayers({ replacesec: { a: 1 } }, { deepsec: { enabled: true } });
  expect(merged.config.replacesec).toEqual({ a: 1 });
  expect(merged.ownerOf(['replacesec', 'a'])).toBe('project');
});

test('validation runs on the merged section with the layer that owns each path', () => {
  const merged = mergeConfigLayers({ deepsec: { enabled: true } }, { deepsec: { enabled: 'yes', extra: 1 } });
  const issues = configSectionIssues(merged.config);
  expect(issues.map((issue) => [issue.code, issue.path])).toEqual([
    ['unknown-key', ['deepsec', 'extra']],
    ['missing-or-invalid', ['deepsec', 'enabled']],
  ]);
  for (const issue of issues) expect(merged.ownerOf(issue.path ?? [])).toBe('local');
});

test('a missing required field is reported at its own path, one error per field', () => {
  registered.push({
    key: 'needs', merge: 'deep', freeze: 'frozen',
    schema: schema({
      type: 'object',
      properties: { a: { type: 'boolean' }, b: { type: 'string' }, inner: { type: 'object', properties: { c: { type: 'number' } }, required: ['c'] } },
      required: ['a', 'b', 'inner'],
    }),
  });
  expect(configSectionIssues({ needs: {} }).map((issue) => issue.path)).toEqual([['needs', 'a'], ['needs', 'b'], ['needs', 'inner']]);
  expect(configSectionIssues({ needs: { a: true, b: 'x', inner: {} } }).map((issue) => issue.path)).toEqual([['needs', 'inner', 'c']]);
});

test('an absent section and an unregistered key give no issue', () => {
  expect(configSectionIssues({})).toEqual([]);
  expect(configSectionIssues({ plugins: { anything: true } })).toEqual([]);
});

test('the merge is unchanged when nothing is registered', () => {
  restoreProduction();
  const merged = mergeConfigLayers({ plugins: { a: { x: 1 } } }, { plugins: { a: { y: 2 } } });
  expect(merged.config.plugins).toEqual({ a: { x: 1, y: 2 } });
  expect(configSectionIssues(merged.config)).toEqual([]);
});
