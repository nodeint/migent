import type { ExtensionCatalog } from '@nodeint/migent-contracts';
import { parseWorkflowMapping } from '@nodeint/migent-workflow';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

import { renderWorkflowSource } from '../src/session-freeze.ts';

// TypeBox schemas are plain JSON Schema objects.
const object = (properties: Record<string, unknown>): never => {
  const schema: Record<string, unknown> = { type: 'object', properties, required: [] };
  return schema as never;
};
const catalog: ExtensionCatalog = [{
  plugin: 'fixture',
  version: 1,
  fields: { workflow: object({ fixture_flow: { type: 'string' } }), stage: object({ fixture_stage: { type: 'object' } }) },
}];

test('renderWorkflowSource writes claimed keys flat and they round-trip', () => {
  const source = {
    schema_version: 7,
    id: 'flow',
    fixture_flow: 'x',
    stages: [{ id: 'a', role: 'dev', depends_on: [], fixture_stage: { mode: 'fast' } }],
  };
  const text = renderWorkflowSource(parseWorkflowMapping(source, 'flow.yaml', { extensions: catalog }));
  const written = parse(text) as Record<string, unknown> & { stages: Record<string, unknown>[] };
  expect(written.fixture_flow).toBe('x');
  expect(written.stages[0].fixture_stage).toEqual({ mode: 'fast' });
  expect(Object.keys(written).slice(-1)).toEqual(['fixture_flow']);
  const back = parseWorkflowMapping(written, 'frozen.yaml', { extensions: catalog });
  expect(back.extensions).toEqual({ fixture: { fixture_flow: 'x' } });
  expect(back.stages.a.extensions).toEqual({ fixture: { fixture_stage: { mode: 'fast' } } });
});
