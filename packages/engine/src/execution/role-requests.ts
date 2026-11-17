import type { OperationRequest } from '../runtime/operation.js';
import type { RoleState } from './role-state.js';
import { AGENT_TURN, type GateInput, REPLY_GATE, type TurnInput, VERIFY_RUN, type VerifyInput } from './types.js';

function identity(state: RoleState, operationId: string, attempt: number): OperationRequest['identity'] {
  return { executionId: state.facts.context.executionId, operationId, attempt };
}

/** The provider turn the state is about to run. The turn number is the durable attempt (D10). */
export function turnRequest(
  state: RoleState,
  next: { prompt: string; keepFile: boolean; newAgentId: string | null },
): OperationRequest {
  const input: TurnInput = {
    turn: state.turn, prompt: next.prompt, agentId: state.currentAgentId, newAgentId: next.newAgentId,
    recordAgentId: state.recordAgentId, keepFile: next.keepFile,
  };
  return { identity: identity(state, AGENT_TURN, state.turn), input };
}

/** The gates over a saved reply a resumed execution starts from. */
export function savedGateRequest(
  state: RoleState,
  input: GateInput,
): OperationRequest {
  return { identity: identity(state, REPLY_GATE, state.turn), input };
}

/** The verify run. The attempt is the saved run count plus one (D10). */
export function verifyRequest(state: RoleState): OperationRequest {
  const { facts } = state;
  const run = state.verifyRuns + 1;
  const input: VerifyInput = {
    turn: state.turn, commands: facts.verifyCommands, timeoutSec: facts.stage?.verifyTimeoutSec ?? null, run,
    redIfPassed: state.red, redIfFailed: state.red + 1, maxVerify: facts.maxVerify,
  };
  return { identity: identity(state, VERIFY_RUN, run), input };
}
