import { truncateText } from '@nodeint/migent-kernel';

import type { Change } from './changes.js';
import type { RoleState } from './role-state.js';
import type { GateOutput, TurnOutput, TurnVerdict } from './types.js';

/** Turn completed, failed, quota, and exit anomaly events, read before persisting resets the classification. */
export function turnEvents(state: RoleState, turn: TurnOutput, gate: GateOutput): Change[] {
  const changes: Change[] = [{
    kind: 'emit',
    event: gate.turnError === null ? 'provider.turn_completed' : 'provider.turn_failed',
    summary: gate.turnError === null ? 'completed' : gate.turnError,
    details: turn.turnDetails,
  }];
  const { classification } = state;
  const { clientId } = state.facts;
  if (classification?.kind === 'quota') {
    const resetAt = classification.resetAt ?? '';
    changes.push({
      kind: 'emit',
      event: 'provider.quota',
      summary: [classification.message, resetAt].filter((item) => item !== '').join(' '),
      details: {
        retry_at: resetAt, client: clientId, ...(classification.window ? { window: classification.window } : {}),
      },
    });
  }
  if (turn.exitOnly) {
    const { anomalyReason } = gate;
    changes.push({
      kind: 'emit',
      event: 'provider.exit_anomaly',
      summary: gate.invokeError === null || anomalyReason === null
        ? `exit ${turn.exitCode} with a usable reply; accepted`
        : `exit ${turn.exitCode}; rejected: ${anomalyReason}`,
      details: {
        turn: state.turn, client: clientId, exit_code: turn.exitCode, signal: null, origin: 'exit-only',
        accepted: anomalyReason === null, reason: anomalyReason,
      },
    });
  }
  return changes;
}

/** What persisting one turn decided: its writes and the state they leave behind. */
export type PersistedTurn = {
  readonly changes: Change[];
  readonly state: RoleState;
  readonly needsVerify: boolean;
  readonly modelResponded: boolean;
};

// Status, conversation history, saved response, and the verify turn outcome.
export function persistTurn(state: RoleState, turn: TurnOutput, gate: GateOutput): PersistedTurn {
  const { verifyCommands } = state.facts;
  const needsVerify = verifyCommands.length > 0 && gate.invokeError === null && gate.outcome?.status === 'complete';
  const finishedStatus = gate.invokeError === null && gate.gateFailure === null ? 'completed' : 'failed';
  const status = needsVerify ? 'running' : finishedStatus;
  // Only a real model reply belongs in the conversation. Error text, and the reply of a
  // turn the provider itself reported as failed, stay out, so a resume cannot replay
  // them as if the model had said them.
  const modelResponded = gate.responseText !== '' && turn.source === 'model'
    && (state.classification === null || turn.exitOnly);
  const changes: Change[] = [{ kind: 'setStatus', status }];
  if (modelResponded) changes.push({ kind: 'appendHistory', role: 'assistant', content: gate.responseText });
  changes.push({ kind: 'saveRecord' }, ...turnFiles(state, gate, modelResponded));
  // An accepted turn is no longer a failure: nothing downstream may see its classification.
  const classification = turn.exitOnly && gate.anomalyReason === null ? null : state.classification;
  const history = modelResponded
    ? [...state.history, { role: 'assistant' as const, content: gate.responseText }]
    : state.history;
  return { changes, needsVerify, modelResponded, state: { ...state, status, history, classification } };
}

// The saved response and, under verify, the per-turn response and outcome.
function turnFiles(state: RoleState, gate: GateOutput, modelResponded: boolean): Change[] {
  const verifying = state.facts.verifyCommands.length > 0;
  const changes: Change[] = [];
  if (modelResponded) {
    changes.push({ kind: 'saveResponse', text: gate.responseText });
    if (verifying) changes.push({ kind: 'saveTurnResponse', turn: state.turn, text: gate.responseText });
  }
  if (verifying && gate.outcome?.status === 'complete') {
    changes.push({ kind: 'saveTurnOutcome', turn: state.turn, outcome: gate.outcome });
  }
  return changes;
}

// The only writer of diagnostics.json: once this turn's gates have run, before any verify or follow-up turn.
export function turnDiagnostics(
  state: RoleState,
  turn: TurnOutput,
  settled: { readonly gate: GateOutput; readonly modelResponded: boolean },
): Change[] {
  const { gate, modelResponded } = settled;
  if (!turn.recordsTurn) return [];
  const accepted = turn.exitOnly && gate.anomalyReason === null;
  const verdict: TurnVerdict = {
    turn: state.turn, responseText: gate.responseText, parsedSource: turn.parsedSource, failure: turn.failure,
    facts: turn.facts, stream: turn.stream,
    // The classification this turn recorded, read before the accepted exit-only reset.
    classification: state.classification, gates: gate.gates, accepted,
    reason: verdictReason(state, turn, gate), modelResponded, artifactName: state.facts.artifactName,
  };
  return [{ kind: 'writeTurnDiagnostics', verdict }];
}

// The recorded reason of a turn: the anomaly of an exit-only turn, otherwise the provider failure.
function verdictReason(state: RoleState, turn: TurnOutput, gate: GateOutput): string | null {
  if (turn.exitOnly) return gate.anomalyReason === null ? null : truncateText(gate.anomalyReason);
  return truncateText(state.classification?.message ?? turn.exitMessage ?? 'provider failure');
}
