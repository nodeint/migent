import {
  CORRECTION_POLICY, decideCorrection, type FailureClassification, type GateFailure, VERIFY_EXHAUSTED,
  type VerifyRunResult,
} from '@nodeint/migent-kernel';

import type { Definition, Edge, OperationOutcome, OperationRequest } from '../runtime/operation.js';
import type { PlainData } from '../runtime/plain-data.js';
import { finalFields, outcomeFields, type VerifyFacts, verifyFields } from '../turn-steps.js';
import type { Change } from './changes.js';
import type { OutcomeData } from './outcome-data.js';
import { revive } from './plain.js';
import { correctionTurn, type QueuedTurn, repairTurn } from './role-prompts.js';
import { turnRequest, verifyRequest } from './role-requests.js';
import {
  endExecution, type ExecutionEnd, type ReplyState, type RoleState, type RoleTransition,
} from './role-state.js';
import { persistTurn, turnDiagnostics, turnEvents } from './role-turn.js';
import {
  AGENT_TURN, type GateFailureData, type GateOutput, REPLY_GATE, type TurnOutput, VERIFY_RUN, type VerifyOutput,
} from './types.js';

const ROLE_EDGES: readonly Edge[] = [
  { from: AGENT_TURN, outcome: 'succeeded', to: { kind: 'next', operationId: AGENT_TURN } },
  { from: AGENT_TURN, outcome: 'succeeded', to: { kind: 'next', operationId: VERIFY_RUN } },
  { from: AGENT_TURN, outcome: 'succeeded', to: { kind: 'end' } },
  { from: REPLY_GATE, outcome: 'succeeded', to: { kind: 'next', operationId: AGENT_TURN } },
  { from: REPLY_GATE, outcome: 'succeeded', to: { kind: 'next', operationId: VERIFY_RUN } },
  { from: REPLY_GATE, outcome: 'succeeded', to: { kind: 'end' } },
  { from: VERIFY_RUN, outcome: 'succeeded', to: { kind: 'next', operationId: AGENT_TURN } },
  { from: VERIFY_RUN, outcome: 'succeeded', to: { kind: 'end' } },
];

/** The role execution: turn, gate, correction, verify, repair. It proposes every write; the applier commits them. */
export const roleDefinition: Definition<RoleState, Change, ExecutionEnd> = {
  edges: ROLE_EDGES,
  decide(state, request, outcome) {
    return decideRole(state, request, outcome);
  },
};

function decideRole(
  state: RoleState,
  request: OperationRequest,
  outcome: OperationOutcome<PlainData, Change>,
): RoleTransition {
  const { operationId } = request.identity;
  switch (outcome.kind) {
    case 'succeeded':
      return decideSucceeded(state, operationId, outcome);
    // No edge leaves an operation on these, so the runtime rejects a transition after them.
    case 'denied':
      throw new Error(`Operation ${operationId} was denied: ${outcome.reason}`);
    case 'failed':
      throw new Error(`Operation ${operationId} failed: ${outcome.error}`);
    default:
      return assertNever(outcome);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled operation outcome: ${JSON.stringify(value)}`);
}

function decideSucceeded(
  state: RoleState,
  operationId: string,
  outcome: Extract<OperationOutcome<PlainData, Change>, { kind: 'succeeded' }>,
): RoleTransition {
  switch (operationId) {
    case AGENT_TURN:
      return afterTurn(state, revive<TurnOutput>(outcome.output), outcome.changes);
    case REPLY_GATE:
      return afterGate(state, { gate: revive<GateOutput>(outcome.output), pending: null, handled: [] });
    case VERIFY_RUN:
      return afterVerify(state, revive<VerifyOutput>(outcome.output), outcome.changes);
    default:
      throw new Error(`Role execution has no operation ${operationId}.`);
  }
}

function afterTurn(state: RoleState, turn: TurnOutput, handled: readonly Change[]): RoleTransition {
  const { facts } = state;
  const next: RoleState = { ...state, classification: turn.classification, recordAgentId: turn.agentId };
  const record: Change = {
    kind: 'recordProviderTurn', agentId: turn.agentId, model: facts.model, options: facts.profile,
    workspace: facts.workspacePath,
  };
  return afterGate(next, { gate: turn.gate, pending: turn, handled: [...handled, record] });
}

/** The reply as an iteration: what every later decision reads. */
type Reply = {
  readonly responseText: string;
  readonly outcome: OutcomeData | null;
  readonly invokeError: string | null;
  readonly gateFailure: GateFailureData | null;
  readonly eligible: boolean;
  readonly needsVerify: boolean;
};

// A fresh turn also persists itself; a saved reply only goes on to the gate step.
function afterGate(
  state: RoleState,
  gated: { readonly gate: GateOutput; readonly pending: TurnOutput | null; readonly handled: readonly Change[] },
): RoleTransition {
  const { gate, pending } = gated;
  let current = state;
  const changes: Change[] = [...gated.handled];
  let needsVerify = false;
  if (pending !== null) {
    // Events read the classification before persistTurn resets it; diagnostics read the recorded one.
    changes.push(...turnEvents(state, pending, gate));
    const persisted = persistTurn(state, pending, gate);
    const settled = { gate, modelResponded: persisted.modelResponded };
    changes.push(...persisted.changes, ...turnDiagnostics(state, pending, settled));
    current = persisted.state;
    ({ needsVerify } = persisted);
  }
  const reply: Reply = { ...gate, needsVerify };
  const held: RoleState = { ...current, reply: replyState(gate, needsVerify) };
  return gateStep(held, { reply, fresh: pending !== null, changes });
}

function replyState(gate: GateOutput, needsVerify: boolean): ReplyState {
  return { ...gate, needsVerify };
}

function toFailure(data: GateFailureData): GateFailure {
  return { kind: data.kind, errorKind: data.errorKind, detail: data.detail };
}

function verifyFactsOf(state: RoleState): VerifyFacts {
  const { facts } = state;
  return {
    verifyCommands: facts.verifyCommands, turn: state.turn, lastResult: state.lastResult, lastReport: state.lastReport,
    verifyRuns: state.verifyRuns, red: state.red, maxVerify: facts.maxVerify,
  };
}

function failureOf(state: RoleState): { failureReason: string; classification: FailureClassification | null } {
  return { failureReason: state.failureReason, classification: state.classification };
}

function queueTurn(
  state: RoleState,
  queued: QueuedTurn,
  pre: { readonly changes: readonly Change[]; readonly corrections: RoleState['corrections'] },
): RoleTransition {
  const { corrections } = pre;
  const changes: Change[] = [
    ...pre.changes,
    { kind: 'appendHistory', role: 'user', content: queued.message },
    { kind: 'saveRecord' },
    { kind: 'saveProgress', fields: { turn_kind: queued.turnKind, pending_turn: state.turn + 1 } },
  ];
  const next: RoleState = {
    ...state, turn: state.turn + 1, corrections, reply: null, currentAgentId: state.recordAgentId,
    history: [...state.history, { role: 'user', content: queued.message }],
  };
  return {
    kind: 'next', changes, state: next,
    request: turnRequest(next, { prompt: queued.prompt, keepFile: queued.keepFile, newAgentId: null }),
  };
}

// A gate failure queues a correction or fails the stage; a fresh turn also stops when no verify follows.
function gateStep(
  state: RoleState,
  step: { readonly reply: Reply; readonly fresh: boolean; readonly changes: Change[] },
): RoleTransition {
  const { reply, fresh, changes } = step;
  let current = state;
  const failure = reply.gateFailure === null ? null : toFailure(reply.gateFailure);
  // A saved reply is always eligible, so both kinds are gated by eligibility alone.
  if (failure !== null && reply.eligible) {
    const decision = decideCorrection(failure.kind, current.corrections, current.turn);
    if (decision !== 'exhausted') return correct(current, { failure, decision }, changes);
    const rule = CORRECTION_POLICY[failure.kind];
    const failureDetail = rule.detail(failure, current.facts.files);
    current = { ...current, failureReason: rule.failureReason, failureDetail };
    if (failure.kind === 'question_file' || failure.kind === 'handoff') {
      const ended = outcomeFields(verifyFactsOf(current), failureOf(current));
      current = { ...current, failureReason: ended.failureReason, status: 'failed' };
      return endExecution(current, reply.outcome, [
        ...changes, ...failStage(current.failureDetail, finalFields(current.turn, ended.fields)),
      ]);
    }
  }
  if (fresh && (!reply.needsVerify || reply.outcome === null)) {
    const ended = outcomeFields(verifyFactsOf(current), failureOf(current));
    current = { ...current, failureReason: ended.failureReason };
    const extra = finalFields(current.turn, ended.fields);
    return endExecution(current, reply.outcome, [...changes, ...saveFinished(current, reply, extra)]);
  }
  return afterGateProceed(current, reply, changes);
}

function correct(
  state: RoleState,
  grant: { readonly failure: GateFailure; readonly decision: 'correct' | 'resend' },
  changes: Change[],
): RoleTransition {
  const { failure, decision } = grant;
  const rule = CORRECTION_POLICY[failure.kind];
  let { corrections } = state;
  const ledger: Change[] = [];
  // The budget is persisted before the message joins the history, so a stop between the two
  // writes sends the correction again on resume and never grants a second.
  if (decision === 'correct') {
    corrections = {
      ...corrections,
      [failure.kind]: { turn: state.turn, error_kind: failure.errorKind, error_detail: failure.detail },
    };
    let fileField: Record<string, unknown> = {};
    if (failure.kind === 'question_file') fileField = { file: state.facts.files.questionFile };
    else if (failure.kind === 'handoff') fileField = { file: state.facts.files.handoffFile };
    ledger.push(
      { kind: 'saveProgress', fields: { corrections } },
      {
        kind: 'emit', event: rule.event, summary: `${failure.errorKind}: ${failure.detail}`,
        details: { turn: state.turn, error_kind: failure.errorKind, ...fileField },
      },
    );
  }
  const queued = correctionTurn(state, failure, corrections);
  return queueTurn(state, queued, { changes: [...changes, ...ledger], corrections });
}

// A fresh turn that ends without verify saves the execution with the status persistTurn set.
function saveFinished(state: RoleState, reply: Reply, extra: Record<string, unknown>): Change[] {
  return [{
    kind: 'saveExecution',
    // event-template: unchecked (persistTurn set completed or failed)
    status: state.status as 'completed' | 'failed',
    error: reply.invokeError,
    outcome: reply.outcome,
    extra,
  }];
}

// Marks the stage failed with the given error and saves the execution.
function failStage(error: string, extra: Record<string, unknown>): Change[] {
  return [
    { kind: 'setStatus', status: 'failed' },
    { kind: 'saveRecord' },
    { kind: 'saveExecution', status: 'failed', error, extra },
  ];
}

// Ends the execution on an error, no complete outcome, or nothing to verify; otherwise a verify run follows.
function afterGateProceed(state: RoleState, reply: Reply, changes: Change[]): RoleTransition {
  const verifying = reply.invokeError === null && reply.outcome?.status === 'complete'
    && state.facts.verifyCommands.length > 0;
  if (verifying) return { kind: 'next', request: verifyRequest(state), state, changes };
  const finished = reply.invokeError === null && reply.outcome !== null ? 'completed' : 'failed';
  const ended = outcomeFields(verifyFactsOf(state), failureOf(state));
  const done: RoleState = { ...state, status: finished, failureReason: ended.failureReason };
  return endExecution(done, reply.outcome, [
    ...changes,
    { kind: 'setStatus', status: finished },
    { kind: 'saveRecord' },
    {
      kind: 'saveExecution', status: finished, error: reply.invokeError, outcome: reply.outcome,
      extra: finalFields(state.turn, ended.fields),
    },
  ]);
}

function afterVerify(state: RoleState, output: VerifyOutput, handled: readonly Change[]): RoleTransition {
  const result = revive<VerifyRunResult>(output.result);
  const outcome = state.reply?.outcome ?? null;
  const counted: RoleState = {
    ...state, verifyRuns: state.verifyRuns + 1, lastReport: output.reportPath,
    lastResult: result.passed ? 'pass' : 'fail',
  };
  const changes: Change[] = [...handled];
  if (result.infraError !== null) {
    const extra = finalFields(counted.turn, verifyFields(verifyFactsOf(counted), null));
    changes.push(...failStage(result.infraError, extra));
    return endExecution({ ...counted, status: 'failed' }, outcome, changes);
  }
  if (result.passed) return verifyPassed(counted, { outcome, report: output.reportPath }, changes);
  return verifyRed(counted, { result, output, outcome }, changes);
}

function verifyPassed(
  state: RoleState,
  passed: { readonly outcome: OutcomeData | null; readonly report: string },
  changes: Change[],
): RoleTransition {
  const { outcome, report } = passed;
  changes.push(
    { kind: 'emit', event: 'verify.passed', summary: 'all commands passed', details: { turn: state.turn, report } },
    { kind: 'setStatus', status: 'completed' },
    { kind: 'saveRecord' },
    {
      kind: 'saveExecution', status: 'completed', outcome,
      extra: finalFields(state.turn, verifyFields(verifyFactsOf(state), null)),
    },
    { kind: 'publishVerifyReport', turn: state.turn },
  );
  return endExecution({ ...state, status: 'completed' }, outcome, changes);
}

// Counts a red run; ends the execution once the verify budget is exhausted, otherwise requests a repair.
function verifyRed(
  state: RoleState,
  ran: { result: VerifyRunResult; output: VerifyOutput; outcome: OutcomeData | null },
  changes: Change[],
): RoleTransition {
  const red = state.red + 1;
  const { result, output } = ran;
  const failed = result.commands.find((item) => item.status === 'fail' || item.status === 'timed_out');
  const { maxVerify } = state.facts;
  changes.push({
    kind: 'emit', event: 'verify.failed', summary: `${failed?.command ?? 'verify'} failed`,
    details: {
      turn: state.turn, red, max_verify: maxVerify, command: failed?.command ?? null,
      status: failed?.status ?? null, exit_code: failed?.exitCode ?? null, report: output.reportPath,
    },
  });
  const redState: RoleState = { ...state, red };
  if (red >= maxVerify) {
    changes.push(...failStage(
      `Verify failed ${red} times.`,
      finalFields(state.turn, verifyFields(verifyFactsOf(redState), VERIFY_EXHAUSTED)),
    ));
    return endExecution({ ...redState, status: 'failed', failureReason: VERIFY_EXHAUSTED }, null, changes);
  }
  changes.push({ kind: 'saveProgress', fields: verifyFields(verifyFactsOf(redState), null) ?? {} });
  const queued = repairTurn(redState, output.report, red);
  return queueTurn(redState, queued, { changes, corrections: redState.corrections });
}
