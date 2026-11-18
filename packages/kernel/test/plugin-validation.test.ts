import { type PluginManifest, type TSchema } from '@nodeint/migent-contracts';
import { describe, expect, test } from 'vitest';

import { pluginEntryIssues } from '../src/index.ts';

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  id: 'demo', version: '1.0.0', apiVersion: { major: 1, minor: 0 }, advisory: false,
  uses: { operations: [], events: ['session.started'], session: [], artifacts: [], agents: false, config: [] },
  configSchema: { type: 'object', properties: { mode: { type: 'string' } } } as unknown as TSchema, ...over,
});
const manifests = (...items: PluginManifest[]) => new Map<string, unknown>(items.map((item) => [item.id, item]));
const codes = (plugins: unknown, registered = manifests(manifest())) =>
  pluginEntryIssues({ plugins, manifests: registered }).map((issue) => issue.code);

describe('pluginEntryIssues', () => {
  test('no plugins key validates nothing', () => {
    expect(codes(undefined, manifests())).toEqual([]);
  });

  test('an empty section and an enabled registered entry are valid', () => {
    expect(codes({})).toEqual([]);
    expect(codes({ demo: { mode: 'x' } })).toEqual([]);
  });

  test('invalid shared fields are reported', () => {
    expect(codes({ demo: { on_error: 'explode' } })).not.toEqual([]);
    expect(codes({ demo: { timeout_sec: -1 } })).not.toEqual([]);
    expect(codes({ demo: { enabled: 'yes' } })).not.toEqual([]);
  });

  test('plugin-specific fields are checked against the manifest schema', () => {
    expect(codes({ demo: { mode: 5 } })).not.toEqual([]);
  });

  test('a uses.agents plugin requires the shared LLM fields', () => {
    const llm = manifest({
      uses: { operations: [], events: [], session: [], artifacts: [], agents: true, config: [] },
    });
    expect(codes({ demo: {} }, manifests(llm))).not.toEqual([]);
    expect(codes({ demo: { agent: 'writer' } }, manifests(llm))).toEqual([]);
  });

  test('invalid manifest fields are reported', () => {
    expect(codes({ demo: {} }, manifests(manifest({ version: 'one' })))).toEqual(['plugin-manifest-invalid']);
    expect(codes({ demo: {} }, manifests(manifest({ apiVersion: 'nope' as never })))).toEqual(['plugin-manifest-invalid']);
    expect(codes({ demo: {} }, new Map([['demo', { id: 'other' }]]))).toEqual(['plugin-manifest-invalid']);
  });

  test('an unregistered enabled id is reported', () => {
    expect(codes({ ghost: {} })).toEqual(['plugin-unregistered']);
  });

  test('a scalar or null entry counts as enabled and invalid', () => {
    expect(codes({ demo: 5 })).not.toEqual([]);
    expect(codes({ demo: null })).not.toEqual([]);
    expect(codes({ ghost: null })).toEqual(['plugin-unregistered']);
  });

  test('an unregistered entry with enabled: false is not checked', () => {
    expect(codes({ ghost: { enabled: false, anything: 1 } })).toEqual([]);
    expect(codes({ demo: { enabled: false, mode: 5 } })).toEqual([]);
  });

  test('a non-mapping section is reported', () => {
    expect(codes(['demo'])).toEqual(['plugins-invalid']);
    expect(codes(null)).toEqual(['plugins-invalid']);
  });

  test('a malformed manifest config schema is reported, not accepted silently', () => {
    for (const configSchema of [
      { type: 'bogus' }, { type: 'object', properties: 5 }, { $ref: '#/nope' }, [], 'x', null,
      { type: 'string', pattern: '(' }, { type: 'string', pattern: 5 },
      { type: 'object', patternProperties: { '[': { type: 'string' } } },
      { type: 'number', minimum: 'a' }, { type: 'string', minLength: '2' }, { type: 'array', maxItems: -Infinity },
      { type: 'string', format: 5 }, { type: 'array', uniqueItems: 'yes' },
    ]) {
      const bad = manifest({ configSchema: configSchema as never });
      expect(codes({ demo: {} }, manifests(bad))).toEqual(['plugin-manifest-invalid']);
    }
  });

  test('versions must be strict semver', () => {
    for (const version of ['1.0', '01.0.0', '1.0.0-', '1.0.0-01', '1.0.0+', 'v1.0.0', '1.0.0.0']) {
      expect(codes({ demo: {} }, manifests(manifest({ version })))).toEqual(['plugin-manifest-invalid']);
    }
    for (const version of ['0.0.0', '1.2.3', '1.2.3-alpha.1', '1.2.3-0.x-y', '1.2.3+build.5', '1.2.3-rc.1+b']) {
      expect(codes({ demo: {} }, manifests(manifest({ version })))).toEqual([]);
    }
  });

  test('diagnostic paths keep the plugin id and field as separate segments', () => {
    const [issue] = pluginEntryIssues({ plugins: { my_plugin: { mode: 5 } }, manifests: manifests(manifest({ id: 'my_plugin' })) });
    expect(issue?.path).toEqual(['plugins', 'my_plugin', 'mode']);
    const [shared] = pluginEntryIssues({ plugins: { demo: { on_error: 'x' } }, manifests: manifests(manifest()) });
    expect(shared?.path).toEqual(['plugins', 'demo', 'on_error']);
    const [missing] = pluginEntryIssues({ plugins: { 'my.ghost': {} }, manifests: manifests() });
    expect(missing?.path).toEqual(['plugins', 'my.ghost']);
  });
});
