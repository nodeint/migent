import { PrepareResult, type Static } from "@nodeint/migent-contracts";
import { writeJson } from "../emit.js";
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
  const payload: Static<typeof PrepareResult> = {
    session_id: id,
    title: sessionId.trim(),
    status: "prepared" as const,
    task_path: relativeTaskPath(id),
    workflow_path: relativeWorkflowPath(id),
  };
  writeJson(PrepareResult, payload);
  log(`session_id: ${id}`);
  return 0;
}
