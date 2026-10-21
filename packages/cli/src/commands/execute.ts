import {
  AgentToolRunner,
  DEFAULT_MAX_DISPATCHES,
  executeNamedWorkflow,
  type ExecuteResult,
} from "@nodeint/migent-kernel";
import { printResumeCommand } from "../display.js";
import { cliHooks } from "../hooks.js";
import { requireCurrentSchema } from "../migrate.js";
import { adapterMap } from "../provider.js";
import { text } from "../text.js";

export interface ExecuteWorkflowOptions {
  action: string;
  workflowId?: string | null;
  task?: string | null;
  sessionId?: string | null;
  priorSessionId?: string | null;
  maxDispatches?: number | null;
  continueFailed?: boolean;
  stageId?: string | null;
  runner?: AgentToolRunner | null;
  verbose?: boolean;
  itemProgress?: boolean;
  startPrepared?: boolean;
  refreshWorkflow?: boolean;
  reply?: string | null;
}

export async function executeWorkflow(workspace: string, options: ExecuteWorkflowOptions): Promise<number> {
  requireCurrentSchema(workspace);
  const once = options.action === "stage";
  const startPrepared = options.startPrepared === true;
  const sessionId = text(options.sessionId);
  const creating = !startPrepared && (options.action === "start" || (once && sessionId === null));
  const maxDispatches = options.maxDispatches === undefined ? DEFAULT_MAX_DISPATCHES : options.maxDispatches;
  const runner = options.runner ?? cliHooks.runner ?? new AgentToolRunner(adapterMap());
  runner.itemProgress = options.itemProgress === true;
  const result = await executeNamedWorkflow(
    workspace,
    {
      workflowId: creating || startPrepared ? (options.workflowId ?? null) : null,
      task: creating ? (options.task ?? null) : null,
      sessionId: creating ? null : sessionId,
      priorSessionId: options.priorSessionId ?? null,
      startPrepared,
      maxDispatches: once ? null : maxDispatches,
      continueFailed: options.continueFailed === true,
      stageId: options.stageId ?? null,
      once,
      resetRevisions: options.action === "continue",
      refreshWorkflow: options.refreshWorkflow === true,
      reply: options.reply ?? null,
    },
    runner,
  );
  printResult(result, options.verbose === true);
  printResumeHint(result);
  return result.code;
}

function printResumeHint(result: ExecuteResult): void {
  if (result.sessionId === "" || result.status === "completed" || result.stopReason === "completed") return;
  if (result.stopReason === "configuration") return;
  printResumeCommand(result.sessionId);
}

const INSPECT_EXIT_CODES = new Set([1, 3, 6, 8]);

function printResult(result: ExecuteResult, verbose: boolean): void {
  const payload: Record<string, unknown> = {
    session_id: result.sessionId,
    session_status: result.status,
    stop_reason: result.stopReason,
    latest_decision: result.latestDecision,
    outputs: result.outputs,
  };
  if (INSPECT_EXIT_CODES.has(result.code) && result.latestExecutionId) {
    payload.latest_execution_id = result.latestExecutionId;
    payload.response_path = `executions/${result.latestExecutionId}/response.md`;
  }
  if (result.code === 7 && result.latestExecutionId) {
    payload.latest_execution_id = result.latestExecutionId;
    payload.verify_path = `executions/${result.latestExecutionId}/turns/01/verify.md`;
  }
  if (verbose) payload.stages = result.stages;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}


