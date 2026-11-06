import { clientRegistry } from "../client.js";
import { createPreparedSession, log, relativeTaskPath, relativeWorkflowPath } from "@nodeint/migent-kernel";
import { requireCurrentSchema } from "../migrate.js";

export function prepareWorkflowSession(
  workspace: string,
  sessionId: string,
  workflowId: string,
  priorSessionId: string | null,
): number {
  requireCurrentSchema(workspace);
  const id = createPreparedSession(workspace, sessionId, workflowId, priorSessionId, clientRegistry());
  const payload = {
    session_id: id,
    title: sessionId.trim(),
    status: "prepared",
    task_path: relativeTaskPath(id),
    workflow_path: relativeWorkflowPath(id),
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  log(`session_id: ${id}`);
  return 0;
}
