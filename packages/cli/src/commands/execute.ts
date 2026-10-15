import {
  AgentToolRunner,
  DEFAULT_MAX_DISPATCHES,
  executeNamedWorkflow,
  type ExecuteResult,
} from "@nodeint/migent-kernel";
import { cliHooks } from "../hooks.js";
import { requireCurrentSchema } from "../migrate.js";
import { adapterMap } from "../provider.js";

export interface ExecuteWorkflowOptions {
  action: string;
  workflowId?: string | null;
  task?: string | null;
  sessionId?: string | null;
  priorSessionId?: string | null;
  maxAttempts?: number | null;
  maxDispatches?: number | null;
  runner?: AgentToolRunner | null;
}

export async function executeWorkflow(workspace: string, options: ExecuteWorkflowOptions): Promise<number> {
  requireCurrentSchema(workspace);
  const once = options.action === "stage";
  const creating = options.action === "start" || (once && text(options.sessionId) === null);
  const maxAttempts = options.maxAttempts === undefined ? 3 : options.maxAttempts;
  const maxDispatches = options.maxDispatches === undefined ? DEFAULT_MAX_DISPATCHES : options.maxDispatches;
  const runner = options.runner ?? cliHooks.runner ?? new AgentToolRunner(adapterMap());
  const result = await executeNamedWorkflow(
    workspace,
    {
      workflowId: creating ? (options.workflowId ?? null) : null,
      task: creating ? (options.task ?? null) : null,
      sessionId: creating ? null : (options.sessionId ?? null),
      priorSessionId: options.priorSessionId ?? null,
      maxAttempts: once ? null : maxAttempts,
      maxDispatches: once ? null : maxDispatches,
      once,
      resetRevisions: options.action === "continue",
    },
    runner,
  );
  printResult(result);
  return result.code;
}

function printResult(result: ExecuteResult): void {
  process.stdout.write(
    `${JSON.stringify({
      session_id: result.sessionId,
      session_status: result.status,
      stop_reason: result.stopReason,
      outputs: result.outputs,
      stages: result.stages,
    })}\n`,
  );
}

function text(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const stripped = value.trim();
  return stripped === "" ? null : stripped;
}
