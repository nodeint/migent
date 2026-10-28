import { providerMap } from "../provider.js";
import { createPreparedSession, createProviderResolver, log, relativeTaskPath } from "@nodeint/migent-kernel";
import { requireCurrentSchema } from "../migrate.js";

export function prepareWorkflowSession(
  workspace: string,
  sessionId: string,
  workflowId: string,
  priorSessionId: string | null,
): number {
  requireCurrentSchema(workspace);
  const id = createPreparedSession(workspace, sessionId, workflowId, priorSessionId, createProviderResolver(providerMap()));
  const payload = {
    session_id: id,
    title: sessionId.trim(),
    status: "prepared",
    task_path: relativeTaskPath(id),
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  log(`session_id: ${id}`);
  return 0;
}
