import { expect, test } from 'vitest';

import { type ConfigLoad, validateConfigDraft, validateWorkflowDraft } from '../src/authoring.ts';
import { analyzeConfig, validateConfigLayers } from '../src/config-check.ts';
import { defaultClients } from './support.ts';

type Mapping = Record<string, unknown>;
type Extensions = NonNullable<Parameters<typeof analyzeConfig>[2]['extensions']>;

// TypeBox schemas are plain JSON Schema objects; the fixture builds them without the typebox dependency.
const object = (properties: Mapping, required: string[]): never => {
  const schema: Mapping = { type: 'object', properties, required };
  return schema as never;
};

const catalog = [
  {
    plugin: 'fixture',
    version: 1,
    fields: {
      agent: object({ fixture_agent: object({ mode: { type: 'string' } }, ['mode']) }, []),
      role: object({ fixture_role: object({ mode: { type: 'string' } }, ['mode']) }, []),
    },
  },
] as unknown as Extensions;

const analyze = (config: Mapping, extensions?: Extensions) =>
  analyzeConfig(config, defaultClients(), {
    effortChecks: {},
    ownerOf: () => 'project',
    ...(extensions === undefined ? {} : { extensions }),
  }).diagnostics.items;

const config = (overrides: { agent?: unknown; role?: unknown; inline?: unknown } = {}): Mapping => ({
  schema_version: 8,
  agents: { named: { client: { type: 'codex' }, model: 'm', fixture_agent: overrides.agent ?? { mode: 'a' } } },
  roles: {
    dev: { agent: 'named', fixture_role: overrides.role ?? { mode: 'r' } },
    inline: { agent: { client: { type: 'codex' }, model: 'i', fixture_agent: overrides.inline ?? { mode: 'i' } } },
  },
});

test('valid claimed keys on a named agent, an inline agent and a role add no diagnostic', () => {
  expect(analyze(config(), catalog)).toEqual([]);
});

test('invalid claimed keys are all reported in one run, at their author paths', () => {
  const errors = analyze(config({ agent: { mode: 1 }, role: {} }), catalog).filter((item) => item.severity === 'error');
  expect(errors.map((item) => item.path)).toEqual([
    ['agents', 'named', 'fixture_agent', 'mode'],
    ['roles', 'dev', 'fixture_role', 'mode'],
  ]);
});

test('an unclaimed role key is a warning and an unclaimed agent key is accepted', () => {
  const items = analyze(config(), undefined);
  expect(items.filter((item) => item.severity === 'error')).toEqual([]);
  expect(items.filter((item) => item.severity === 'warning').map((item) => item.path)).toEqual([
    ['roles', 'dev', 'fixture_role'],
  ]);
});

test('a disabled plugin is still validated', () => {
  const disabled = { ...config({ agent: { mode: 1 } }), plugins: { fixture: { enabled: false } } };
  expect(analyze(disabled, catalog).filter((item) => item.severity === 'error')).toHaveLength(1);
  expect(analyze({ ...config(), plugins: { fixture: { enabled: false } } }, catalog)).toEqual([]);
});

const draftOf = (overrides: Parameters<typeof config>[0] = {}) => ({
  scope: 'project' as const,
  draft: config(overrides),
  companion: null,
});
const errorPaths = (items: ReturnType<typeof validateConfigDraft>) =>
  items.filter((item) => item.severity === 'error').map((item) => item.path);

test('config draft validation reports every invalid claimed key with its path and layer', () => {
  const clean = validateConfigDraft(draftOf(), defaultClients(), catalog);
  expect(clean.filter((item) => item.severity === 'error')).toEqual([]);
  const items = validateConfigDraft(
    draftOf({ agent: { mode: 1 }, role: {}, inline: { mode: 2 } }),
    defaultClients(),
    catalog,
  );
  expect(errorPaths(items)).toEqual([
    ['agents', 'named', 'fixture_agent', 'mode'],
    ['roles', 'dev', 'fixture_role', 'mode'],
    ['roles', 'inline', 'agent', 'fixture_agent', 'mode'],
  ]);
  expect(items.filter((item) => item.severity === 'error').every((item) => item.source?.layer === 'project')).toBe(true);
});

test('config draft validation attributes a local-layer override to the local layer', () => {
  const local = { schema_version: 8, agents: { named: { fixture_agent: { mode: 5 } } } };
  const items = validateConfigDraft({ scope: 'local', draft: local, companion: config() }, defaultClients(), catalog);
  const errors = items.filter((item) => item.severity === 'error');
  expect(errors.map((item) => item.path)).toEqual([['agents', 'named', 'fixture_agent', 'mode']]);
  expect(errors[0]?.source).toEqual({ layer: 'local' });
});

test('layer validation forwards the catalog', () => {
  const layers = { project: config({ agent: { mode: 1 } }) };
  expect(errorPaths(validateConfigLayers({ ...layers, extensions: catalog }, defaultClients()))).toEqual([
    ['agents', 'named', 'fixture_agent', 'mode'],
  ]);
  expect(errorPaths(validateConfigLayers(layers, defaultClients()))).toEqual([]);
});

const workflow = (agent: Mapping): Mapping => ({
  schema_version: 8,
  id: 'flow',
  stages: [{ id: 'a', role: 'dev', depends_on: [], agent: { client: { type: 'codex' }, model: 'm', ...agent } }],
});

test('workflow draft validation reports an invalid inline stage agent key at its author path', () => {
  const loaded: ConfigLoad = {
    config: config(),
    ownerOf: () => 'project',
    layers: { project: config(), local: null },
  };
  const input = {
    draft: workflow({ fixture_agent: { mode: 3 } }),
    file: 'flow.yaml',
    siblings: [],
    config: loaded,
  };
  const items = validateWorkflowDraft(input, defaultClients(), catalog);
  const paths = items.filter((item) => item.severity === 'error').map((item) => item.path);
  expect(paths).toContainEqual(['stages', 0, 'agent', 'fixture_agent', 'mode']);
  expect(validateWorkflowDraft({ ...input, draft: workflow({ fixture_agent: { mode: 'ok' } }) }, defaultClients(), catalog)
    .filter((item) => item.severity === 'error')).toEqual([]);
});
