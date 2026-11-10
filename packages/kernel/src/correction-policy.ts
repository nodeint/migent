import type { TurnKind } from "@nodeint/migent-prompts";
import { QuestionFileError } from "./questions.js";
import { ResponseContractError } from "./stage-outcome.js";

export type CorrectionKind = "response_contract" | "stage_output" | "question_file";

export interface CorrectionRule {
  /** Correction turns granted per execution for this kind. */
  budget: number;
  /** Response contract text the correction prompt carries when the agent id is known. */
  contract: "full" | "reminder";
  turnKind: TurnKind;
  event: string;
  failureReason: string;
  /** The request file is still needed by the correction turn, so the per-turn cleanup skips it. */
  keepQuestionFile: boolean;
}

/** The only place that decides which agent-correctable failures get a correction turn. */
export const CORRECTION_POLICY: Readonly<Record<CorrectionKind, CorrectionRule>> = {
  response_contract: {
    budget: 1, contract: "full", turnKind: "response_correction",
    event: "response.contract_invalid", failureReason: "response_contract_invalid", keepQuestionFile: false,
  },
  stage_output: {
    budget: 1, contract: "reminder", turnKind: "output_correction",
    event: "stage.output_missing", failureReason: "stage_output_missing", keepQuestionFile: false,
  },
  question_file: {
    budget: 1, contract: "reminder", turnKind: "correction",
    event: "question.file_invalid", failureReason: "question_file_invalid", keepQuestionFile: true,
  },
};

/** Failure reasons the policy can produce, for consumers that show their detail. */
export const CORRECTION_FAILURE_REASONS: readonly string[] = Object.values(CORRECTION_POLICY).map((rule) => rule.failureReason);

export interface GateFailure {
  kind: CorrectionKind;
  errorKind: string;
  detail: string;
}

/** Map a gate error to a correctable failure, or null when the agent cannot fix it. */
export function classifyGateError(error: unknown): GateFailure | null {
  if (error instanceof QuestionFileError) return { kind: "question_file", errorKind: error.kind, detail: error.detail };
  if (error instanceof ResponseContractError) return { kind: "response_contract", errorKind: "contract", detail: error.message };
  return null;
}

export interface CorrectionEntry {
  turn: number;
  error_kind: string;
  error_detail: string;
}

export type CorrectionLedger = Partial<Record<CorrectionKind, CorrectionEntry>>;

export type CorrectionDecision = "correct" | "resend" | "exhausted";

/**
 * `correct`: grant a new correction. `resend`: it was granted at this turn and the stop came
 * before the message went out, so send it again. `exhausted`: the budget for the kind is used.
 */
export function decideCorrection(kind: CorrectionKind, ledger: CorrectionLedger, turn: number): CorrectionDecision {
  const entry = ledger[kind];
  if (entry === undefined) return CORRECTION_POLICY[kind].budget > 0 ? "correct" : "exhausted";
  return entry.turn === turn ? "resend" : "exhausted";
}

/** Read `execution.json`. A legacy `question_correction` stands in for the question-file entry. */
export function readCorrectionLedger(metadata: Record<string, unknown>): CorrectionLedger {
  const ledger: CorrectionLedger = {};
  const read = (value: unknown): CorrectionEntry | null => {
    if (typeof value !== "object" || value === null) return null;
    const row = value as Record<string, unknown>;
    if (typeof row.turn !== "number") return null;
    return {
      turn: row.turn,
      error_kind: typeof row.error_kind === "string" ? row.error_kind : "",
      error_detail: typeof row.error_detail === "string" ? row.error_detail : "",
    };
  };
  const stored = typeof metadata.corrections === "object" && metadata.corrections !== null
    ? metadata.corrections as Record<string, unknown> : {};
  for (const kind of Object.keys(CORRECTION_POLICY) as CorrectionKind[]) {
    const entry = read(stored[kind]);
    if (entry !== null) ledger[kind] = entry;
  }
  if (ledger.question_file === undefined) {
    const legacy = read(metadata.question_correction);
    if (legacy !== null) ledger.question_file = legacy;
  }
  return ledger;
}

/** The rule whose correction message carries this turn kind, or null for any other turn. */
export function ruleForTurn(turn: TurnKind | null): CorrectionRule | null {
  return Object.values(CORRECTION_POLICY).find((rule) => rule.turnKind === turn) ?? null;
}
