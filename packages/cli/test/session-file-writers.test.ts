import { isValid, SessionMetrics, SessionMetricsLegacy, validationIssues } from '@nodeint/migent-contracts';
import { buildMetrics } from '@nodeint/migent-plugins';
import { createWorkflowSession, readSessionSnapshot } from '@nodeint/migent-session';
import { afterEach, expect, test } from 'vitest';

import { removeWorkspace, writeFakeWorkflowWorkspace } from './support.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeWorkspace(root); });

test('metrics built by the plugin validate against the plugin and legacy file schemas', () => {
  const root = writeFakeWorkflowWorkspace({ plan: 'schema_version: 7\nid: plan\nstages:\n  - { id: draft, role: planner }\n' });
  roots.push(root);
  const id = createWorkflowSession(root, 'plan', { task: 'Plan the work' });
  const document = JSON.parse(JSON.stringify(buildMetrics(id, readSessionSnapshot(root, id, {})))) as unknown;
  for (const schema of [SessionMetrics, SessionMetricsLegacy]) {
    expect(validationIssues(schema, document)).toEqual([]);
    expect(isValid(schema, document)).toBe(true);
  }
});
