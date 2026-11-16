import { CONFIG_SECTIONS, type ConfigSection, type TSchema } from '@nodeint/migent-contracts';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { validateConfigLayers } from '../src/index.ts';
import { defaultClients } from './support.ts';

const schema = (value: object): TSchema => value as TSchema;
const registered = CONFIG_SECTIONS as ConfigSection[];
beforeEach(() => {
  registered.push({ key: 'deepsec', merge: 'deep', freeze: 'frozen', schema: schema({ type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'], additionalProperties: false }) });
});
afterEach(() => { registered.length = 0; });

const PROJECT = {
  schema_version: 7,
  agents: { x: { client: { type: 'codex' }, model: 'm' } },
  roles: { dev: { agent: 'x' } },
};

test('a registered section is validated and attributed to the layer that owns the bad path', () => {
  const diagnostics = validateConfigLayers(
    { project: { ...PROJECT, deepsec: { enabled: true } }, local: { deepsec: { enabled: 'yes' } } },
    defaultClients(),
  );
  const found = diagnostics.filter((item) => item.path?.[0] === 'deepsec');
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ severity: 'error', code: 'missing-or-invalid', path: ['deepsec', 'enabled'], source: { layer: 'local' } });
});

test('a valid section and an unregistered key add no diagnostic', () => {
  const clients = defaultClients();
  const plain = validateConfigLayers({ project: PROJECT }, clients);
  const withKeys = { ...PROJECT, deepsec: { enabled: true }, plugins: { a: 1 } };
  expect(validateConfigLayers({ project: withKeys }, clients)).toEqual(plain);
});

test('a missing required field of a section is reported at its own path', () => {
  const diagnostics = validateConfigLayers({ project: { ...PROJECT, deepsec: {} } }, defaultClients());
  const found = diagnostics.filter((item) => item.path?.[0] === 'deepsec');
  expect(found.map((item) => item.path)).toEqual([['deepsec', 'enabled']]);
});
