import type { CorrectionFiles, CorrectionLedger } from '@nodeint/migent-kernel';
import type { ExecutionContext } from '@nodeint/migent-session';
import type { StageSpec } from '@nodeint/migent-workflow';

import type { StageExtensions } from '../response-extensions.js';
import type { OperationRequest } from '../runtime/operation.js';
import type { Change } from './changes.js';
import type { OutcomeData } from './outcome-data.js';
import type { ClassificationData, GateOutput } from './types.js';

/** What stays fixed for one role execution. */
export type RoleFacts = {
  readonly context: ExecutionContext;
  readonly clientId: string;
  readonly model: string;
  readonly profile: Readonly<Record<string, string>>;
  readonly workspacePath: string;
  readonly sessionId: string | null;
  readonly stage: StageSpec | null;
  readonly decisionValues: readonly string[];
  readonly artifactName: string | null;
  readonly ask: 'human' | null;
  readonly protocol: number;
  /** Active response extensions from the stage's frozen contracts; empty before protocol 4. */
  readonly extensions?: StageExtensions;
  readonly files: CorrectionFiles;
  readonly verifyCommands: readonly string[];
  readonly maxVerify: number;
  readonly verifyTimeoutSec: number | null;
};

/** A reply after its gates ran: the gate output plus whether a verify run follows. */
export type ReplyState = GateOutput & { readonly needsVerify: boolean };

type HistoryEntry = { readonly role: 'user' | 'assistant'; readonly content: string };

/**
 * What the definition knows between operations. `history`, `recordAgentId`, and `status` mirror what the applier
 * will have committed, so prompts can be built without reading the record the applier owns.
 */
export type RoleState = {
  readonly facts: RoleFacts;
  readonly turn: number;
  readonly red: number;
  readonly verifyRuns: number;
  readonly lastReport: string | null;
  readonly lastResult: 'pass' | 'fail' | null;
  readonly corrections: CorrectionLedger;
  readonly classification: ClassificationData | null;
  readonly failureReason: string;
  readonly failureDetail: string;
  readonly currentAgentId: string | null;
  readonly recordAgentId: string | null;
  readonly history: readonly HistoryEntry[];
  readonly status: string;
  readonly reply: ReplyState | null;
};

/** How one execution ended, in plain data. The entry point turns it into a `RunResult`. */
export type ExecutionEnd = {
  readonly responseText: string;
  readonly outcome: OutcomeData | null;
  readonly failureReason: string;
  readonly failureDetail: string;
  readonly classification: ClassificationData | null;
};

export type RoleTransition =
  | { readonly kind: 'next'; readonly request: OperationRequest; readonly state: RoleState;
    readonly changes: readonly Change[] }
  | { readonly kind: 'end'; readonly result: ExecutionEnd; readonly changes: readonly Change[] };

export function endExecution(
  state: RoleState,
  outcome: OutcomeData | null,
  changes: readonly Change[],
): RoleTransition {
  return {
    kind: 'end',
    changes,
    result: {
      responseText: state.reply?.responseText ?? '',
      outcome,
      failureReason: state.failureReason,
      failureDetail: state.failureDetail,
      classification: state.classification,
    },
  };
}
