import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, onTestFinished, test, vi } from 'vitest';

import { createPreparedSession } from '../src/session-records.ts';
import { selectSessionWorkflow } from '../src/session-selection.ts';
import { tempDir, writeSessionConfig } from './support.ts';

const PLAN = `schema_version: 8
id: plan
stages:
  - id: draft
    role: planner
`;

function preparedDraft(): { workspace: string; sessionId: string; draftPath: string } {
  const workspace = tempDir('migent-select-quiet-');
  onTestFinished(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'plan.yaml'), PLAN, 'utf8');
  writeSessionConfig(workspace);
  const sessionId = createPreparedSession(workspace, { title: 'Draft', workflowId: 'plan' });
  const draftPath = path.join(workspace, '.migent', 'sessions', sessionId, 'workflow.yaml');
  return { workspace, sessionId, draftPath };
}

test('selecting a draft keeps authoring warnings off stderr and on the document', () => {
  const { workspace, sessionId, draftPath } = preparedDraft();
  writeFileSync(draftPath, 'schema_version: 4\nid: plan\nbogus_key: 1\nstages:\n  - id: draft\n    role: planner\n', 'utf8');
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const selection = selectSessionWorkflow(workspace, sessionId);
    expect(selection.problems).toEqual([]);
    expect(selection.document?.warnings).toHaveLength(1);
    expect(stderr).not.toHaveBeenCalled();
  } finally {
    stderr.mockRestore();
  }
});

test('selecting a draft that is not a mapping reports the same load error as a problem', () => {
  const { workspace, sessionId, draftPath } = preparedDraft();
  writeFileSync(draftPath, '- not\n- a mapping\n', 'utf8');
  const selection = selectSessionWorkflow(workspace, sessionId);
  expect(selection.document).toBeNull();
  expect(selection.problems).toEqual([`Workflow must be a mapping: ${draftPath}`]);
});
