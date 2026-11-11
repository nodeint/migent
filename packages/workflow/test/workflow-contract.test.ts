import { readFileSync } from 'node:fs';

import { isValid,WorkflowDocumentInput, WorkflowStage } from '@nodeint/migent-contracts';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

import { parseWorkflowMapping } from '../src/index.ts';

const template = (name: string): Record<string, unknown> =>
  parse(readFileSync(new URL(`../../../templates/workflows/${name}.yaml`, import.meta.url), 'utf8'));

describe('workflow contract', () => {
  for (const name of ['plan', 'implement']) {
    test(`template ${name} matches`, () => {
      const doc = template(name);
      expect(isValid(WorkflowDocumentInput, doc)).toBe(true);
      for (const stage of doc.stages as unknown[]) expect(isValid(WorkflowStage, stage)).toBe(true);
    });
  }

  test('objects are closed', () => {
    expect(isValid(WorkflowDocumentInput, { schema_version: 7, bogus: 1 })).toBe(false);
    expect(isValid(WorkflowStage, { id: 'a', produces: {} })).toBe(false);
    expect(isValid(WorkflowStage, { id: 'a', run_when: { changed_paths: ['a'], x: 1 } })).toBe(false);
  });

  test('rejects wrong types', () => {
    expect(isValid(WorkflowStage, { id: 'a', depends_on: 'b' })).toBe(false);
    expect(isValid(WorkflowStage, { id: 'a', decision: [{ x: { navigate: 'complete' }, y: { navigate: 'a' } }] })).toBe(false);
    expect(isValid(WorkflowStage, { id: 'a', ask: 'bot' })).toBe(false);
  });

  test('stage contents are validated at document level', () => {
    const ok = { schema_version: 7, id: 'w', stages: [{ id: 'a', role: 'r' }] };
    expect(isValid(WorkflowDocumentInput, ok)).toBe(true);
    expect(isValid(WorkflowDocumentInput, { ...ok, stages: [42] })).toBe(false);
    expect(isValid(WorkflowDocumentInput, { ...ok, stages: [{ id: 'a', bogus: 1 }] })).toBe(false);
    expect(isValid(WorkflowDocumentInput, { ...ok, stages: [{ id: 'a', verify: [42] }] })).toBe(false);
    expect(isValid(WorkflowDocumentInput, { ...ok, stages: [{ id: 'a', verify: [] }] })).toBe(false);
    expect(isValid(WorkflowDocumentInput, { ...ok, stages: [{ id: 'a', verify: 't', max_verify: 0 }] })).toBe(false);
    expect(isValid(WorkflowDocumentInput, { ...ok, stages: [{ id: 'a', artifacts: [3] }] })).toBe(false);
    expect(isValid(WorkflowDocumentInput, { ...ok, stages: [{ id: 'a', description: 'x\ny' }] })).toBe(false);
    expect(isValid(WorkflowDocumentInput, { ...ok, artifacts: { x: { file: 'f.md', z: 1 } } })).toBe(false);
    expect(isValid(WorkflowDocumentInput, { ...ok, concurrency: 0 })).toBe(false);
    expect(isValid(WorkflowDocumentInput, { ...ok, downstream: [{ workflow: 'n', task: 'a\nb' }] })).toBe(false);
  });

  test('schema_version accepts what the loader accepts', () => {
    for (const version of [7, '7', ' 7 ']) {
      const doc = { schema_version: version, id: 'w', stages: [{ id: 'a', role: 'r' }] };
      expect(isValid(WorkflowDocumentInput, doc)).toBe(true);
    }
    expect(() => parseWorkflowMapping({ schema_version: '7', id: 'w', stages: [{ id: 'a', role: 'r' }] }, 'w.yaml')).not.toThrow();
    for (const version of ['x', 7.5, -1, true]) {
      expect(isValid(WorkflowDocumentInput, { schema_version: version })).toBe(false);
    }
  });

  test('contract and loader agree on reviewed edge cases', () => {
    const base = (stage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      ({ schema_version: 7, id: 'w', stages: [{ id: 'a', role: 'r', ...stage }], ...extra });
    const cases: Record<string, Record<string, unknown>> = {
      'run_when empty': base({ run_when: { changed_paths: [] } }),
      'downstream task leading newline': base({}, { downstream: [{ workflow: 'n', task: '\nt' }] }),
      'inline decision artifact bad id': base({ decision: [{ x: { navigate: 'complete', artifacts: { '1x': { file: 'f.md', required: false } } } }] }),
      'downstream task padded': base({}, { downstream: [{ workflow: 'n', task: ' t ' }] }),
    };
    for (const [name, data] of Object.entries(cases)) {
      let loads = true;
      try {
        parseWorkflowMapping(data, 'w.yaml');
      } catch (error) {
        loads = false;
        void error;
      }
      expect([name, isValid(WorkflowDocumentInput, data)]).toEqual([name, loads]);
    }
  });
});
