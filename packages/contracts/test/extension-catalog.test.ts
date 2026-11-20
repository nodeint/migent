import Type from 'typebox';
import { expect, test } from 'vitest';

import {
  type ExtensionCatalog,
  extensionCatalogIssues,
  extensionKeys,
  extensionOwner,
  isValid,
  STAGE_CORE_PROPERTIES,
  withExtensionProperties,
} from '../src/index.ts';

const fixture: ExtensionCatalog = [
  {
    plugin: 'fixture',
    version: 1,
    fields: {
      workflow: Type.Object({ fixture_flow: Type.String() }),
      stage: Type.Object({ fixture_stage: Type.Object({ mode: Type.String(), retries: Type.Integer() }) }),
    },
  },
];

const withStageKey = (key: string, plugin = 'fixture'): ExtensionCatalog => [
  { plugin, version: 1, fields: { stage: Type.Object({ [key]: Type.String() }) } },
];

test('a valid catalog has no issues', () => {
  expect(extensionCatalogIssues(fixture)).toEqual([]);
});

test('a duplicate plugin id is reported', () => {
  expect(extensionCatalogIssues([...fixture, ...fixture]).join('\n')).toMatch(/more than one extension entry/);
});

test('a key that breaks the pattern is reported', () => {
  expect(extensionCatalogIssues(withStageKey('Bad-Key')).join('\n')).toMatch(/must match/);
});

test('a key claimed twice on one level is reported, and the same key on another level is allowed', () => {
  const twice = [...withStageKey('shared'), ...withStageKey('shared', 'other')];
  expect(extensionCatalogIssues(twice).join('\n')).toMatch(/claimed twice/);
  const otherLevel: ExtensionCatalog = [
    ...withStageKey('shared'),
    { plugin: 'other', version: 1, fields: { workflow: Type.Object({ shared: Type.String() }) } },
  ];
  expect(extensionCatalogIssues(otherLevel)).toEqual([]);
});

test('a core key is reported', () => {
  expect(extensionCatalogIssues(withStageKey('verify')).join('\n')).toMatch(/core stage key "verify"/);
});

test('a legacy key is reported', () => {
  expect(extensionCatalogIssues(withStageKey('produces')).join('\n')).toMatch(/legacy stage key "produces"/);
});

test('keys and owners are looked up per level', () => {
  expect(extensionKeys(fixture, 'stage')).toEqual(['fixture_stage']);
  expect(extensionKeys(fixture, 'role')).toEqual([]);
  expect(extensionOwner(fixture, 'workflow', 'fixture_flow')).toBe('fixture');
  expect(extensionOwner(fixture, 'stage', 'fixture_flow')).toBeUndefined();
});

test('composed stage properties accept the claimed key and keep the schema closed', () => {
  const schema = Type.Object(withExtensionProperties(STAGE_CORE_PROPERTIES, fixture, 'stage'), { additionalProperties: false });
  expect(isValid(schema, { id: 'a', fixture_stage: { mode: 'x', retries: 1 } })).toBe(true);
  expect(isValid(schema, { id: 'a', fixture_stage: { mode: 'x' } })).toBe(false);
  expect(isValid(schema, { id: 'a', unclaimed: 1 })).toBe(false);
});

const withResponseKey = (key: string, plugin = 'fixture'): ExtensionCatalog => [
  { plugin, version: 1, fields: { response: Type.Object({ [key]: Type.Object({ verdict: Type.String() }) }) } },
];

test('a response entry keyed by its plugin id is valid', () => {
  expect(extensionCatalogIssues(withResponseKey('fixture'))).toEqual([]);
  expect(extensionKeys(withResponseKey('fixture'), 'response')).toEqual(['fixture']);
  expect(extensionOwner(withResponseKey('fixture'), 'response', 'fixture')).toBe('fixture');
});

test('a response field with no property is reported', () => {
  const empty: ExtensionCatalog = [{ plugin: 'fixture', version: 1, fields: { response: Type.Object({}) } }];
  expect(extensionCatalogIssues(empty).join(' ')).toMatch(/exactly one property/);
});

test('a response key that differs from the plugin id is reported', () => {
  expect(extensionCatalogIssues(withResponseKey('other_key')).join('\n')).toMatch(/response key "other_key" must equal the plugin id/);
});

test.each(['status', 'decision', 'summary', 'blocker', 'questions', 'schema_version'])(
  'a plugin whose id is the core handoff key %s is reported',
  (key) => {
    expect(extensionCatalogIssues(withResponseKey(key, key)).join('\n')).toMatch(/core response key/);
  },
);

test('a plugin whose id is the reserved key response_extensions is reported', () => {
  expect(extensionCatalogIssues(withResponseKey('response_extensions', 'response_extensions')).join('\n')).toMatch(/legacy response key|reserved/);
});
