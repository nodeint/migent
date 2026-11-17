import { isValid, PLUGIN_EVENTS } from '@nodeint/migent-contracts';
import { expect, test } from 'vitest';

const at = { timestamp: '2026-01-01T00:00:00.000Z' };

test('plugin.hook_invoked records validate against the registered schema', () => {
  const record = {
    ...at, event: 'plugin.hook_invoked',
    data: { plugin: 'a', version: '1.0.0', hook: 'session.started', trigger_seq: 1, invocation_id: 'i1', advisory: false },
  };
  expect(isValid(PLUGIN_EVENTS['plugin.hook_invoked'], record)).toBe(true);
});

test('plugin.decision records validate against the registered schema', () => {
  const record = {
    ...at, event: 'plugin.decision',
    data: {
      plugin: 'a', invocation_id: 'i1', proposed: [{ kind: 'none' }],
      results: [{ kind: 'output', status: 'applied', path: 'plugins/a/x.md', sha256: 'abc' }],
    },
  };
  expect(isValid(PLUGIN_EVENTS['plugin.decision'], record)).toBe(true);
});

test('plugin.failed records validate and reject an unknown reason', () => {
  const data = { plugin: 'a', invocation_id: 'i1', reason: 'timeout', error: 'late', on_error: 'stop' };
  expect(isValid(PLUGIN_EVENTS['plugin.failed'], { ...at, event: 'plugin.failed', data })).toBe(true);
  expect(isValid(PLUGIN_EVENTS['plugin.failed'], { ...at, event: 'plugin.failed', data: { ...data, reason: 'boom' } })).toBe(false);
});

test('plugins.frozen records validate against the registered schema', () => {
  const record = {
    ...at, event: 'plugins.frozen',
    data: { freeze_hash: 'h', plugins: [{ id: 'a', enabled: true, advisory: false, version: '1.0.0', target: null }] },
  };
  expect(isValid(PLUGIN_EVENTS['plugins.frozen'], record)).toBe(true);
});
