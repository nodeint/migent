import path from 'node:path';

import { EXIT_CATALOG, exitCode } from '@nodeint/migent-contracts';
import type { ExecutionSnapshot, PendingResumeStop, ScheduleState } from '@nodeint/migent-kernel';
import { ConfigurationError, NextStage, nextStage, NextStageError, pendingResumeStops, Stop } from '@nodeint/migent-kernel';
import { type HumanInput, readParsedEvents } from '@nodeint/migent-session';
import { isRecord, type WorkflowDocument } from '@nodeint/migent-workflow';

/** Stop reason to exit code, derived from the contracts exit catalog. `stage` ends a one-stage run cleanly. */
export const EXECUTE_EXIT_CODES: Record<string, number> = {
  ...Object.fromEntries(EXIT_CATALOG.filter((entry) => entry.name !== 'config').map((entry) => [entry.name, entry.code])),
  stage: exitCode('completed'),
};


/**
 * A human reply waiting for its stage. The stage that receives it takes the text once; the
 * run asks `consumed` afterwards to learn whether the reply was sent.
 */
export class PendingStageReply {
  public readonly stageId: string;
  /** The reply text, as the run reads it before the stage takes it. */
  public readonly text: string;
  private pending: { text: string; human: HumanInput | null } | null;

  /** `human` is null for text Migent wrote itself, which is never recorded as human input. */
  constructor(stageId: string, text: string, human: HumanInput | null = null) {
    this.stageId = stageId;
    this.text = text;
    this.pending = { text, human };
  }

  public get consumed(): boolean {
    return this.pending === null;
  }

  /** The reply when it is addressed to `stageId` and not yet taken; null otherwise. */
  public take(stageId: string): { text: string; human: HumanInput | null } | null {
    if (this.stageId !== stageId || this.pending === null) return null;
    const taken = this.pending;
    this.pending = null;
    return taken;
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

/**
 * Both scheduling inputs that come from the session's events, from one read: the resume events that resolve
 * stops, and the resume decisions the session waits for.
 */
export function resumeInputs(
  workspace: string,
  sessionId: string,
): { resumes: ReturnType<typeof blockResumes>; pendingResumes: PendingResumeStop[] } {
  const events = readParsedEvents(path.join(workspace, '.migent', 'sessions', sessionId, 'events.jsonl'));
  return {
    resumes: events.map((event) => ({ event: event.event, executionId: event.executionId, data: event.data })),
    pendingResumes: pendingResumeStops(events),
  };
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
