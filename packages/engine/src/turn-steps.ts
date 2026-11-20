/**
 * Pure turn helpers: provider-turn assessment, the output and outcome gates, verify fields, and the repair prompt.
 * Nothing here writes: the execution layer proposes every write as a change.
 */
import { statSync } from 'node:fs';
import path from 'node:path';

import {
  buildVerifyRepairPrompt, classifyGateError, CORRECTION_FAILURE_REASONS, type ExtensionRule,
  type FailureClassification, type GateFailure,
  type Gates, HandoffFileError, nonemptyArtifact, QuestionFileError, resolveStageOutcome,
  type ResponseSource, type StageOutcome, truncateText,
} from '@nodeint/migent-kernel';
import type { ExecutionContext, SessionStore } from '@nodeint/migent-session';
import { isWorkflowV2, stageArtifactsFor, type StageSpec } from '@nodeint/migent-workflow';

import { frozenDocument, type TurnResult } from './turn-types.js';

/** What one pass of the loop produced. */
export interface Iteration {
  readonly responseText: string;
  readonly outcome: StageOutcome | null;
  readonly invokeError: string | null;
  readonly gateFailure: GateFailure | null;
  readonly eligible: boolean;
  readonly pendingGate: boolean;
  readonly needsVerify: boolean;
}

/** What the gates of one fresh turn start from, and what they may change. */
export interface GateSeed {
  readonly gates: Gates;
  readonly candidate: boolean;
  readonly anomalyReason: string | null;
  readonly turnError: string | null;
}

/** The gate verdicts an output check produced, and the failure that goes with them. */
export interface OutputCheck {
  failure: GateFailure | null;
  gates: Partial<Gates>;
}

/** What the gates decided about one fresh turn. */
export interface GateEvaluation {
  iteration: Iteration;
  seed: GateSeed;
}

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

// Outcome resolution, the artifact and completion-output gates, and candidate rejection.
export function evaluateGates(
  loop: {
    sessionId: string | null; decisionValues: string[]; ask: 'human' | null; protocol: number;
    extensions?: readonly ExtensionRule[]; questionFile: string; handoffFile: string; artifactName: string | null;
    checkOutputs: (reply: StageOutcome) => OutputCheck;
  },
  it: Iteration,
  seed: GateSeed,
): GateEvaluation {
  const resolved = it.invokeError === null ? resolveOutcomeGate(loop, it) : { ...it, outcomeGate: seed.gates.outcome };
  const gates: Gates = { ...seed.gates, outcome: resolved.outcomeGate };
  if (loop.artifactName === null) gates.artifact = { state: 'not-applicable' };
  else if (gates.outcome.state !== 'not-evaluated' && resolved.outcome?.status !== 'complete') {
    gates.artifact = { state: 'not-applicable' };
  }
  const { outcome, invokeError, gateFailure } = resolved;
  const checked = checkOutputGates(loop, { outcome, invokeError, gateFailure }, gates);
  return rejectCandidate({ ...it, ...checked.iteration }, { ...seed, gates: checked.gates });
}

type GateResult = Pick<Iteration, 'outcome' | 'invokeError' | 'gateFailure'>;

// Resolves the stage outcome from the reply, with the outcome gate verdict.
function resolveOutcomeGate(
  loop: Parameters<typeof evaluateGates>[0],
  it: Iteration,
): GateResult & { outcomeGate: Gates['outcome'] } {
  try {
    const outcome = resolveStageOutcome(it.responseText, {
      required: loop.sessionId !== null, decisionValues: loop.decisionValues, ask: loop.ask,
      protocol: loop.protocol, questionFile: loop.questionFile, handoffFile: loop.handoffFile,
      extensions: loop.extensions ?? [],
    });
    const outcomeGate: Gates['outcome'] = { state: 'passed', ...(outcome === null ? {} : { status: outcome.status }) };
    return { outcome, invokeError: it.invokeError, gateFailure: it.gateFailure, outcomeGate };
  } catch (error) {
    const gateFailure = classifyGateError(error);
    const base = { outcome: it.outcome, invokeError: it.invokeError, gateFailure };
    if (error instanceof QuestionFileError) {
      return { ...base, outcomeGate: { state: 'failed', reason: `question file unusable (${error.kind})` } };
    }
    if (error instanceof HandoffFileError) {
      return { ...base, outcomeGate: { state: 'failed', reason: `handoff file unusable (${error.kind})` } };
    }
    if (!(error instanceof Error)) throw error;
    return {
      ...base, invokeError: error.message, outcomeGate: { state: 'failed', reason: truncateText(error.message) },
    };
  }
}

// The completion-output gates, run only on a resolved outcome with no earlier failure.
function checkOutputGates(
  loop: Parameters<typeof evaluateGates>[0],
  result: GateResult,
  gates: Gates,
): { iteration: GateResult; gates: Gates } {
  const { outcome, invokeError, gateFailure } = result;
  if (invokeError !== null || gateFailure !== null || outcome === null) return { iteration: result, gates };
  const checked = loop.checkOutputs(outcome);
  const merged = { ...gates, ...checked.gates };
  if (checked.failure === null) return { iteration: result, gates: merged };
  return { iteration: { outcome, invokeError: checked.failure.detail, gateFailure: checked.failure }, gates: merged };
}

// A candidate turn that failed a gate is rejected: the error is the model text, the failed gate the reason.
function rejectCandidate(it: Iteration, seed: GateSeed): GateEvaluation {
  const { invokeError, gateFailure } = it;
  const rejection = invokeError ?? (gateFailure === null ? null : `${gateFailure.errorKind}: ${gateFailure.detail}`);
  if (!seed.candidate || rejection === null) return { iteration: it, seed };
  return {
    iteration: { ...it, invokeError: it.responseText },
    seed: { ...seed, anomalyReason: rejection, turnError: it.responseText },
  };
}

/** The verify counters the execution fields report. */
export interface VerifyFacts {
  readonly verifyCommands: readonly string[];
  readonly turn: number;
  readonly lastResult: 'pass' | 'fail' | null;
  readonly lastReport: string | null;
  readonly verifyRuns: number;
  readonly red: number;
  readonly maxVerify: number;
}

export function verifyFields(facts: VerifyFacts, reason: string | null): Record<string, unknown> | null {
  if (facts.verifyCommands.length === 0) return null;
  const fields: Record<string, unknown> = { turns: facts.turn };
  if (facts.lastResult !== null && facts.lastReport !== null) {
    fields.verify = {
      runs: facts.verifyRuns,
      red: facts.red,
      max_verify: facts.maxVerify,
      last_result: facts.lastResult,
      last_report: facts.lastReport,
    };
  }
  if (reason !== null) fields.failure_reason = reason;
  return fields;
}

// The last provider turn this execution ran; failure.md joins diagnostics.json to it.
export function finalFields(turn: number, extra: Record<string, unknown> | null): Record<string, unknown> {
  return { ...(extra ?? {}), final_turn: turn };
}

// The failure fields a finished stage saves. A quota classification sets the failure reason as a side result.
export function outcomeFields(
  facts: VerifyFacts,
  failure: { failureReason: string; classification: FailureClassification | null },
): { fields: Record<string, unknown> | null; failureReason: string } {
  if (CORRECTION_FAILURE_REASONS.includes(failure.failureReason)) {
    return {
      fields: { ...(verifyFields(facts, null) ?? {}), failure_reason: failure.failureReason },
      failureReason: failure.failureReason,
    };
  }
  const { classification } = failure;
  if (classification?.kind !== 'quota') {
    return { fields: verifyFields(facts, null), failureReason: failure.failureReason };
  }
  return {
    fields: {
      ...(verifyFields(facts, null) ?? {}),
      failure_reason: 'quota',
      retry_at: classification.resetAt,
      ...(classification.window ? { quota_window: classification.window } : {}),
    },
    failureReason: 'quota',
  };
}

// The repair prompt that follows a failed verify run. The report text is passed in: the applier has not saved it yet.
export function buildRepairPrompt(
  loop: { context: ExecutionContext; artifactName: string | null; red: number; maxVerify: number },
  report: string,
): string {
  const { context, artifactName } = loop;
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

/** What one provider turn means before any gate runs. */
export interface TurnAssessment {
  readonly responseText: string;
  readonly invokeError: string | null;
  readonly exitCode: number | null;
  readonly parsedSource: ResponseSource | undefined;
  readonly source: ResponseSource;
  readonly classification: FailureClassification | null;
  /** The conversation's agent id once this turn is recorded. */
  readonly agentId: string | null;
  readonly turnDetails: Record<string, unknown>;
  readonly recordsTurn: boolean;
  readonly exitOnly: boolean;
  readonly candidate: boolean;
  readonly eligible: boolean;
  readonly anomalyReason: string | null;
  readonly exitMessage: string | null;
  readonly turnError: string | null;
}

// The exit-only/candidate/eligibility computation for one provider turn.
export function assessProviderTurn(
  loop: { priorAgentId: string | null; turn: number },
  turnResult: TurnResult,
): TurnAssessment {
  const { source: parsedSource, exitCode, responseText, classification } = turnResult;
  // An abnormal provider turn leaves a record whatever the gates decide: a failed start or
  // exit, or a provider-reported error at exit 0. A timeout or an unpassable argument has neither.
  const recordsTurn = turnResult.failure !== undefined || (exitCode === 0 && classification !== null);
  const agentId = turnResult.sessionId || loop.priorAgentId;
  const turnDetails: Record<string, unknown> = { turn: loop.turn, agent_id: agentId, argv: turnResult.argv };
  if (turnResult.usage !== null) turnDetails.usage = turnResult.usage;
  // A provider that does not attest the source of its text is trusted only on a clean exit.
  const source: ResponseSource = parsedSource ?? (classification === null ? 'model' : 'none');
  const exitOnly = classification?.origin === 'exit-only';
  // A non-zero exit alone does not decide the turn. A reply the model wrote still goes
  // through every gate an exit-0 turn passes; the provider's own error text never does.
  const candidate = exitOnly && source === 'model' && responseText.trim() !== '';
  // Only a reply the model wrote can be corrected: no start failure, timeout or provider verdict.
  const eligible = candidate || (classification === null && exitCode === 0 && turnResult.failure === undefined);
  const { invokeError, anomalyReason } = exitOnlyVerdict(turnResult, candidate, exitOnly);
  return {
    responseText, invokeError, exitCode, parsedSource, source, classification, agentId, turnDetails, recordsTurn,
    exitOnly, candidate, eligible, anomalyReason, exitMessage: turnResult.invokeError,
    // The turn event follows the provider verdict only; later gates never rename it.
    turnError: invokeError,
  };
}

// A candidate clears the provider error; any other exit-only turn records why it is not accepted.
function exitOnlyVerdict(
  turnResult: TurnResult,
  candidate: boolean,
  exitOnly: boolean,
): { invokeError: string | null; anomalyReason: string | null } {
  if (candidate) return { invokeError: null, anomalyReason: null };
  if (!exitOnly) return { invokeError: turnResult.invokeError, anomalyReason: null };
  const empty = turnResult.responseText.trim() === '';
  return {
    invokeError: empty ? turnResult.invokeError : turnResult.responseText,
    anomalyReason: empty ? 'no reply' : 'reply is not model output',
  };
}
