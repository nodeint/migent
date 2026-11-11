/**
 * Turn-loop steps that run on a snapshot of loop state: turn assessment, gates, turn events,
 * diagnostics, verify fields, the repair prompt, and the run result.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  buildTurnDiagnostics, buildVerifyRepairPrompt, classifyGateError, type FailureClassification, type GateFailure,
  type Gates, HandoffFileError, nonemptyArtifact, observeTurn, QuestionFileError, resolveStageOutcome,
  type ResponseSource, type StageOutcome, truncateText,
} from '@nodeint/migent-kernel';
import type { AgentSessionRecord, ExecutionContext, SessionStore } from '@nodeint/migent-session';
import { isWorkflowV2, stageArtifactsFor, type StageSpec } from '@nodeint/migent-workflow';

import type { ProviderEventReporter } from './provider-events.js';
import { type FreshTurn, frozenDocument, type Iteration, type RunResult, type TurnResult } from './turn-types.js';

export type Step = 'continue' | 'stop' | 'proceed';

/** The gate verdicts an output check produced, and the failure that goes with them. */
export interface OutputCheck {
  failure: GateFailure | null;
  gates: Partial<Gates>;
}

/** What the gates decided about one fresh turn. */
export interface GateEvaluation {
  iteration: Iteration;
  fresh: FreshTurn;
}

/** What persisting one turn decided. */
export interface PersistVerdict {
  needsVerify: boolean;
  modelResponded: boolean;
  recordedClassification: FailureClassification | null;
}

/** How the verify run ends: a repair turn follows, or the execution ends with this outcome. */
export type VerifyVerdict = { kind: 'repair'; report: string } | { kind: 'end'; outcome: StageOutcome | null };

// The artifact and completion-output gates. Fresh turns and resumed saved replies both run them.
export function checkOutputs(
  target: { stage: StageSpec | null; artifactName: string | null; context: ExecutionContext; store: SessionStore },
  reply: StageOutcome,
): OutputCheck {
  const { stage, artifactName, context, store } = target;
  let gates: Partial<Gates> = {};
  if (stage !== null && artifactName && reply.status === 'complete') {
    const missing = stageArtifactsFor(stage, reply.decision ?? null)
      .filter((item) => item.required && !nonemptyArtifact(path.join(context.artifactDirectory, item.file)))
      .map((item) => item.file);
    const detail = `Stage artifact missing or empty: ${missing.join(', ')}.`;
    if (missing.length > 0) {
      return {
        failure: { kind: 'stage_output', errorKind: 'artifact', detail },
        gates: { artifact: { state: 'failed', reason: detail } },
      };
    }
    gates = { artifact: { state: 'passed' } };
  }
  if (isWorkflowV2(frozenDocument(context))) {
    return { failure: null, gates: { ...gates, completion_outputs: { state: 'not-applicable' } } };
  }
  const missing = store.missingCompletionOutputs(context, reply);
  if (missing.length > 0) {
    const detail = `Completion outputs missing or empty: ${missing.join(', ')}.`;
    return {
      failure: { kind: 'stage_output', errorKind: 'completion_outputs', detail },
      gates: { ...gates, completion_outputs: { state: 'failed', reason: detail } },
    };
  }
  return { failure: null, gates: { ...gates, completion_outputs: { state: 'passed' } } };
}

// Turn completed or failed, quota, and exit anomaly events. Emitted before persistTurn resets the classification.
export function emitTurnEvents(
  loop: { eventReporter: ProviderEventReporter; classification: FailureClassification | null; turn: number },
  it: Iteration,
  fresh: FreshTurn,
): void {
  const { eventReporter, classification } = loop;
  const { turnError, turnDetails, exitOnly, anomalyReason } = fresh;
  const { exitCode } = fresh.turnResult;
  eventReporter.emit(
    turnError === null ? 'provider.turn_completed' : 'provider.turn_failed',
    turnError === null ? 'completed' : turnError,
    turnDetails,
  );
  if (classification?.kind === 'quota') {
    const resetAt = classification.resetAt ?? '';
    eventReporter.emit(
      'provider.quota',
      [classification.message, resetAt].filter((item) => item !== '').join(' '),
      {
        retry_at: resetAt,
        client: eventReporter.client,
        ...(classification.window ? { window: classification.window } : {}),
      },
    );
  }
  if (exitOnly) {
    eventReporter.emit(
      'provider.exit_anomaly',
      it.invokeError === null || anomalyReason === null
        ? `exit ${exitCode} with a usable reply; accepted`
        : `exit ${exitCode}; rejected: ${anomalyReason}`,
      {
        turn: loop.turn,
        client: eventReporter.client,
        exit_code: exitCode,
        signal: null,
        origin: 'exit-only',
        accepted: anomalyReason === null,
        reason: anomalyReason,
      },
    );
  }
}

// The only writer of diagnostics.json: once this turn's gates have run, before any verify or follow-up turn.
export function writeTurnDiagnostics(
  loop: {
    record: AgentSessionRecord; store: SessionStore; context: ExecutionContext;
    artifactName: string | null; turn: number;
  },
  it: Iteration,
  fresh: FreshTurn,
): void {
  if (!fresh.recordsTurn) return;
  const { record, store, context, artifactName } = loop;
  const { turnResult, exitOnly, anomalyReason, recordedClassification } = fresh;
  const accepted = exitOnly && anomalyReason === null;
  const anomalyText = anomalyReason === null ? null : truncateText(anomalyReason);
  const reason = exitOnly
    ? anomalyText
    : truncateText(recordedClassification?.message ?? fresh.exitMessage ?? 'provider failure');
  const errors = recordedClassification?.origin === 'provider-error' ? [recordedClassification.message] : [];
  const stream = turnResult.summarizer.finish(
    { bytes: turnResult.facts?.stdoutBytes ?? 0, lines: turnResult.facts?.stdoutLines ?? 0 },
    errors,
  );
  store.saveDiagnostics(context, buildTurnDiagnostics({
    turn: loop.turn,
    agentId: record.agentId || null,
    ...(turnResult.failure ? { failure: turnResult.failure } : {}),
    ...(turnResult.facts ? { facts: turnResult.facts } : {}),
    classification: recordedClassification,
    stream,
    resultState: {
      observed: observeTurn({
        source: fresh.parsedSource,
        responseText: it.responseText,
        artifactPath: artifactName ? path.join(context.artifactDirectory, artifactName) : null,
        responseWritten: fresh.modelResponded,
        conversationTurns: record.history.filter((item) => item.role === 'assistant').length,
      }),
      gates: fresh.gates,
      turn_verdict: accepted ? 'accepted' : 'failed',
      reason,
    },
  }));
}

export function buildRunResult(
  loop: {
    record: AgentSessionRecord; store: SessionStore; context: ExecutionContext;
    eventReporter: ProviderEventReporter; classification: FailureClassification | null;
    failureReason: string; failureDetail: string;
  },
  it: Iteration,
): RunResult {
  const { record, store, context, eventReporter, classification } = loop;
  const { outcome } = it;
  const sessionStatus = store.readSessionStatus(context.sessionId);
  return {
    agent_id: record.agentId || '',
    options: { ...record.options },
    session_id: context.sessionId,
    execution_id: context.executionId,
    artifact_directory: context.artifactDirectory,
    outcome_status: outcome?.status ?? '',
    ...(outcome?.status === 'question' ? {
      questions: outcome.questions, questions_file: path.join(context.directory, 'questions.json'),
    } : {}),
    outcome_decision: outcome?.decision ?? '',
    session_status: typeof sessionStatus.status === 'string' ? sessionStatus.status : '',
    response: it.responseText,
    failure_reason: loop.failureReason,
    ...(loop.failureDetail === '' ? {} : { failure_detail: loop.failureDetail }),
    failure_kind: classification?.kind ?? '',
    reset_at: classification?.kind === 'quota' && classification.resetAt ? classification.resetAt : '',
    client: eventReporter.client,
    execution_status: record.status,
  };
}

// Outcome resolution, the artifact and completion-output gates, and candidate rejection.
export function evaluateGates(
  loop: {
    sessionId: string | null; decisionValues: string[]; ask: 'human' | null; protocol: number;
    questionFile: string; handoffFile: string; artifactName: string | null;
    checkOutputs: (reply: StageOutcome) => OutputCheck;
  },
  it: Iteration,
  fresh: FreshTurn,
): GateEvaluation {
  let { outcome, invokeError, gateFailure } = it;
  let gates: Gates = { ...fresh.gates };
  if (invokeError === null) {
    try {
      outcome = resolveStageOutcome(it.responseText, {
        required: loop.sessionId !== null, decisionValues: loop.decisionValues, ask: loop.ask,
        protocol: loop.protocol, questionFile: loop.questionFile, handoffFile: loop.handoffFile,
      });
      gates.outcome = { state: 'passed', ...(outcome === null ? {} : { status: outcome.status }) };
    } catch (error) {
      gateFailure = classifyGateError(error);
      if (error instanceof QuestionFileError) {
        gates.outcome = { state: 'failed', reason: `question file unusable (${error.kind})` };
      } else if (error instanceof HandoffFileError) {
        gates.outcome = { state: 'failed', reason: `handoff file unusable (${error.kind})` };
      } else if (error instanceof Error) {
        invokeError = error.message;
        gates.outcome = { state: 'failed', reason: truncateText(error.message) };
      } else throw error;
    }
  }
  if (loop.artifactName === null) gates.artifact = { state: 'not-applicable' };
  else if (gates.outcome.state !== 'not-evaluated' && outcome?.status !== 'complete') {
    gates.artifact = { state: 'not-applicable' };
  }
  if (invokeError === null && gateFailure === null && outcome !== null) {
    const checked = loop.checkOutputs(outcome);
    gates = { ...gates, ...checked.gates };
    if (checked.failure !== null) {
      gateFailure = checked.failure;
      invokeError = checked.failure.detail;
    }
  }
  let { anomalyReason, turnError } = fresh;
  if (fresh.candidate && (invokeError !== null || gateFailure !== null)) {
    // Rejected: the error is the model text itself, the failed gate is the recorded reason.
    anomalyReason = invokeError ?? `${gateFailure!.errorKind}: ${gateFailure!.detail}`;
    invokeError = it.responseText;
    turnError = invokeError;
  }
  return {
    iteration: { ...it, outcome, invokeError, gateFailure },
    fresh: { ...fresh, gates, anomalyReason, turnError },
  };
}

export function verifyFields(
loop: {
  verifyCommands: string[]; turn: number; lastResult: 'pass' | 'fail' | null; lastReport: string | null;
  verifyRuns: number; red: number; maxVerify: number;
},
reason: string | null,
): Record<string, unknown> | null {
if (loop.verifyCommands.length === 0) return null;
  const fields: Record<string, unknown> = { turns: loop.turn };
  if (loop.lastResult !== null && loop.lastReport !== null) {
    fields.verify = {
      runs: loop.verifyRuns,
      red: loop.red,
      max_verify: loop.maxVerify,
      last_result: loop.lastResult,
      last_report: loop.lastReport,
    };
  }
  if (reason !== null) fields.failure_reason = reason;
  return fields;
}

// The repair prompt that follows a failed verify run.
export function buildRepairPrompt(
  loop: { context: ExecutionContext; artifactName: string | null; red: number; maxVerify: number },
  lastReport: string,
): string {
  const { context, artifactName } = loop;
  const report = readFileSync(path.join(context.directory, lastReport), 'utf8');
  const sessionDirectory = path.dirname(path.dirname(context.directory));
  const taskFile = path.join(sessionDirectory, 'task.md');
  let taskPointer: string | null = null;
  try {
    if (statSync(taskFile).isFile()) taskPointer = taskFile;
  } catch {
    taskPointer = null;
  }
  return buildVerifyRepairPrompt(
    report,
    {
      red: loop.red,
      maxVerify: loop.maxVerify,
      artifactPath: artifactName ? path.join(context.artifactDirectory, artifactName) : null,
    },
    { taskFile: taskPointer, sessionDirectory: taskPointer === null ? null : sessionDirectory },
  );
}

// The exit-only/candidate/eligibility computation for one provider turn; records its agent and profile.
export function assessProviderTurn(
  loop: {
    record: AgentSessionRecord; model: string; profile: Record<string, string>;
    workspacePath: string; turn: number;
  },
  turnResult: TurnResult,
): GateEvaluation {
  const { record, model, profile, workspacePath } = loop;
  const { argv, usage, source: parsedSource, exitCode, responseText } = turnResult;
  let { invokeError } = turnResult;
  const { classification } = turnResult;
  // An abnormal provider turn leaves a record whatever the gates decide: a failed start or
  // exit, or a provider-reported error at exit 0. A timeout or an unpassable argument has neither.
  const recordsTurn = turnResult.failure !== undefined || (exitCode === 0 && classification !== null);
  const gates: Gates = {
    outcome: { state: 'not-evaluated' },
    artifact: { state: 'not-evaluated' },
    completion_outputs: { state: 'not-evaluated' },
  };

  record.agentId = turnResult.sessionId || record.agentId;
  const turnDetails: Record<string, unknown> = {
    turn: loop.turn,
    agent_id: record.agentId,
    argv,
  };
  if (usage !== null) turnDetails.usage = usage;
  record.model = model;
  record.options = profile;
  record.workspace = workspacePath;
  // A provider that does not attest the source of its text is trusted only on a clean exit.
  const source: ResponseSource = parsedSource ?? (classification === null ? 'model' : 'none');
  const exitOnly = classification?.origin === 'exit-only';
  // A non-zero exit alone does not decide the turn. A reply the model wrote still goes
  // through every gate an exit-0 turn passes; the provider's own error text never does.
  const candidate = exitOnly && source === 'model' && responseText.trim() !== '';
  // Only a reply the model wrote can be corrected: no start failure, timeout or provider verdict.
  const eligible = candidate || (classification === null && exitCode === 0 && turnResult.failure === undefined);
  const exitMessage = invokeError;
  let anomalyReason: string | null = null;
  if (candidate) {
    invokeError = null;
  } else if (exitOnly) {
    anomalyReason = responseText.trim() === '' ? 'no reply' : 'reply is not model output';
    invokeError = responseText.trim() === '' ? exitMessage : responseText;
  }
  // The turn event follows the provider verdict only; later gates never rename it.
  const turnError = invokeError;
  return {
    iteration: {
      responseText,
      outcome: null,
      invokeError,
      gateFailure: null,
      eligible,
      pendingGate: false,
      needsVerify: false,
    },
    fresh: {
      turnResult,
      parsedSource,
      source,
      recordsTurn,
      exitOnly,
      candidate,
      exitMessage,
      anomalyReason,
      turnError,
      gates,
      turnDetails,
      modelResponded: false,
      recordedClassification: null,
    },
  };
}
