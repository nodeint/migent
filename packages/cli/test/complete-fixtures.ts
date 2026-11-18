import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { StageOutcome } from '@nodeint/migent-kernel';
import { createWorkflowSession, SessionLock, SessionStore } from '@nodeint/migent-session';

import { removeWorkspace, writeFakeWorkflowWorkspace } from './support.ts';

const WORKFLOW = `schema_version: 7
id: plan
artifacts:
  plan: { file: plan.md }
  notes: { file: notes.md }
stages:
  - id: draft
    role: planner
    artifacts: [plan]
  - id: extra
    role: planner
    depends_on: [draft]
    artifacts: [notes]
downstream:
  - workflow: implement
    task: Implement the plan
    artifacts: { plan: plan }
`;

export const workspaces: string[] = [];

export function cleanWorkspaces(): void {
  for (const workspace of workspaces.splice(0)) removeWorkspace(workspace);
}

/** A workflow session stopped after `draft`, ready for `session complete`. */
export function stoppedSession(): { workspace: string; sessionId: string; directory: string } {
  const workspace = writeFakeWorkflowWorkspace({
    plan: WORKFLOW,
    implement: 'schema_version: 7\nid: implement\nstages:\n  - { id: work, role: developer }\n',
  });
  workspaces.push(workspace);
  const sessionId = createWorkflowSession(workspace, 'plan', { task: 'Write a plan' });
  const directory = path.join(workspace, '.migent', 'sessions', sessionId);
  const store = new SessionStore(workspace);
  const lock = SessionLock.acquire(directory);
  try {
    const [record, , context] = store.loadOrCreate({ client: 'fake', model: 'model', options: {}, workspace, sessionId, stageId: 'draft', stageAttempt: null, executionOrder: null, prompt: 'draft' });
    store.saveExecution(context, record, { status: 'running' });
    writeFileSync(path.join(context.artifactDirectory, 'plan.md'), '# Plan\n', 'utf8');
    store.saveExecution(context, record, { status: 'completed', outcome: new StageOutcome('complete') });
  } finally {
    lock.release();
  }
  return { workspace, sessionId, directory };
}

