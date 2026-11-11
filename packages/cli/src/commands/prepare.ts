import { PrepareResult, type Static } from '@nodeint/migent-contracts';
import { log } from '@nodeint/migent-kernel';
import { createPreparedSession, relativeTaskPath, relativeWorkflowPath } from '@nodeint/migent-session';

import { writeJson } from '../emit.js';
import { requireCurrentSchema } from '../migrate.js';

export function prepareWorkflowSession(
  workspace: string,
  sessionId: string,
  workflowId: string,
  priorSessionId: string | null,
): number {
  requireCurrentSchema(workspace);
  const id = createPreparedSession(workspace, sessionId, workflowId, priorSessionId);
  const payload: Static<typeof PrepareResult> = {
    session_id: id,
    title: sessionId.trim(),
    status: 'prepared' as const,
    task_path: relativeTaskPath(id),
    workflow_path: relativeWorkflowPath(id),
  };
  writeJson(PrepareResult, payload);
  log(`session_id: ${id}`);
  return 0;
}
