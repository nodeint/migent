import type { ClientRegistry, VerifyRunner } from '@nodeint/migent-kernel';
import { formatClock, log, VERIFY_FAILED } from '@nodeint/migent-kernel';
import { AgentSessionRecord, type ExecutionContext, SessionStore } from '@nodeint/migent-session';
import { parseExecutionId } from '@nodeint/migent-session';
import type { VerifyOnlyStageSpec } from '@nodeint/migent-workflow';

import type { RunResult } from './agent-runner.js';
import { ExecutionApplier } from './execution/applier.js';
import { createVerifyRunOperation } from './execution/handlers.js';
import { debugTrace } from './execution/run-role.js';
import { VERIFY_RUN,type VerifyInput } from './execution/types.js';
import { verifyOnlyDefinition } from './execution/verify-only-definition.js';
import { ProviderEventReporter } from './provider-events.js';
import type { InterceptorChain } from './runtime/interception.js';
import { OperationRuntime } from './runtime/operation-runtime.js';

const VERIFY_TURN = 1;

export async function runVerifyOnlyStage(input: {
  workspace: string;
  sessionId: string;
  stage: VerifyOnlyStageSpec;
  verifyRunner: VerifyRunner;
  clients?: ClientRegistry;
  /** The active plugin chain. A verify-only stage runs the same interception as a role execution. */
  interceptors?: InterceptorChain;
  /** Reuse a cancelled execution that has already been reopened. */
  executionId?: string | null;
  onExecution?: (executionId: string) => void;
}): Promise<RunResult> {
  const store = new SessionStore(input.workspace);
  const context = openContext(store, input);
  input.onExecution?.(context.executionId);
  if ((input.executionId === null || input.executionId === undefined)) {
    log(startLine(input.stage, parseExecutionId(context.executionId)?.attempt ?? null));
  }
  const eventReporter = new ProviderEventReporter({ store, context }, { client: '', model: '' });
  const record = new AgentSessionRecord({ client: '', model: '', workspace: input.workspace, status: 'running' });
  const applier = new ExecutionApplier({ record, store, context, eventReporter });
  const runtime = new OperationRuntime({
    applier,
    ...(input.interceptors === undefined ? {} : { interceptors: input.interceptors }),
    trace: debugTrace(store, context),
    operations: [createVerifyRunOperation({
      store, context, eventReporter, verifyRunner: input.verifyRunner, workspace: input.workspace, applier,
      cancel: 'verify-only',
    })],
  });
  const verifyInput: VerifyInput = {
    turn: VERIFY_TURN, commands: input.stage.verify, timeoutSec: input.stage.verifyTimeoutSec, run: 1,
    redIfPassed: 0, redIfFailed: 1, maxVerify: 1,
  };
  // A verify-only execution has one logical attempt (D10).
  const end = await runtime.run({
    scope: { sessionId: context.sessionId, stageId: input.stage.id, role: '' },
    definition: verifyOnlyDefinition,
    state: { turn: VERIFY_TURN },
    request: {
      identity: { executionId: context.executionId, operationId: VERIFY_RUN, attempt: 1 },
      input: verifyInput,
    },
  });
  return executionJson(store, context, end.passed
    ? { outcomeStatus: 'complete', failureReason: '' }
    : { outcomeStatus: '', failureReason: VERIFY_FAILED });
}

function openContext(
  store: SessionStore,
  input: { sessionId: string; stage: { id: string }; executionId?: string | null },
): ExecutionContext {
  const { sessionId, executionId = null } = input;
  const stageId = input.stage.id;
  if (executionId === null) return store.openVerifyExecution(sessionId, stageId);
  const context = store.executionContext(sessionId, executionId);
  if (context === null) throw new Error(`Execution ${executionId} was not found in session ${sessionId}.`);
  store.clearVerifyTurn(context);
  return context;
}

function startLine(stage: VerifyOnlyStageSpec, attempt: number | null): string {
  const detail = `verify (${stage.verify.length} command${stage.verify.length === 1 ? '' : 's'})`;
  const parts = [`stage ${stage.id}`];
  if (attempt !== null) parts.push(`attempt ${attempt}`);
  parts.push(formatClock(), detail);
  const base = parts.join(' · ');
  if (stage.description === null) return `${base}.`;
  return `${base} — ${stage.description}.`;
}

function executionJson(
  store: SessionStore,
  context: ExecutionContext,
  result: { outcomeStatus: string; failureReason: string },
): RunResult {
  const { outcomeStatus, failureReason } = result;
  const sessionStatus = store.readSessionStatus(context.sessionId);
  return {
    agent_id: '',
    options: {},
    session_id: context.sessionId,
    execution_id: context.executionId,
    artifact_directory: context.artifactDirectory,
    failure_reason: failureReason,
    failure_kind: '',
    reset_at: '',
    client: '',
    outcome_status: outcomeStatus,
    outcome_decision: '',
    session_status: typeof sessionStatus.status === 'string' ? sessionStatus.status : '',
    response: '',
    execution_status: failureReason === '' ? 'completed' : 'failed',
  };
}
