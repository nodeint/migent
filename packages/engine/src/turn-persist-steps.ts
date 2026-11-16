/**
 * Turn-loop steps that persist and finish: persist a turn, resolve a saved reply, end the stage, and decide verify.
 * Each takes the values it needs and returns what the loop applies; none reads `TurnLoop` state.
 */
import type { ExecutionStatus } from '@nodeint/migent-contracts';
import {
  CORRECTION_FAILURE_REASONS, type FailureClassification, VERIFY_EXHAUSTED, type VerifyRunResult,
} from '@nodeint/migent-kernel';
import type { AgentSessionRecord, ExecutionContext, SessionStore } from '@nodeint/migent-session';
import type { StageSpec } from '@nodeint/migent-workflow';

import type { ProviderEventReporter } from './provider-events.js';
import { checkOutputs, type PersistVerdict, verifyFields, type VerifyVerdict } from './turn-steps.js';
import type { FreshTurn, Iteration, PendingVerify } from './turn-types.js';

/** The verify counters a step reads; the loop owns and updates them. */
export interface VerifyState {
  readonly verifyCommands: readonly string[];
  readonly turn: number;
  readonly lastResult: 'pass' | 'fail' | null;
  readonly lastReport: string | null;
  readonly verifyRuns: number;
  readonly red: number;
  readonly maxVerify: number;
}

/** The failure facts the loop carries between steps. */
export interface FailureState {
  readonly failureReason: string;
  readonly classification: FailureClassification | null;
}

/** The verify result a step decided, with the counter and failure reason the loop applies. */
export interface VerifyOutcome {
  readonly verdict: VerifyVerdict;
  readonly red: number;
  readonly failureReason: string | null;
}

type SessionTarget = { record: AgentSessionRecord; store: SessionStore; context: ExecutionContext };

// The last provider turn this execution ran; failure.md joins diagnostics.json to it.
export function finalFields(turn: number, extra: Record<string, unknown> | null): Record<string, unknown> {
  return { ...(extra ?? {}), final_turn: turn };
}

// Status, conversation history, saved response, and the verify turn outcome.
export function persistTurn(
  loop: SessionTarget & {
    verifyCommands: readonly string[]; classification: FailureClassification | null; turn: number;
  },
  it: Iteration,
  fresh: Pick<FreshTurn, 'source' | 'exitOnly' | 'anomalyReason'>,
): PersistVerdict {
  const { record, store, context, verifyCommands, turn } = loop;
  const { responseText } = it;
  const needsVerify =
    verifyCommands.length > 0 && it.invokeError === null && it.outcome?.status === 'complete';
  const finishedStatus = it.invokeError === null && it.gateFailure === null ? 'completed' : 'failed';
  record.status = needsVerify ? 'running' : finishedStatus;
  // Only a real model reply belongs in the conversation. Error text, and the reply of a
  // turn the provider itself reported as failed, stay out, so a resume cannot replay
  // them as if the model had said them.
  const modelResponded =
    responseText !== '' && fresh.source === 'model' && (loop.classification === null || fresh.exitOnly);
  const recordedClassification = loop.classification;
  // An accepted turn is no longer a failure: nothing downstream may see its classification.
  const classification = fresh.exitOnly && fresh.anomalyReason === null ? null : loop.classification;
  if (modelResponded) record.history.push({ role: 'assistant', content: responseText });
  store.save(record, context);
  saveTurnFiles({ store, context, verifyCommands, turn }, it, modelResponded);
  return { needsVerify, modelResponded, recordedClassification, classification };
}

// The saved response and, under verify, the per-turn response and outcome.
function saveTurnFiles(
  loop: { store: SessionStore; context: ExecutionContext; verifyCommands: readonly string[]; turn: number },
  it: Iteration,
  modelResponded: boolean,
): void {
  const { store, context, turn } = loop;
  const verifying = loop.verifyCommands.length > 0;
  if (modelResponded) {
    store.saveResponse(context, it.responseText);
    if (verifying) store.saveTurnResponse(context, turn, it.responseText);
  }
  if (verifying && it.outcome?.status === 'complete') store.saveTurnOutcome(context, turn, it.outcome);
}

// A saved reply passes the same output gates a fresh one does before it is accepted.
export function resolvePendingVerify(
  target: { stage: StageSpec | null; artifactName: string | null; context: ExecutionContext; store: SessionStore },
  pending: PendingVerify,
): Iteration {
  let { invokeError, gateFailure } = pending;
  if (invokeError === null && gateFailure === null && pending.outcome !== null) {
    const bad = checkOutputs(target, pending.outcome).failure;
    if (bad !== null) {
      gateFailure = bad;
      invokeError = bad.detail;
    }
  }
  return {
    responseText: pending.responseText,
    outcome: pending.outcome,
    invokeError,
    gateFailure,
    eligible: true,
    pendingGate: true,
    needsVerify: false,
  };
}

// Marks the stage failed with the given error and saves the execution.
export function failStage(target: SessionTarget, error: string, extra: Record<string, unknown>): void {
  const { record, store, context } = target;
  record.status = 'failed';
  store.save(record, context);
  store.saveExecution(context, record, { status: 'failed', error, extra });
}

// The failure fields a finished stage saves. A quota classification sets the failure reason as a side result.
export function outcomeFields(
  state: VerifyState,
  failure: FailureState,
): { fields: Record<string, unknown> | null; failureReason: string } {
  if (CORRECTION_FAILURE_REASONS.includes(failure.failureReason)) {
    return {
      fields: { ...(verifyFields(state, null) ?? {}), failure_reason: failure.failureReason },
      failureReason: failure.failureReason,
    };
  }
  const { classification } = failure;
  if (classification?.kind !== 'quota') return { fields: verifyFields(state, null), failureReason: failure.failureReason };
  return {
    fields: {
      ...(verifyFields(state, null) ?? {}),
      failure_reason: 'quota',
      retry_at: classification.resetAt,
      ...(classification.window ? { quota_window: classification.window } : {}),
    },
    failureReason: 'quota',
  };
}

/** Whether the execution ended at this iteration, and the failure reason it ended with. */
export interface FinishResult {
  readonly finished: boolean;
  readonly failureReason: string;
}

// Ends the execution (and saves it) on an error, no complete outcome, or nothing to verify.
export function finishWithoutVerify(
  target: SessionTarget,
  loop: { verify: VerifyState; failure: FailureState },
  it: Iteration,
): FinishResult {
  const { record, store, context } = target;
  const { verify, failure } = loop;
  if (it.invokeError === null && it.outcome !== null && it.outcome.status === 'complete' && verify.verifyCommands.length > 0) {
    return { finished: false, failureReason: failure.failureReason };
  }
  const finished: ExecutionStatus = it.invokeError === null && it.outcome !== null ? 'completed' : 'failed';
  record.status = finished;
  store.save(record, context);
  const { fields, failureReason } = outcomeFields(verify, failure);
  store.saveExecution(context, record, {
    status: finished, error: it.invokeError, outcome: it.outcome, extra: finalFields(verify.turn, fields),
  });
  return { finished: true, failureReason };
}

// Ends the execution on an infrastructure error or a passing run; a red run goes to the repair policy.
export function verifyVerdict(
  loop: { target: SessionTarget & { eventReporter: ProviderEventReporter }; state: VerifyState; lastReport: string },
  it: Iteration,
  result: VerifyRunResult,
): VerifyOutcome {
  const { target, state, lastReport } = loop;
  const { record, store, context, eventReporter } = target;
  if (result.infraError !== null) {
    failStage(target, result.infraError, finalFields(state.turn, verifyFields(state, null)));
    return { verdict: { kind: 'end', outcome: it.outcome }, red: state.red, failureReason: null };
  }
  if (result.passed) {
    eventReporter.emit('verify.passed', 'all commands passed', { turn: state.turn, report: lastReport });
    record.status = 'completed';
    store.save(record, context);
    store.saveExecution(context, record, {
      status: 'completed', outcome: it.outcome, extra: finalFields(state.turn, verifyFields(state, null)),
    });
    store.publishVerifyReport(context, state.turn);
    return { verdict: { kind: 'end', outcome: it.outcome }, red: state.red, failureReason: null };
  }
  return verifyFailure({ target, state, lastReport }, result);
}

// Counts a red run; ends the execution once the verify budget is exhausted, otherwise requests a repair.
function verifyFailure(
  loop: { target: SessionTarget & { eventReporter: ProviderEventReporter }; state: VerifyState; lastReport: string },
  result: VerifyRunResult,
): VerifyOutcome {
  const { target, state, lastReport } = loop;
  const { record, store, context, eventReporter } = target;
  const red = state.red + 1;
  const failed = result.commands.find((item) => item.status === 'fail' || item.status === 'timed_out');
  eventReporter.emit('verify.failed', `${failed?.command ?? 'verify'} failed`, {
    turn: state.turn,
    red,
    max_verify: state.maxVerify,
    command: failed?.command ?? null,
    status: failed?.status ?? null,
    exit_code: failed?.exitCode ?? null,
    report: lastReport,
  });
  if (red >= state.maxVerify) {
    failStage(
      target,
      `Verify failed ${red} times.`,
      finalFields(state.turn, verifyFields({ ...state, red }, VERIFY_EXHAUSTED)),
    );
    return { verdict: { kind: 'end', outcome: null }, red, failureReason: VERIFY_EXHAUSTED };
  }
  store.saveExecutionProgress(context, record, verifyFields({ ...state, red }, null) ?? {});
  return { verdict: { kind: 'repair', report: lastReport }, red, failureReason: null };
}
