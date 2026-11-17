import type { ExecutionStatus } from '@nodeint/migent-contracts';

import type { OutcomeData } from './outcome-data.js';
import type { TurnVerdict } from './types.js';

/**
 * Every write of the conversation record, execution status and progress, turn files, diagnostics, report
 * publication and verdict events for an execution in scope. Handlers and definitions propose them; only the
 * applier commits them, strictly in list order (D3).
 */
export type Change =
  | { readonly kind: 'recordProviderTurn'; readonly agentId: string | null; readonly model: string;
    readonly options: Readonly<Record<string, string>>; readonly workspace: string }
  | { readonly kind: 'setStatus'; readonly status: string }
  | { readonly kind: 'saveRecord' }
  | { readonly kind: 'appendHistory'; readonly role: 'user' | 'assistant'; readonly content: string }
  | { readonly kind: 'saveProgress'; readonly fields: Readonly<Record<string, unknown>> }
  | { readonly kind: 'saveExecution'; readonly status: ExecutionStatus; readonly error?: string | null;
    readonly outcome?: OutcomeData | null; readonly extra?: Readonly<Record<string, unknown>> | null }
  | { readonly kind: 'saveResponse'; readonly text: string }
  | { readonly kind: 'saveTurnResponse'; readonly turn: number; readonly text: string }
  | { readonly kind: 'saveTurnOutcome'; readonly turn: number; readonly outcome: OutcomeData }
  | { readonly kind: 'writeTurnDiagnostics'; readonly verdict: TurnVerdict }
  | { readonly kind: 'saveTurnVerify'; readonly turn: number; readonly report: string }
  | { readonly kind: 'publishVerifyReport'; readonly turn: number }
  | { readonly kind: 'emit'; readonly event: string; readonly summary: string | null;
    readonly details: Readonly<Record<string, unknown>> | null };
