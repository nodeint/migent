/** Status values that feed `execution.<status>` and `stage.<status>` event names. */

export const EXECUTION_STATUSES = ['running', 'completed', 'failed', 'cancelled', 'skipped'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const STAGE_OUTCOME_STATUSES = ['complete', 'blocked', 'question'] as const;
export type StageOutcomeStatus = (typeof STAGE_OUTCOME_STATUSES)[number];
