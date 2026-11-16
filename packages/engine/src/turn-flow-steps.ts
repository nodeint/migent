/**
 * Turn-loop steps that drive the flow: the provider invocation, the correction gate, the verify run,
 * and the repair turn. Each takes explicit inputs and returns what the loop applies; none reads
 * `TurnLoop` state. The loop keeps the ordering visible in `iterate`.
 */
import { rmSync } from 'node:fs';

import type { ExecutionStatus } from '@nodeint/migent-contracts';
import {
  CancellationRequested, CORRECTION_POLICY, type CorrectionFiles, type CorrectionLedger, decideCorrection,
  flattenHistory, formatVerifyReport, type GateFailure, log, type VerifyRunner, type VerifyRunResult,
} from '@nodeint/migent-kernel';
import { renderProviderPrompt } from '@nodeint/migent-prompts';
import type { AgentSessionRecord, ExecutionContext, SessionStore } from '@nodeint/migent-session';
import { allStageArtifacts, type StageSpec } from '@nodeint/migent-workflow';

import type { ProviderEventReporter } from './provider-events.js';
import {
  failStage, type FailureState, finalFields, outcomeFields, type VerifyOutcome, type VerifyState,
verifyVerdict, } from './turn-persist-steps.js';
import { assessProviderTurn, buildRepairPrompt, type GateEvaluation, type Step } from './turn-steps.js';
import {
  type Iteration, promptArtifactFiles, type RunTurnArgs, sessionPaths, type TurnResult,
} from './turn-types.js';

type SessionTarget = { record: AgentSessionRecord; store: SessionStore; context: ExecutionContext };

/** What the prompt of a correction or repair turn needs from the loop. */
export interface PromptInputs {
  readonly sessionId: string | null;
  readonly stage: StageSpec | null;
  readonly decisionValues: readonly string[];
  readonly artifactName: string | null;
  readonly ask: 'human' | null;
  readonly protocol: number;
  readonly files: CorrectionFiles;
}

/** Marks the execution cancelled when the error is a cancellation request, then rethrows. */
export function markCancelled(target: SessionTarget & { eventReporter: ProviderEventReporter }, error: unknown): never {
  const { record, store, context, eventReporter } = target;
  if (error instanceof CancellationRequested) {
    eventReporter.emit('provider.cancelled', 'cancellation requested');
    record.status = 'cancelled';
    store.save(record, context);
    store.saveExecution(context, record, { status: 'cancelled' });
    log(`Execution ${context.executionId} marked cancelled.`);
  }
  throw error;
}

/** The result of the invoke step: the gate evaluation seed and the turn's failure classification. */
export interface InvokeResult {
  readonly evaluation: GateEvaluation;
  readonly classification: TurnResult['classification'];
}

// Signal-file cleanup, the provider turn, and the exit-only/candidate/eligibility computation.
export async function invoke(
  loop: {
    turnArgs: RunTurnArgs; signalFile: string; keepFile: boolean;
    record: AgentSessionRecord; profile: Record<string, string>; workspacePath: string;
  },
  runTurn: (args: RunTurnArgs) => Promise<TurnResult>,
): Promise<InvokeResult> {
  const { turnArgs, record, profile, workspacePath } = loop;
  // A request file left by an earlier turn must not be read as a new question. The
  // correction turn keeps the invalid file so the agent can repair it.
  if (!loop.keepFile) rmSync(loop.signalFile, { force: true });
  let turnResult: TurnResult;
  try {
    turnResult = await runTurn(turnArgs);
  } catch (error) {
    const { store, context, eventReporter } = turnArgs;
    return markCancelled({ record, store, context, eventReporter }, error);
  }
  const evaluation = assessProviderTurn(
    { record, model: turnArgs.model, profile, workspacePath, turn: turnArgs.turn }, turnResult,
  );
  return { evaluation, classification: turnResult.classification };
}

/** The loop state a queued correction or repair turn replaces. */
export interface QueuedTurn {
  readonly turn: number;
  readonly currentPrompt: string;
  readonly currentAgentId: string | null;
}

/** A correction turn the policy granted, with the ledger and keep-file flag the loop applies. */
export interface QueuedCorrection extends QueuedTurn {
  readonly corrections: CorrectionLedger;
  readonly keepFile: boolean;
}

// Queue one correction turn when the policy grants it. Null when the budget for the kind is used.
export function queueCorrection(
  loop: SessionTarget & PromptInputs & {
    eventReporter: ProviderEventReporter; corrections: CorrectionLedger; turn: number;
  },
  failure: GateFailure,
): QueuedCorrection | null {
  const { store, context, record, stage, files, eventReporter } = loop;
  const rule = CORRECTION_POLICY[failure.kind];
  const decision = decideCorrection(failure.kind, loop.corrections, loop.turn);
  if (decision === 'exhausted') return null;
  let {corrections} = loop;
  // The budget is persisted before the message joins the history, so a stop between the two
  // writes sends the correction again on resume and never grants a second.
  if (decision === 'correct') {
    // Spends the correction budget for this failure kind and announces the correction turn.
    corrections = {
      ...corrections,
      [failure.kind]: { turn: loop.turn, error_kind: failure.errorKind, error_detail: failure.detail },
    };
    store.saveExecutionProgress(context, record, { corrections });
    let fileField: Record<string, unknown> = {};
    if (failure.kind === 'question_file') fileField = { file: files.questionFile };
    else if (failure.kind === 'handoff') fileField = { file: files.handoffFile };
    eventReporter.emit(CORRECTION_POLICY[failure.kind].event, `${failure.errorKind}: ${failure.detail}`, {
      turn: loop.turn, error_kind: failure.errorKind, ...fileField,
    });
  }
  const used = corrections[failure.kind];
  if (used === undefined) throw new Error(`Correction ledger has no entry for ${failure.kind} after a ${decision} decision.`);
  const message = rule.render(used, files);
  record.history.push({ role: 'user', content: message });
  store.save(record, context);
  store.saveExecutionProgress(context, record, { turn_kind: rule.turnKind, pending_turn: loop.turn + 1 });
  const base = record.agentId
    ? message
    : flattenHistory(record.history as { role: string; content: string }[]);
  const currentPrompt = renderProviderPrompt(base, { ...sessionPaths(context, loop.sessionId),
    contract: record.agentId ? rule.contract : 'full', turn: rule.turnKind, decisionValues: loop.decisionValues,
    decisionInstructions: stage?.decisionInstructions, ask: loop.ask, protocol: loop.protocol,
    questionFile: files.questionFile, handoffFile: files.handoffFile, artifactDirectory: context.artifactDirectory,
    artifactName: loop.artifactName,
    artifactFiles: promptArtifactFiles(stage === null ? [] : allStageArtifacts(stage)),
  });
  return { turn: loop.turn + 1, currentPrompt, currentAgentId: record.agentId, corrections, keepFile: rule.keepFile };
}

/** What the gate step decided, for the loop to apply. */
export interface GateResult {
  readonly step: Step;
  readonly queued: QueuedCorrection | null;
  readonly failureReason: string;
  readonly failureDetail: string;
}

// A gate failure: queue a correction, or fail the stage with the original error and the kind's reason.
// A fresh turn also ends here when no verify follows; a resumed saved reply goes on to the verify check.
export function gate(
  loop: SessionTarget & PromptInputs & {
    eventReporter: ProviderEventReporter; corrections: CorrectionLedger; verify: VerifyState; failure: FailureState;
    failureDetail: string; fresh: boolean; turn: number;
  },
  it: Iteration,
): GateResult {
  let { failure, failureDetail } = loop;
  const result = (step: Step, queued: QueuedCorrection | null = null): GateResult => ({
    step, queued, failureReason: failure.failureReason, failureDetail,
  });
  const gated = loop.fresh ? it.eligible : it.eligible && it.pendingGate;
  if (it.gateFailure !== null && gated) {
    const queued = queueCorrection(loop, it.gateFailure);
    if (queued !== null) return result('continue', queued);
    const rule = CORRECTION_POLICY[it.gateFailure.kind];
    failure = { ...failure, failureReason: rule.failureReason };
    failureDetail = rule.detail(it.gateFailure, loop.files);
    if (it.gateFailure.kind === 'question_file' || it.gateFailure.kind === 'handoff') {
      const ended = outcomeFields(loop.verify, failure);
      failure = { ...failure, failureReason: ended.failureReason };
      failStage(loop, failureDetail, finalFields(loop.verify.turn, ended.fields));
      return result('stop');
    }
  }
  if (loop.fresh && (!it.needsVerify || it.outcome === null)) {
    const ended = outcomeFields(loop.verify, failure);
    failure = { ...failure, failureReason: ended.failureReason };
    saveFinished(loop, it, finalFields(loop.verify.turn, ended.fields));
    return result('stop');
  }
  return result('proceed');
}

// A fresh turn that ends without verify saves the execution with the status persistTurn set.
function saveFinished(target: SessionTarget, it: Iteration, extra: Record<string, unknown>): void {
  const { record, store, context } = target;
  store.saveExecution(context, record, {
    // event-template: unchecked (persistTurn set completed or failed)
    status: record.status as ExecutionStatus,
    error: it.invokeError,
    outcome: it.outcome,
    extra,
  });
}

/** What the verify step produced: the counters to apply and the verdict. */
export interface VerifyStepResult {
  readonly verifyRuns: number;
  readonly lastReport: string;
  readonly lastResult: 'pass' | 'fail';
  readonly outcome: VerifyOutcome;
}

// Runs the verify commands, saves the report, and decides: a repair turn follows a red run;
// every other result ends the execution.
export async function verify(
  loop: SessionTarget & {
    eventReporter: ProviderEventReporter; verify: VerifyState; stage: StageSpec | null; workspacePath: string;
    verifyRunner: Pick<VerifyRunner, 'run'>;
  },
  it: Iteration,
): Promise<VerifyStepResult> {
  const { store, context, eventReporter, stage, verify: state } = loop;
  store.clearProcessEndpoint(context);
  eventReporter.emit('verify.started', `${state.verifyCommands.length} command(s)`, {
    turn: state.turn,
    commands: state.verifyCommands,
  });
  let result: VerifyRunResult;
  try {
    result = await loop.verifyRunner.run({
      commands: [...state.verifyCommands],
      workspace: loop.workspacePath,
      executionDirectory: context.directory,
      turnDirectory: store.turnDirectory(context, state.turn),
      timeoutSec: stage?.verifyTimeoutSec ?? null,
      onStart: (info) => {
        store.saveProcessMetadata(context, info);
      },
      onEnd: () => {
        store.clearProcessEndpoint(context);
      },
      onHeartbeat: (command, elapsed) => {
        eventReporter.emit('verify.heartbeat', `${command} running for ${elapsed}s`, {
          turn: state.turn,
          command,
          elapsed_seconds: elapsed,
        });
      },
    });
  } catch (error) {
    return markCancelled(loop, error);
  }
  const verifyRuns = state.verifyRuns + 1;
  const lastReport = store.saveTurnVerify(
    context,
    state.turn,
    formatVerifyReport(result, {
      run: verifyRuns,
      red: result.passed ? state.red : state.red + 1,
      maxVerify: state.maxVerify,
      timeoutSec: stage?.verifyTimeoutSec ?? null,
    }),
  );
  const lastResult = result.passed ? 'pass' : 'fail';
  const outcome = verifyVerdict(
    { target: loop, state: { ...state, verifyRuns, lastReport, lastResult }, lastReport }, it, result,
  );
  return { verifyRuns, lastReport, lastResult, outcome };
}

// Queues the repair turn that follows a failed verify run.
export function queueRepair(
  loop: SessionTarget & PromptInputs & { red: number; maxVerify: number; turn: number },
  lastReport: string,
): QueuedTurn {
  const { record, store, context, stage, artifactName, files } = loop;
  const repair = buildRepairPrompt({ context, artifactName, red: loop.red, maxVerify: loop.maxVerify }, lastReport);
  record.history.push({ role: 'user', content: repair });
  store.save(record, context);
  // pending_turn keeps resume from counting a turn short after an empty reply.
  store.saveExecutionProgress(context, record, { turn_kind: 'repair', pending_turn: loop.turn + 1 });
  const currentAgentId = record.agentId;
  const base = currentAgentId ? repair : flattenHistory(record.history as { role: string; content: string }[]);
  const currentPrompt = renderProviderPrompt(base, { ...sessionPaths(context, loop.sessionId),
    contract: currentAgentId ? 'reminder' : 'full', turn: 'repair', decisionValues: loop.decisionValues,
    decisionInstructions: stage?.decisionInstructions, ask: loop.ask, protocol: loop.protocol,
    questionFile: files.questionFile, handoffFile: files.handoffFile,
    artifactDirectory: context.artifactDirectory, artifactName,
    artifactFiles: promptArtifactFiles(stage === null ? [] : allStageArtifacts(stage)),
  });
  return { turn: loop.turn + 1, currentPrompt, currentAgentId };
}

