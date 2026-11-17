import { CORRECTION_POLICY, type CorrectionLedger, flattenHistory, type GateFailure } from '@nodeint/migent-kernel';
import { renderProviderPrompt, type TurnKind } from '@nodeint/migent-prompts';
import { allStageArtifacts } from '@nodeint/migent-workflow';

import { buildRepairPrompt } from '../turn-steps.js';
import { promptArtifactFiles, sessionPaths } from '../turn-types.js';
import type { RoleState } from './role-state.js';

/** One queued follow-up turn: the user message, the prompt to send, and the progress it persists. */
export type QueuedTurn = {
  readonly message: string;
  readonly prompt: string;
  readonly turnKind: TurnKind;
  readonly keepFile: boolean;
};

type Rendering = {
  readonly message: string;
  readonly contract: 'full' | 'reminder';
  readonly turn: QueuedTurn['turnKind'];
  readonly history: RoleState['history'];
};

function renderFor(state: RoleState, rendering: Rendering): string {
  const { message, contract, turn, history } = rendering;
  const { facts } = state;
  const { context, stage, files } = facts;
  const hasAgent = state.recordAgentId !== null && state.recordAgentId !== '';
  const base = hasAgent ? message : flattenHistory(history.map((item) => ({ ...item })));
  return renderProviderPrompt(base, {
    ...sessionPaths(context, facts.sessionId),
    contract: hasAgent ? contract : 'full',
    turn,
    decisionValues: [...facts.decisionValues],
    decisionInstructions: stage?.decisionInstructions,
    ask: facts.ask,
    protocol: facts.protocol,
    questionFile: files.questionFile,
    handoffFile: files.handoffFile,
    artifactDirectory: context.artifactDirectory,
    artifactName: facts.artifactName,
    artifactFiles: promptArtifactFiles(stage === null ? [] : allStageArtifacts(stage)),
  });
}

/** The correction message and prompt for a ledger entry the policy granted. */
export function correctionTurn(state: RoleState, failure: GateFailure, ledger: CorrectionLedger): QueuedTurn {
  const rule = CORRECTION_POLICY[failure.kind];
  const used = ledger[failure.kind];
  if (used === undefined) throw new Error(`Correction ledger has no entry for ${failure.kind} after a decision.`);
  const message = rule.render(used, state.facts.files);
  const history = [...state.history, { role: 'user' as const, content: message }];
  return {
    message, turnKind: rule.turnKind, keepFile: rule.keepFile,
    prompt: renderFor(state, { message, contract: rule.contract, turn: rule.turnKind, history }),
  };
}

/** The repair message and prompt that follow a red verify run. The report text is the one just produced. */
export function repairTurn(state: RoleState, report: string, red: number): QueuedTurn {
  const { facts } = state;
  const message = buildRepairPrompt(
    { context: facts.context, artifactName: facts.artifactName, red, maxVerify: facts.maxVerify }, report,
  );
  const history = [...state.history, { role: 'user' as const, content: message }];
  const prompt = renderFor(state, { message, contract: 'reminder', turn: 'repair', history });
  return { message, turnKind: 'repair', keepFile: false, prompt };
}
