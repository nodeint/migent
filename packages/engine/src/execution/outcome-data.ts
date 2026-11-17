import type { StageOutcomeStatus } from '@nodeint/migent-contracts';
import { type Question, StageOutcome } from '@nodeint/migent-kernel';

import type { PlainData } from '../runtime/plain-data.js';
import { detach, revive } from './plain.js';

/** The detached form of a `StageOutcome` (D9): every member present, so it is plain data. */
export type OutcomeData = {
  readonly status: StageOutcomeStatus;
  readonly blocker: string | null;
  readonly decision: string | null;
  readonly question: string | null;
  readonly questions: readonly PlainData[];
};

/** Runs inside handlers, where the kernel or session hands back a live `StageOutcome`. */
export function toOutcomeData(outcome: StageOutcome): OutcomeData {
  return {
    status: outcome.status,
    blocker: outcome.blocker,
    decision: outcome.decision,
    question: outcome.question,
    questions: revive<PlainData[]>(detach(outcome.questions)),
  };
}

/** Runs where an existing consumer needs the class: session saves, completion-output checks, and run results. */
export function toStageOutcome(data: OutcomeData): StageOutcome {
  return new StageOutcome(data.status, {
    blocker: data.blocker,
    decision: data.decision,
    question: data.question,
    questions: structuredClone(revive<Question[]>([...data.questions])),
  });
}
