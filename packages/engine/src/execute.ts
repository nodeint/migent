import { constants as osConstants } from 'node:os';

import { exitCode } from '@nodeint/migent-contracts';
import { CancellationRequested, raiseCancellation, resetCancellation } from '@nodeint/migent-kernel';
import { ConfigurationError, OutputsMissing } from '@nodeint/migent-kernel';
import { log } from '@nodeint/migent-kernel';
import { VERIFY_EXHAUSTED, VERIFY_FAILED } from '@nodeint/migent-kernel';
import { clearInFlightExecutions, isSessionLockLost, SessionLockHeldError, SessionStore } from '@nodeint/migent-session';
import { isRoleStage, isWorkflowV2, type WorkflowDocument } from '@nodeint/migent-workflow';

import { type AgentToolRunner, type RunResult } from './agent-runner.js';
import {
  assertStageDispatchable,
  dispatchExecuteStage,
  executeFinal,
  type ExecuteResult,
  type ExecuteRun,
  stageFinishLine,
  TERMINAL_SESSION_STATUSES,
  text,
} from './dispatch.js';
import { runExecuteLoop, runExecuteOnce, startTracked, trackDispatch } from './execute-loop.js';
import { type ExecuteRequest, HeldSession, openExecuteSession, verifyOnlyExecution } from './execute-session.js';
import { runVerifyOnlyStage } from './verify-only.js';

export type { ExecuteResult } from './dispatch.js';
export { EXECUTE_EXIT_CODES } from './dispatch.js';
export type { ExecuteRequest } from './execute-session.js';

export const DEFAULT_MAX_DISPATCHES = 20;

export async function executeNamedWorkflow(
  workspace: string,
  request: ExecuteRequest,
  runner?: AgentToolRunner,
): Promise<ExecuteResult> {
  const held = new HeldSession();
  try {
    return await executeLocked(workspace, request, { held, runner });
  } catch (error) {
    if (!(error instanceof SessionLockHeldError) && !isSessionLockLost(error)) throw error;
    // Same shape as any other plain Error in the run: stderr message, exit 2.
    process.stderr.write(`migent: ${error.message}\n`);
    return {
      code: 2,
      status: '',
      stopReason: 'configuration',
      sessionId: request.sessionId ?? '',
      latestDecision: null,
      latestExecutionId: null,
      outputs: {},
      stages: [],
    };
  } finally {
    if (held.sessionId) clearInFlightExecutions(held.sessionId);
    held.lock?.release();
    resetCancellation();
  }
}

async function executeLocked(
  workspace: string,
  request: ExecuteRequest,
  session: { held: HeldSession; runner?: AgentToolRunner },
): Promise<ExecuteResult> {
  const { held, runner: activeRunner } = session;
  if (activeRunner === undefined) {
    throw new ConfigurationError('A client registry is required to run a workflow.');
  }
  const {registry} = activeRunner;
  const limits = dispatchLimits(request);
  const store = new SessionStore(workspace);
  const opened = await openExecuteSession(workspace, request, { held, registry, store });
  if (opened.kind === 'final') return opened.result;
  const { sessionId, workflow, workflowId, stageReply, resumeCancelled, reopenLatestCancelled } = opened;
  const removeSignalHandlers = installSignalHandlers(held);
  const tasks = new Map<string, Promise<unknown>>();
  const run: ExecuteRun = {
    workspace,
    store,
    workflow,
    workflowId,
    sessionId,
    runner: activeRunner,
    tasks,
    reply: stageReply,
  };
  try {
    const stageJsons = await sendStageReply(run);
    if (resumeCancelled) {
      const resumed = await resumeReopenedExecutions(run, { ...limits, reopenLatestCancelled }, stageJsons);
      if (resumed !== null) return resumed;
    }
    return await continueAfterReply(run, limits, stageJsons);
  } catch (error) {
    return await handleExecuteError(error, { store, sessionId, tasks });
  } finally {
    removeSignalHandlers();
  }
}

// Sends a pending stage reply first, so a cancelled sibling cannot end the command or fold the session blocked.
async function sendStageReply(run: ExecuteRun): Promise<Record<string, unknown>[]> {
  const { workspace, store, workflow, workflowId, sessionId, runner, tasks, reply: stageReply } = run;
  if (stageReply === null) return [];
  const replySnapshots = store.executionSnapshots(sessionId);
  const replyStatus = store.readSessionStatus(sessionId);
  assertStageDispatchable(workspace, workflow, { sessionId, stageId: stageReply.stageId });
  return [
    await trackDispatch(sessionId, tasks, (note) =>
      dispatchExecuteStage(
        { workspace, workflow, workflowId, sessionId, runner, reply: stageReply },
        { stageId: stageReply.stageId, status: replyStatus, snapshots: replySnapshots },
        note,
      ),
    ),
  ];
}

// Stops after a sent reply when the run is scoped to it, else dispatches onward.
async function continueAfterReply(
  run: ExecuteRun,
  limits: { stageId: string | null; once: boolean; maxDispatches: number | null },
  stageJsons: Record<string, unknown>[],
): Promise<ExecuteResult> {
  const { store, workflow, sessionId, reply: stageReply } = run;
  const { stageId, once, maxDispatches } = limits;
  const singleStage = once || stageId !== null;
  const replySent = stageReply !== null && stageReply.consumed;
  const replyResult = replySent ? stageJsons[0] : undefined;
  const replyExhausted = replyResult?.failure_reason === VERIFY_EXHAUSTED;
  if (replyExhausted && (!isWorkflowV2(workflow) || singleStage)) {
    return executeFinal(store.readSessionStatus(sessionId), VERIFY_EXHAUSTED, stageJsons);
  }
  if (replySent && singleStage) {
    return replyStopResult(store.readSessionStatus(sessionId), replyResult, stageJsons);
  }
  const continued = singleStage
    ? await runExecuteOnce(run, stageId)
    : await runExecuteLoop(run, {
        maxDispatches,
        alreadyDispatched: replySent ? 1 : 0,
        verifyTriedSeed: replyExhausted && stageReply !== null ? [stageReply.stageId] : [],
        verifyOnlyTriedSeed: [],
      });
  if (stageJsons.length > 0) continued.stages = [...stageJsons, ...continued.stages];
  return continued;
}

// Reads and validates the stage, once, and dispatch-ceiling options of a request.
function dispatchLimits(
  request: ExecuteRequest,
): { stageId: string | null; once: boolean; maxDispatches: number | null } {
  const stageId = request.stageId ?? null;
  const once = request.once ?? false;
  const maxDispatches =
    request.maxDispatches === undefined ? DEFAULT_MAX_DISPATCHES : request.maxDispatches;
  if (!once && maxDispatches !== null && maxDispatches < 1) {
    throw new ConfigurationError('--max-dispatches must be at least 1.');
  }
  return { stageId, once, maxDispatches };
}

// Routes SIGINT, SIGTERM, and lock cancel requests to cooperative cancellation. Returns the uninstaller.
function installSignalHandlers(held: HeldSession): () => void {
  const onSigint = () => {
    try {
      raiseCancellation(osConstants.signals.SIGINT);
    } catch {
      // The flag stays set; the command loop observes it.
    }
  };
  const onSigterm = () => {
    try {
      raiseCancellation(osConstants.signals.SIGTERM);
    } catch {
      // The flag stays set; the command loop observes it.
    }
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  held.lock?.onCancelRequest(onSigint);
  return () => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };
}

// Builds the result when a sent reply ends a single-stage run.
function replyStopResult(
  status: Record<string, unknown>,
  replyResult: Record<string, unknown> | undefined,
  stageJsons: Record<string, unknown>[],
): ExecuteResult {
  if (replyResult?.failure_kind === 'quota') return executeFinal(status, 'quota', stageJsons);
  const after = text(status.status);
  const stopReason = TERMINAL_SESSION_STATUSES.has(after) ? after : 'stage';
  const result = executeFinal(status, stopReason, stageJsons);
  if (replyResult?.outcome_status === 'question') {
    result.code = 9;
    result.stopReason = 'question';
  }
  if (stopReason === 'stage' && stageJsons.some((item) => item.outcome_status !== 'complete' && item.execution_status !== 'skipped')) result.code = stageJsons.some((item) => item.outcome_status === 'question') ? exitCode('question') : exitCode('blocked');
  return result;
}

// Maps an execute failure to its final result, or rethrows it.
async function handleExecuteError(
  error: unknown,
  scope: { store: SessionStore; sessionId: string; tasks: Map<string, Promise<unknown>> },
): Promise<ExecuteResult> {
  const { store, sessionId, tasks } = scope;
  if (error instanceof CancellationRequested) {
    await Promise.allSettled([...tasks.values()]);
    log(error.message);
    return executeFinal(store.readSessionStatus(sessionId), 'cancelled', []);
  }
  if (error instanceof OutputsMissing) {
    process.stderr.write(`migent: ${error.message}\n`);
    return executeFinal(store.readSessionStatus(sessionId), 'outputs_missing', []);
  }
  // ConfigurationError stays an exception. Callers map it to exit 2, matching Python.
  if (error instanceof ConfigurationError) throw error;
  if (error instanceof Error && !hasErrorCode(error)) {
    process.stderr.write(`migent: ${error.message}\n`);
    return {
      code: 2,
      status: '',
      stopReason: 'configuration',
      sessionId,
      latestDecision: null,
      latestExecutionId: null,
      outputs: {},
      stages: [],
    };
  }
  throw error;
}

interface ReopenLimits {
  once: boolean;
  stageId: string | null;
  maxDispatches: number | null;
  reopenLatestCancelled: boolean;
}

/**
 * Reopens cancelled executions and runs them to their next stop. Returns a final result, or null when
 * the caller should go on dispatching.
 */
async function resumeReopenedExecutions(
  run: ExecuteRun,
  limits: ReopenLimits,
  stageJsons: Record<string, unknown>[],
): Promise<ExecuteResult | null> {
  const { store, sessionId } = run;
  const { reopenLatestCancelled } = limits;
  const reopened = store.reopenCancelledExecutions(sessionId, reopenLatestCancelled);
  if (reopenLatestCancelled && reopened.length === 0) return null;
  for (const item of reopened) {
    log(`session ${sessionId} was cancelled during ${item.executionId}. Resuming that execution.`);
  }
  const continued = await continueReopened(run, reopened);
  stageJsons.push(...logReopenedFinishes(run, reopened, continued));
  const stopped = reopenedStopResult(store.readSessionStatus(sessionId), limits, { continued, stageJsons });
  if (stopped !== null) return stopped;
  if (reopenLatestCancelled) return null;
  return await dispatchAfterReopen(run, limits.maxDispatches, { reopened, continued, stageJsons });
}

// Returns the final result when the reopened executions end the command, else null.
function reopenedStopResult(
  status: Record<string, unknown>,
  limits: ReopenLimits,
  finished: { continued: readonly RunResult[]; stageJsons: Record<string, unknown>[] },
): ExecuteResult | null {
  const { continued, stageJsons } = finished;
  const singleStage = limits.once || limits.stageId !== null;
  const after = text(status.status);
  if (continued.some((item) => item.failure_reason === VERIFY_FAILED)) {
    return executeFinal(status, VERIFY_FAILED, stageJsons);
  }
  if (continued.some((item) => item.failure_reason === VERIFY_EXHAUSTED)) {
    return executeFinal(status, VERIFY_EXHAUSTED, stageJsons);
  }
  if (continued.some((item) => item.failure_kind === 'quota') && singleStage) {
    return executeFinal(status, 'quota', stageJsons);
  }
  // A cancelled session stops here for one stage. A blocked sibling still needs dispatch.
  if (limits.reopenLatestCancelled || !(singleStage || TERMINAL_SESSION_STATUSES.has(after))) return null;
  const stopReason = TERMINAL_SESSION_STATUSES.has(after) ? after : 'stage';
  const result = executeFinal(status, stopReason, stageJsons);
  if (stopReason === 'stage' && continued.some((item) => item.outcome_status !== 'complete' && item.execution_status !== 'skipped')) result.code = continued.some((item) => item.outcome_status === 'question') ? exitCode('question') : exitCode('blocked');
  return result;
}

// Dispatches onward after the reopened executions finished without stopping the command.
async function dispatchAfterReopen(
  run: ExecuteRun,
  maxDispatches: number | null,
  resumed: {
    reopened: readonly { executionId: string; stageId: string }[];
    continued: readonly RunResult[];
    stageJsons: Record<string, unknown>[];
  },
): Promise<ExecuteResult> {
  const { reply: stageReply } = run;
  const { reopened, continued, stageJsons } = resumed;
  const rest = await runExecuteLoop(run, {
    maxDispatches,
    alreadyDispatched: stageReply !== null && stageReply.consumed ? 1 : 0,
    verifyTriedSeed: stageJsons[0]?.failure_reason === VERIFY_EXHAUSTED && stageReply !== null ? [
      stageReply.stageId,
    ] : [],
    verifyOnlyTriedSeed: reopened
      .filter((item, index) => continued[index]?.failure_reason === VERIFY_FAILED)
      .map((item) => item.stageId),
  });
  rest.stages = [...stageJsons, ...rest.stages];
  return rest;
}

// Runs every reopened execution to its next stop; rethrows the first rejection.
async function continueReopened(
  run: ExecuteRun,
  reopened: readonly { executionId: string; stageId: string }[],
): Promise<RunResult[]> {
  const settled = await Promise.allSettled(reopened.map((item) => trackReopenedExecution(run, item)));
  const rejected = settled.find((item) => item.status === 'rejected');
  if (rejected && rejected.status === 'rejected') throw rejected.reason;
  return settled.flatMap((item) => (item.status === 'fulfilled' ? [item.value] : []));
}

function trackReopenedExecution(run: ExecuteRun, item: { executionId: string; stageId: string }): Promise<RunResult> {
  const { sessionId, tasks } = run;
  return startTracked({ sessionId, executionId: item.executionId, tasks }, () => continueReopenedExecution(run, item));
}

// A reopened verify-only execution reruns its verify; any other continues its cancelled turn.
function continueReopenedExecution(
  run: ExecuteRun,
  item: { executionId: string; stageId: string },
): Promise<RunResult> {
  const { workspace, workflow, sessionId, runner: activeRunner } = run;
  if (!verifyOnlyExecution(workspace, sessionId, item.executionId)) {
    return activeRunner.continueCancelled(workspace, sessionId, item.executionId);
  }
  return runVerifyOnlyStage({
    workspace,
    sessionId,
    stage: verifyOnlyStage(workflow, item.stageId),
    verifyRunner: activeRunner.verifyRunner,
    clients: activeRunner.registry,
    executionId: item.executionId,
  });
}

// Logs each reopened execution's finish line; returns their stage JSONs.
function logReopenedFinishes(
  run: ExecuteRun,
  reopened: readonly { executionId: string; stageId: string }[],
  continued: readonly RunResult[],
): Record<string, unknown>[] {
  const { workspace, sessionId } = run;
  const stageJsons: Record<string, unknown>[] = [];
  for (let index = 0; index < reopened.length; index += 1) {
    const item = reopened[index];
    const result = continued[index];
    const outcome =
      result.failure_reason === VERIFY_FAILED
        ? 'verify_failed'
        : result.outcome_status ||
          (result.failure_reason || result.failure_kind || result.execution_status === 'failed'
            ? 'failed'
            : 'finished');
    log(
      stageFinishLine(
        { workspace, sessionId },
        { stageId: item.stageId || 'stage', executionId: item.executionId },
        { outcome, decision: result.outcome_decision || '' },
      ),
    );
    stageJsons.push(runResultJson(result));
  }
  return stageJsons;
}

function verifyOnlyStage(workflow: WorkflowDocument, stageId: string) {
  const stage = workflow.stages[stageId];
  if (stage === undefined || isRoleStage(stage)) {
    throw new ConfigurationError(`Stage ${stageId} has no verify-only runner.`);
  }
  return stage;
}

function runResultJson(result: RunResult): Record<string, unknown> {
  return {
    agent_id: result.agent_id,
    options: { ...result.options },
    session_id: result.session_id,
    execution_id: result.execution_id,
    artifact_directory: result.artifact_directory,
    failure_reason: result.failure_reason,
    failure_kind: result.failure_kind,
    reset_at: result.reset_at,
    client: result.client,
    outcome_status: result.outcome_status,
    outcome_decision: result.outcome_decision,
    session_status: result.session_status,
    response: result.response,
    execution_status: result.execution_status ?? '',
  };
}

function hasErrorCode(error: Error): boolean {
  return 'code' in error && typeof (error as { code?: unknown }).code === 'string';
}

/** The reply prompt names a lone question; several questions are spelled out in the formatted answers. */
