import { expect, test } from 'vitest';

import { CONFIG_SECTIONS, isValid, PLUGIN_EVENTS, PluginIntent, PLUGINS_SECTION, SESSION_EVENTS } from '../src/index.ts';

test('plugin events are registered, and the section is defined but not registered yet', () => {
  const names = SESSION_EVENTS.map((entry) => entry.event);
  for (const name of Object.keys(PLUGIN_EVENTS)) expect(names).toContain(name);
  expect(CONFIG_SECTIONS).not.toContain(PLUGINS_SECTION);
});

test('the intent union is closed', () => {
  expect(isValid(PluginIntent, { kind: 'none' })).toBe(true);
  expect(isValid(PluginIntent, { kind: 'output', name: 'a.md', content: 'x', media_type: 'text/markdown' })).toBe(true);
  expect(isValid(PluginIntent, { kind: 'delete', name: 'a' })).toBe(false);
});

test('the plugins section accepts any entry value', () => {
  expect(PLUGINS_SECTION).toMatchObject({ key: 'plugins', merge: 'deep', freeze: 'per_entry' });
  expect(isValid(PLUGINS_SECTION.schema, { a: null, b: 5, c: { x: 1 } })).toBe(true);
});
