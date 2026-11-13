import { parseWorkflowMapping } from '@nodeint/migent-workflow';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

import { renderWorkflowSource } from '../src/session-freeze.ts';

const workflowWith = (session: Record<string, unknown> | undefined) =>
  parseWorkflowMapping(
    {
      schema_version: 7,
      id: 'flow',
      stages: [
        { id: 'a', role: 'dev', depends_on: [] },
        { id: 'b', role: 'dev', depends_on: ['a'], ...(session === undefined ? {} : { session }) },
      ],
    },
    'flow.yaml',
  );

const stageB = (text: string) => (parse(text) as { stages: Record<string, unknown>[] }).stages.find((s) => s.id === 'b');

test('a freeze round-trip keeps session.on_expired alone', () => {
  const text = renderWorkflowSource(workflowWith({ on_expired: 'fresh' }));
  expect(stageB(text)?.session).toEqual({ on_expired: 'fresh' });
  const back = parseWorkflowMapping(parse(text), 'frozen.yaml');
  expect(back.stages.b).toMatchObject({ resumeFrom: null, onExpired: 'fresh' });
});

test('a freeze round-trip keeps resume_from and on_expired together', () => {
  const text = renderWorkflowSource(workflowWith({ resume_from: 'a', on_expired: 'ask' }));
  expect(stageB(text)?.session).toEqual({ resume_from: 'a', on_expired: 'ask' });
  const back = parseWorkflowMapping(parse(text), 'frozen.yaml');
  expect(back.stages.b).toMatchObject({ resumeFrom: 'a', onExpired: 'ask' });
});

test('a stage with neither field serializes without a session key', () => {
  expect(stageB(renderWorkflowSource(workflowWith(undefined)))).not.toHaveProperty('session');
  expect(stageB(renderWorkflowSource(workflowWith({ resume_from: 'a' })))?.session).toEqual({ resume_from: 'a' });
});
