import { mergeConfigLayers } from '@nodeint/migent-kernel';
import { expect, test } from 'vitest';

import { type ConfigLoad,validateConfigDraft, validateWorkflowDraft } from '../src/index.ts';
import { defaultClients } from './support.ts';

const CONFIG = {
  schema_version: 7,
  agents: {
    fast: { client: { type: 'grok' }, model: 'grok-4.6' },
  },
  roles: {
    developer: { agent: 'fast' },
  },
};

function load(project: Record<string, unknown>, local: Record<string, unknown> | null = null): ConfigLoad {
  return { ...mergeConfigLayers(project, local), layers: { project, local } };
}

function workflow(draft: Record<string, unknown>, config: ConfigLoad = load(CONFIG)) {
  return validateWorkflowDraft(
    { draft, file: 'build.yaml', siblings: [], config },
    defaultClients(),
  );
}

test('a workflow draft reports every independent error with its own path', () => {
  const out = workflow({
    schema_version: 7,
    id: 'build',
    stages: [
      { id: 'implement', role: 'developer', depends_on: [], ask: 'bot', max_revisions: 'nope' },
      { id: 'review', depends_on: ['implement'] },
    ],
    downstream: [{ workflow: 'nowhere', task: 'go' }],
  });
  expect(out.map((item) => [item.code, item.path])).toEqual([
    ['workflow-invalid', ['stages', 0, 'ask']],
    ['invalid-value', ['stages', 0, 'max_revisions']],
    ['missing-required', ['stages', 1, 'role']],
    ['unknown-downstream', ['downstream', 0, 'workflow']],
  ]);
});

test('an invalid unit never causes follow-on errors in the checks that read it', () => {
  // Every declared stage has a problem, but the stages list itself is not empty.
  const allInvalid = workflow({
    schema_version: 7,
    id: 'build',
    stages: [
      { id: 'a', depends_on: [] },
      { id: 'b', role: 'developer', depends_on: [], ask: 'bot' },
    ],
  });
  expect(allInvalid.some((item) => item.code === 'no-stages')).toBe(false);

  // A target whose stage is declared but has invalid fields still exists.
  const dependency = workflow({
    schema_version: 7,
    id: 'build',
    stages: [
      { id: 'a', role: 'developer', depends_on: [] },
      { id: 'b', role: 'developer', depends_on: ['a'], ask: 'bot' },
    ],
  });
  expect(dependency.some((item) => item.code === 'unknown-stage')).toBe(false);
  expect(dependency.map((item) => item.code)).toEqual(['workflow-invalid']);

  // Each downstream entry is checked on its own.
  const downstream = workflow({
    schema_version: 7,
    id: 'build',
    stages: [{ id: 'a', role: 'developer', depends_on: [] }],
    downstream: [{ task: 'go' }, { workflow: 'nowhere', task: 'go' }, { workflow: 'elsewhere', task: 'go' }],
  });
  expect(downstream.map((item) => [item.code, item.path])).toEqual([
    ['missing-required', ['downstream', 0, 'workflow']],
    ['unknown-downstream', ['downstream', 1, 'workflow']],
    ['unknown-downstream', ['downstream', 2, 'workflow']],
  ]);
});

test('a config draft reports every independent error', () => {
  const out = validateConfigDraft(
    {
      scope: 'project',
      draft: {
        schema_version: 7,
        agents: {
          fast: { client: { type: 'grok' }, model: 'grok-4.6' },
          slow: { client: { type: 'nope' }, model: 'ghost' },
        },
        roles: {
          developer: { agent: 'fast', responsibilities: 'nope' },
          reviewer: { agent: 'missing' },
        },
      },
      companion: null,
    },
    defaultClients(),
  );
  const errors = out.filter((item) => item.severity === 'error');
  expect(errors.map((item) => [item.code, item.path])).toEqual([
    ['client-unsupported', ['agents', 'slow', 'client', 'type']],
    ['not-a-list', ['roles', 'developer', 'responsibilities']],
    ['unknown-agent', ['roles', 'reviewer', 'agent']],
  ]);
  expect(errors.map((item) => item.source)).toEqual([
    { layer: 'project' },
    { layer: 'project' },
    { layer: 'project' },
  ]);
});

test("a companion layer with its own problem does not hide the draft's errors", () => {
  const out = validateConfigDraft(
    {
      scope: 'project',
      draft: { schema_version: 7, agents: {}, roles: { developer: { agent: 'missing' } } },
      companion: { schema_version: 999, agents: { fast: { client: { type: 'grok' }, model: 'grok-4.6' } } },
    },
    defaultClients(),
  );
  expect(out.filter((item) => item.severity === 'error').map((item) => [item.code, item.path])).toEqual([
    ['schema-newer', ['schema_version']],
    ['unknown-agent', ['roles', 'developer', 'agent']],
  ]);
  expect(out.find((item) => item.code === 'schema-newer')?.source).toEqual({ layer: 'local' });
});
