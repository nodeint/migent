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
  const { held, runner } = session;
  const activeRunner = runner;
  if (activeRunner === undefined) {
    throw new ConfigurationError('A client registry is required to run a workflow.');
  }
  const {registry} = activeRunner;
  const stageId = request.stageId ?? null;
  const once = request.once ?? false;
  const maxDispatches =
    request.maxDispatches === undefined ? DEFAULT_MAX_DISPATCHES : request.maxDispatches;
  if (!once && maxDispatches !== null && maxDispatches < 1) {
    throw new ConfigurationError('--max-dispatches must be at least 1.');
  }
  const store = new SessionStore(workspace);
  const opened = await openExecuteSession(workspace, request, { held, registry, store });
  if (opened.kind === 'final') return opened.result;
  const { sessionId, workflow, workflowId, stageReply, resumeCancelled, reopenLatestCancelled } = opened;
  const onSigint = () => {
    try {
      raiseCancellation(2);
    } catch {
      // The flag stays set; the command loop observes it.
    }
  };
  const onSigterm = () => {
    try {
      raiseCancellation(15);
    } catch {
      // The flag stays set; the command loop observes it.
    }
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  held.lock?.onCancelRequest(onSigint);
  const tasks = new Map<string, Promise<unknown>>();
  try {
    const stageJsons: Record<string, unknown>[] = [];
    if (stageReply !== null) {
      // Send the reply before a cancelled sibling can end the command or fold the session blocked.
      const replySnapshots = store.executionSnapshots(sessionId);
      const replyStatus = store.readSessionStatus(sessionId);
      assertStageDispatchable(workspace, workflow, { sessionId, stageId: stageReply.stageId });
      stageJsons.push(
        await trackDispatch(sessionId, tasks, (note) =>
          dispatchExecuteStage(
            { workspace, workflow, workflowId, sessionId, runner: activeRunner, reply: stageReply },
            { stageId: stageReply.stageId, status: replyStatus, snapshots: replySnapshots },
            note,
          ),
        ),
      );
    }
    if (resumeCancelled) {
      const resumed = await resumeReopenedExecutions(
        { workspace, store, workflow, workflowId, sessionId, runner: activeRunner, tasks, reply: stageReply },
        { once, stageId, maxDispatches, reopenLatestCancelled },
        stageJsons,
      );
      if (resumed !== null) return resumed;
    }
    const replySent = stageReply !== null && stageReply.consumed;
    const replyResult = replySent ? stageJsons[0] : undefined;
    const replyExhausted = replyResult?.failure_reason === VERIFY_EXHAUSTED;
    if (replyExhausted && (!isWorkflowV2(workflow) || once || stageId !== null)) {
      return executeFinal(store.readSessionStatus(sessionId), VERIFY_EXHAUSTED, stageJsons);
    }
    if (replySent && (once || stageId !== null)) {
      const status = store.readSessionStatus(sessionId);
      if (replyResult?.failure_kind === 'quota') return executeFinal(status, 'quota', stageJsons);
      const after = text(status.status);
      const stopReason = TERMINAL_SESSION_STATUSES.has(after) ? after : 'stage';
      const result = executeFinal(status, stopReason, stageJsons);
      if (replyResult?.outcome_status === 'question') {
        result.code = 9;
        result.stopReason = 'question';
      }
      if (stopReason === 'stage' && stageJsons.some((item) => item.outcome_status !== 'complete' && item.execution_status !== 'skipped')) result.code = stageJsons.some((item) => item.outcome_status === 'question') ? 9 : 1;
      return result;
    }
    const replyDispatches = replySent ? 1 : 0;
    const replyVerifyTried = replyExhausted && stageReply !== null ? [stageReply.stageId] : [];
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
    const continued = once || stageId !== null
      ? await runExecuteOnce(run, stageId)
      : await runExecuteLoop(run, {
          maxDispatches,
          alreadyDispatched: replyDispatches,
          verifyTriedSeed: replyVerifyTried,
          verifyOnlyTriedSeed: [],
        });
    if (stageJsons.length > 0) continued.stages = [...stageJsons, ...continued.stages];
    return continued;
  } catch (error) {
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
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
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
  const { workspace, store, workflow, sessionId, runner: activeRunner, tasks } = run;
  const { once, stageId, maxDispatches, reopenLatestCancelled } = limits;
  const reopened = store.reopenCancelledExecutions(sessionId, reopenLatestCancelled);
  if (!reopenLatestCancelled || reopened.length > 0) {
    for (const item of reopened) {
      log(`session ${sessionId} was cancelled during ${item.executionId}. Resuming that execution.`);
    }
    const settled = await Promise.allSettled(
      reopened.map((item) =>
        startTracked({ sessionId, executionId: item.executionId, tasks }, () =>
          verifyOnlyExecution(workspace, sessionId, item.executionId)
            ? runVerifyOnlyStage({
                workspace,
                sessionId,
                stage: verifyOnlyStage(workflow, item.stageId),
                verifyRunner: activeRunner.verifyRunner,
                clients: activeRunner.registry,
                executionId: item.executionId,
              })
            : activeRunner.continueCancelled(workspace, sessionId, item.executionId),
        ),
      ),
    );
    const rejected = settled.find((item) => item.status === 'rejected');
    if (rejected && rejected.status === 'rejected') throw rejected.reason;
    const continued = settled.flatMap((item) => (item.status === 'fulfilled' ? [item.value] : []));
    for (let index = 0; index < reopened.length; index += 1) {
      const item = reopened[index]!;
      const result = continued[index]!;
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
    const status = store.readSessionStatus(sessionId);
    const after = text(status.status);
    if (continued.some((item) => item.failure_reason === VERIFY_FAILED)) {
      return executeFinal(status, VERIFY_FAILED, stageJsons);
    }
    if (continued.some((item) => item.failure_reason === VERIFY_EXHAUSTED)) {
      return executeFinal(status, VERIFY_EXHAUSTED, stageJsons);
    }
    if (continued.some((item) => item.failure_kind === 'quota') && (once || stageId !== null)) {
      return executeFinal(status, 'quota', stageJsons);
    }
    // A cancelled session stops here for one stage. A blocked sibling still needs dispatch.
    if (!reopenLatestCancelled && (once || stageId !== null || TERMINAL_SESSION_STATUSES.has(after))) {
      const stopReason = TERMINAL_SESSION_STATUSES.has(after) ? after : 'stage';
      const result = executeFinal(status, stopReason, stageJsons);
      if (stopReason === 'stage' && continued.some((item) => item.outcome_status !== 'complete' && item.execution_status !== 'skipped')) result.code = continued.some((item) => item.outcome_status === 'question') ? 9 : 1;
      return result;
    }
    if (!reopenLatestCancelled) {
      const { reply: stageReply } = run;
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
  }
  return null;
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
