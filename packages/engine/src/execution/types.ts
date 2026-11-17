import type { FailureClassification, FailureOrigin, GateFailure } from '@nodeint/migent-kernel';

import type { PlainData } from '../runtime/plain-data.js';
import type { OutcomeData } from './outcome-data.js';

const TURN_PAD_WIDTH = 2;

export const AGENT_TURN = 'agent.turn';
export const REPLY_GATE = 'reply.gate';
export const VERIFY_RUN = 'run.verify';

/** The detached form of a `GateFailure`. */
export type GateFailureData = {
  readonly kind: GateFailure['kind'];
  readonly errorKind: string;
  readonly detail: string;
};

/** The detached form of a `FailureClassification`. */
export type ClassificationData =
  | { readonly kind: 'quota'; readonly origin: FailureOrigin; readonly message: string;
    readonly resetAt: string | null; readonly window: string | null }
  | { readonly kind: 'provider'; readonly origin: FailureOrigin; readonly message: string };

export type TurnInput = {
  readonly turn: number;
  readonly prompt: string;
  readonly agentId: string | null;
  readonly newAgentId: string | null;
  /** The conversation record's agent id before the turn, which the turn event reports. */
  readonly recordAgentId: string | null;
  readonly keepFile: boolean;
};

/** One provider turn as the definition sees it: the result and the assessment of how far it may be trusted. */
export type TurnOutput = {
  readonly responseText: string;
  readonly sessionId: string | null;
  readonly invokeError: string | null;
  readonly exitCode: number | null;
  readonly parsedSource: string | null;
  readonly source: string;
  readonly classification: ClassificationData | null;
  /** The conversation record's agent id once this turn is recorded. */
  readonly agentId: string | null;
  readonly turnDetails: { readonly [key: string]: PlainData };
  readonly recordsTurn: boolean;
  readonly exitOnly: boolean;
  readonly candidate: boolean;
  readonly eligible: boolean;
  readonly anomalyReason: string | null;
  readonly exitMessage: string | null;
  readonly turnError: string | null;
  /** Detached `ExecutionFailure`, `ProcessFacts`, and `StreamSummary` of the turn, or null. */
  readonly failure: PlainData;
  readonly facts: PlainData;
  readonly stream: PlainData;
  /** The gated verdict of this turn: the gates over a fresh reply run inside the provider turn operation. */
  readonly gate: GateOutput;
};

/** A saved reply a resumed execution gates before it goes on. */
export type GateInput = {
  readonly responseText: string;
  readonly invokeError: string | null;
  readonly gateFailure: GateFailureData | null;
  readonly outcome: OutcomeData | null;
};

export type GateOutput = {
  readonly responseText: string;
  readonly outcome: OutcomeData | null;
  readonly invokeError: string | null;
  readonly gateFailure: GateFailureData | null;
  readonly eligible: boolean;
  readonly pendingGate: boolean;
  readonly anomalyReason: string | null;
  readonly turnError: string | null;
  /** Detached `Gates`. */
  readonly gates: PlainData;
};

export type VerifyInput = {
  readonly turn: number;
  readonly commands: readonly string[];
  readonly timeoutSec: number | null;
  readonly run: number;
  /** The red count the report states when the commands pass, and when they fail. */
  readonly redIfPassed: number;
  readonly redIfFailed: number;
  readonly maxVerify: number;
};

export type VerifyOutput = {
  /** Detached `VerifyRunResult`. */
  readonly result: PlainData;
  readonly report: string;
  readonly reportPath: string;
};

/** What one turn leaves for diagnostics.json; the applier adds the conversation facts it alone can read. */
export type TurnVerdict = {
  readonly turn: number;
  readonly responseText: string;
  readonly parsedSource: string | null;
  readonly failure: PlainData;
  readonly facts: PlainData;
  readonly stream: PlainData;
  readonly classification: ClassificationData | null;
  readonly gates: PlainData;
  readonly accepted: boolean;
  readonly reason: string | null;
  readonly modelResponded: boolean;
  readonly artifactName: string | null;
};

/** Where a verify report is saved, relative to the execution directory. */
export function verifyReportPath(turn: number): string {
  return `turns/${String(turn).padStart(TURN_PAD_WIDTH, '0')}/verify.md`;
}

export function toClassificationData(classification: FailureClassification | null): ClassificationData | null {
  if (classification === null) return null;
  if (classification.kind === 'quota') {
    return {
      kind: 'quota', origin: classification.origin, message: classification.message,
      resetAt: classification.resetAt, window: classification.window,
    };
  }
  return { kind: 'provider', origin: classification.origin, message: classification.message };
}

/** A gate failure copied to plain data. */
export function toGateFailureData(failure: GateFailure | null): GateFailureData | null {
  return failure === null ? null : { kind: failure.kind, errorKind: failure.errorKind, detail: failure.detail };
}
