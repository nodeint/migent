import type { ClientRegistry } from '@nodeint/migent-kernel';
import { CancellationRequested } from '@nodeint/migent-kernel';
import { formatClock, log } from '@nodeint/migent-kernel';
import { VERIFY_FAILED } from '@nodeint/migent-kernel';
import { StageOutcome } from '@nodeint/migent-kernel';
import { formatVerifyReport, VerifyRunner, type VerifyRunResult } from '@nodeint/migent-kernel';
import { AgentSessionRecord, type ExecutionContext,SessionStore } from '@nodeint/migent-session';
import { parseExecutionId } from '@nodeint/migent-session';
import type { VerifyOnlyStageSpec } from '@nodeint/migent-workflow';

import type { RunResult } from './agent-runner.js';
import { ProviderEventReporter } from './provider-events.js';

const VERIFY_TURN = 1;

export async function runVerifyOnlyStage(input: {
  workspace: string;
  sessionId: string;
  stage: VerifyOnlyStageSpec;
  verifyRunner: VerifyRunner;
  clients?: ClientRegistry;
  /** Reuse a cancelled execution that has already been reopened. */
  executionId?: string | null;
  onExecution?: (executionId: string) => void;
}): Promise<RunResult> {
  const store = new SessionStore(input.workspace, undefined, input.clients);
  const context = openContext(store, input);
  input.onExecution?.(context.executionId);
  if ((input.executionId === null || input.executionId === undefined)) {
    log(startLine(input.stage, parseExecutionId(context.executionId)?.attempt ?? null));
  }
  const reporter = new ProviderEventReporter({ store, context }, { client: '', model: '' });
  reporter.emit('verify.started', `${input.stage.verify.length} command(s)`, {
    turn: VERIFY_TURN,
    commands: input.stage.verify,
  });
  const record = new AgentSessionRecord({ client: '', model: '', workspace: input.workspace, status: 'running' });
  const result = await runVerifyCommands(input, { store, context, record, reporter });
  const passed = result.passed && result.infraError === null;
  const red = passed ? 0 : 1;
  const report = store.saveTurnVerify(
    context,
    VERIFY_TURN,
    formatVerifyReport(result, {
      run: 1,
      red,
      maxVerify: 1,
      timeoutSec: input.stage.verifyTimeoutSec,
    }),
  );
  if (passed) {
    reporter.emit('verify.passed', 'all commands passed', { turn: VERIFY_TURN, report });
    const outcome = new StageOutcome('complete');
    store.saveExecution(context, record, { status: 'completed', outcome });
    store.publishVerifyReport(context, VERIFY_TURN);
    return executionJson(store, context, { outcomeStatus: 'complete', failureReason: '' });
  }
  return recordVerifyFailure({ store, context, record, reporter }, result, report);
}

// Runs the stage's verify list, marking the execution cancelled when the run is cancelled.
async function runVerifyCommands(
  input: { workspace: string; stage: VerifyOnlyStageSpec; verifyRunner: VerifyRunner },
  target: {
    store: SessionStore;
    context: ExecutionContext;
    record: AgentSessionRecord;
    reporter: ProviderEventReporter;
  },
): Promise<VerifyRunResult> {
  const { store, context, record, reporter } = target;
  try {
    return await input.verifyRunner.run({
      commands: input.stage.verify,
      workspace: input.workspace,
      executionDirectory: context.directory,
      turnDirectory: store.turnDirectory(context, VERIFY_TURN),
      timeoutSec: input.stage.verifyTimeoutSec,
      onStart: (info) => {
        store.saveProcessMetadata(context, info);
      },
      onEnd: () => {
        store.clearProcessEndpoint(context);
      },
      onHeartbeat: (command, elapsed) => {
        reporter.emit('verify.heartbeat', `${command} running for ${elapsed}s`, {
          turn: VERIFY_TURN,
          command,
          elapsed_seconds: elapsed,
        });
      },
    });
  } catch (error) {
    if (error instanceof CancellationRequested) {
      record.status = 'cancelled';
      store.saveExecution(context, record, { status: 'cancelled' });
      log(`Execution ${context.executionId} marked cancelled.`);
    }
    throw error;
  }
}

// Reports the failed command and marks the execution failed.
function recordVerifyFailure(
  target: {
    store: SessionStore;
    context: ExecutionContext;
    record: AgentSessionRecord;
    reporter: ProviderEventReporter;
  },
  result: VerifyRunResult,
  report: string,
): RunResult {
  const { store, context, record, reporter } = target;
  const failed = result.commands.find((item) => item.status === 'fail' || item.status === 'timed_out');
  const error = result.infraError ?? `Verify failed: ${failed?.command ?? 'verify'}`;
  reporter.emit('verify.failed', `${failed?.command ?? 'verify'} failed`, {
    turn: VERIFY_TURN,
    command: failed?.command ?? null,
    status: failed?.status ?? null,
    exit_code: failed?.exitCode ?? null,
    report,
  });
  store.saveExecution(context, record, { status: 'failed', error, extra: { failure_reason: VERIFY_FAILED } });
  return executionJson(store, context, { outcomeStatus: '', failureReason: VERIFY_FAILED });
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
