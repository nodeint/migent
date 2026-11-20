import type { ExtensionCatalog, PluginExtension } from '@nodeint/migent-contracts';
import { expect, test } from 'vitest';

import { collectWorkflowDraft, parseWorkflowMapping, unknownWorkflowKeyEntries, withoutOwnedKeys } from '../src/index.ts';

type Mapping = Record<string, unknown>;
type Fields = PluginExtension['fields'];

// TypeBox schemas are plain JSON Schema objects; the workflow package does not depend on typebox.
const object = (properties: Mapping, required: string[]): never => {
  const schema: Mapping = { type: 'object', properties, required };
  return schema as never;
};

// The stage key itself is optional; its schema requires `mode`.
const catalog: ExtensionCatalog = [
  {
    plugin: 'fixture',
    version: 1,
    fields: {
      workflow: object({ fixture_flow: { type: 'string' } }, ['fixture_flow']),
      stage: object({
        fixture_stage: object({ mode: { type: 'string' }, retries: { type: 'integer' } }, ['mode']),
      }, []),
    } as unknown as Fields,
  },
];

const stage = (id: string, extra: Mapping = {}): Mapping => ({ id, role: 'dev', depends_on: [], ...extra });
const doc = (stages: Mapping[], extra: Mapping = {}): Mapping => ({ schema_version: 8, id: 'flow', stages, ...extra });
const options = { extensions: catalog };

test('the parser and the draft collector accept claimed keys and the model carries them', () => {
  const data = doc([stage('a', { fixture_stage: { mode: 'fast', retries: 2 } })], { fixture_flow: 'x' });
  const parsed = parseWorkflowMapping(data, 'flow.yaml', options);
  expect(parsed.extensions).toEqual({ fixture: { fixture_flow: 'x' } });
  expect(parsed.stages.a.extensions).toEqual({ fixture: { fixture_stage: { mode: 'fast', retries: 2 } } });
  const collected = collectWorkflowDraft(data, 'flow.yaml', options);
  expect(collected.problems).toEqual([]);
  expect(collected.document?.extensions).toEqual({ fixture: { fixture_flow: 'x' } });
});

test('a document without claimed keys has no extensions field', () => {
  const parsed = parseWorkflowMapping(doc([stage('a')]), 'flow.yaml', options);
  expect(parsed).not.toHaveProperty('extensions');
  expect(parsed.stages.a).not.toHaveProperty('extensions');
});

test('an invalid value is reported at its author path; the parser throws the first', () => {
  const data = doc([stage('a'), stage('b', { fixture_stage: { mode: 3, retries: 'x' } })], { fixture_flow: 4 });
  expect(() => parseWorkflowMapping(data, 'flow.yaml', options)).toThrowError(/fixture_flow/);
  const collected = collectWorkflowDraft(data, 'flow.yaml', options);
  expect(collected.document).toBeNull();
  expect(collected.problems.map((problem) => problem.path)).toEqual([
    ['fixture_flow'],
    ['stages', 1, 'fixture_stage', 'mode'],
    ['stages', 1, 'fixture_stage', 'retries'],
  ]);
});

test('a missing required field is reported at its own path', () => {
  const collected = collectWorkflowDraft(doc([stage('a', { fixture_stage: {} })]), 'flow.yaml', options);
  expect(collected.problems.map((problem) => problem.path)).toEqual([['stages', 0, 'fixture_stage', 'mode']]);
});

test('an unclaimed stage key is unknown at schema 5 and later, and a near miss suggests the claimed key', () => {
  const entries = unknownWorkflowKeyEntries(doc([stage('a', { fixture_stag: {} })]), catalog);
  expect(entries).toHaveLength(1);
  expect(entries[0].message).toContain('Did you mean stages.a.fixture_stage?');
  expect(() => parseWorkflowMapping(doc([stage('a', { fixture_stag: {} })]), 'flow.yaml', options)).toThrowError(/Unknown workflow keys/);
  expect(unknownWorkflowKeyEntries(doc([stage('a', { fixture_stage: {} })]), catalog)).toEqual([]);
});

test('below schema 5 an unclaimed stage key stays a warning', () => {
  const data = { schema_version: 4, id: 'flow', stages: [stage('a', { fixture_other: 1 })] };
  expect(parseWorkflowMapping(data, 'flow.yaml', options).warnings).toHaveLength(1);
});

test('without an explicit catalog the empty production catalog applies', () => {
  expect(() => parseWorkflowMapping(doc([stage('a')], { fixture_flow: 'x' }), 'flow.yaml')).toThrowError(/Unknown workflow keys/);
});

test('withoutOwnedKeys removes only the listed keys', () => {
  expect(withoutOwnedKeys({ a: 1, b: 2, c: 3 }, ['b'])).toEqual({ a: 1, c: 3 });
  expect(withoutOwnedKeys({ a: 1 }, [])).toEqual({ a: 1 });
});

test('an unreadable stage id does not hide the stage extension errors', () => {
  for (const id of [undefined, '', 7]) {
    const bad = { role: 'dev', depends_on: [], fixture_stage: { mode: 3 }, ...(id === undefined ? {} : { id }) };
    const paths = collectWorkflowDraft(doc([bad]), 'flow.yaml', options).problems.map((problem) => problem.path);
    expect(paths).toContainEqual(['stages', 0, 'id']);
    expect(paths).toContainEqual(['stages', 0, 'fixture_stage', 'mode']);
  }
});

test('claimed agent keys on an inline stage agent are validated, with every problem collected', () => {
  const agentCatalog: ExtensionCatalog = [
    {
      plugin: 'fixture',
      version: 1,
      fields: {
        agent: object({ fixture_agent: object({ mode: { type: 'string' }, retries: { type: 'integer' } }, ['mode']) }, []),
      } as unknown as Fields,
    },
  ];
  const inline = (agent: Mapping): Mapping => ({ client: { type: 'codex' }, model: 'm', ...agent });
  const data = doc([
    stage('a', { agent: inline({ fixture_agent: { mode: 3, retries: 'bad' } }), fixture_stage: 1 }),
    stage('b', { agent: 'named' }),
  ]);
  const opts = { extensions: agentCatalog };
  const paths = collectWorkflowDraft(data, 'flow.yaml', opts).problems.map((problem) => problem.path);
  // The unclaimed stage key is the stage's other invalid field; it does not hide the agent problems.
  expect(paths).toEqual([
    ['stages', 0, 'fixture_stage'],
    ['stages', 0, 'agent', 'fixture_agent', 'mode'],
    ['stages', 0, 'agent', 'fixture_agent', 'retries'],
  ]);
  const onlyAgent = doc([stage('a', { agent: inline({ fixture_agent: { mode: 3, retries: 'bad' } }) })]);
  expect(() => parseWorkflowMapping(onlyAgent, 'flow.yaml', opts)).toThrow(
    expect.objectContaining({ path: ['stages', 0, 'agent', 'fixture_agent', 'mode'] }) as Error,
  );
  const ok = doc([stage('a', { agent: inline({ fixture_agent: { mode: 'fast' }, unclaimed: 1 }) })]);
  expect(collectWorkflowDraft(ok, 'flow.yaml', opts).problems).toEqual([]);
  expect(parseWorkflowMapping(ok, 'flow.yaml', opts).stages.a.agent?.kind).toBe('inline');
});
