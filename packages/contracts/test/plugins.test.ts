import { expect, test } from 'vitest';

import { CONFIG_SECTIONS, isValid, PLUGIN_EVENTS, PluginAfterProposal, PluginBeforeProposal, PluginEventProposal, PLUGINS_SECTION, SESSION_EVENTS } from '../src/index.ts';

test('plugin events are registered, and the section is registered', () => {
  const names = SESSION_EVENTS.map((entry) => entry.event);
  for (const name of Object.keys(PLUGIN_EVENTS)) expect(names).toContain(name);
  expect(CONFIG_SECTIONS).toContain(PLUGINS_SECTION);
});

test('the proposal unions are closed', () => {
  expect(isValid(PluginEventProposal, { kind: 'none' })).toBe(true);
  expect(isValid(PluginEventProposal, { kind: 'artifact', name: 'a.md', content: 'x' })).toBe(true);
  expect(isValid(PluginEventProposal, { kind: 'output', name: 'a.md', content: 'x', media_type: 'text/markdown' })).toBe(false);
  expect(isValid(PluginEventProposal, { kind: 'delete', name: 'a' })).toBe(false);
  expect(isValid(PluginBeforeProposal, { kind: 'short_circuit', output: { a: 1 } })).toBe(true);
  expect(isValid(PluginBeforeProposal, { kind: 'patch', fields: { prompt: 'x' } })).toBe(true);
  expect(isValid(PluginAfterProposal, { kind: 'short_circuit', output: {} })).toBe(false);
  expect(isValid(PluginAfterProposal, { kind: 'continue' })).toBe(true);
});

test('the plugins section accepts any entry value', () => {
  expect(PLUGINS_SECTION).toMatchObject({ key: 'plugins', merge: 'deep', freeze: 'per_entry' });
  expect(isValid(PLUGINS_SECTION.schema, { a: null, b: 5, c: { x: 1 } })).toBe(true);
});
