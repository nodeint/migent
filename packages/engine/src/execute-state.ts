import path from 'node:path';

import { EXIT_CATALOG, exitCode } from '@nodeint/migent-contracts';
import type { ExecutionSnapshot, ScheduleState } from '@nodeint/migent-kernel';
import { ConfigurationError, NextStage, nextStage, NextStageError, Stop } from '@nodeint/migent-kernel';
import { readParsedEvents } from '@nodeint/migent-session';
import { isRecord, type WorkflowDocument } from '@nodeint/migent-workflow';

/** Stop reason to exit code, derived from the contracts exit catalog. `stage` ends a one-stage run cleanly. */
export const EXECUTE_EXIT_CODES: Record<string, number> = {
  ...Object.fromEntries(EXIT_CATALOG.filter((entry) => entry.name !== 'config').map((entry) => [entry.name, entry.code])),
  stage: exitCode('completed'),
};

export const TERMINAL_SESSION_STATUSES = new Set(['completed', 'blocked', 'question', 'cancelled']);

/**
 * A human reply waiting for its stage. The stage that receives it takes the text once; the
 * run asks `consumed` afterwards to learn whether the reply was sent.
 */
export class PendingStageReply {
  public readonly stageId: string;
  private pending: string | null;

  constructor(stageId: string, text: string) {
    this.stageId = stageId;
    this.pending = text;
  }

  public get consumed(): boolean {
    return this.pending === null;
  }

  /** The reply text when it is addressed to `stageId` and not yet taken; null otherwise. */
  public take(stageId: string): string | null {
    if (this.stageId !== stageId || this.pending === null) return null;
    const text = this.pending;
    this.pending = null;
    return text;
  }
}

export interface ExecuteResult {
  code: number;
  status: string;
  stopReason: string;
  sessionId: string;
  latestDecision: string | null;
  latestExecutionId: string | null;
  outputs: Record<string, unknown>;
  stages: Record<string, unknown>[];
}

export function selectedStage(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  state: ScheduleState,
): NextStage | Stop {
  const selected = nextStage(workflow, snapshots, state);
  if (selected instanceof NextStageError) throw new ConfigurationError(selected.message);
  if (selected instanceof NextStage || selected instanceof Stop) return selected;
  throw new ConfigurationError('no eligible stage');
}

export function blockResumes(
  workspace: string,
  sessionId: string,
): Pick<ReturnType<typeof readParsedEvents>[number], 'event' | 'executionId' | 'data'>[] {
  return readParsedEvents(path.join(workspace, '.migent', 'sessions', sessionId, 'events.jsonl')).map((event) => ({
    event: event.event,
    executionId: event.executionId,
    data: event.data,
  }));
}

export function executeFinal(
  status: Record<string, unknown>,
  stopReason: string,
  stages: Record<string, unknown>[],
): ExecuteResult {
  return {
    code: EXECUTE_EXIT_CODES[stopReason] ?? exitCode('config'),
    status: text(status.status),
    stopReason,
    sessionId: text(status.session_id),
    latestDecision: optionalText(status.latest_decision),
    latestExecutionId: optionalText(status.latest_execution_id),
    outputs: isRecord(status.outputs) ? status.outputs : {},
    stages,
  };
}

export function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
