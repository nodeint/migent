import Type from 'typebox';
import { expect, test } from 'vitest';

import { assertConfigSections, CONFIG_SECTIONS, type ConfigSection } from '../src/index.ts';

const section = (key: string): ConfigSection => ({ key, schema: Type.Object({}), merge: 'deep', freeze: 'frozen' });

test('only the plugins section is registered in production', () => {
  expect(CONFIG_SECTIONS.map((entry) => entry.key)).toEqual(['plugins']);
});

test('a valid list passes', () => {
  expect(() => { assertConfigSections([section('plugins'), section('git_flow')]); }).not.toThrow();
});

test.each(['Plugins', '1plugins', 'my-plugin', '', 'a.b'])('the key pattern rejects %j', (key) => {
  expect(() => { assertConfigSections([section(key)]); }).toThrow(/must match/);
});

test.each(['schema_version', 'agents', 'roles', 'resume_policies', 'models'])('a core or legacy key is rejected: %s', (key) => {
  expect(() => { assertConfigSections([section(key)]); }).toThrow(/core or legacy/);
});

test('a duplicate key is rejected', () => {
  expect(() => { assertConfigSections([section('plugins'), section('plugins')]); }).toThrow(/twice/);
});
