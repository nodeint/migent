import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { type ExecutionSnapshot, type StageOutcome, writeJsonAtomic } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';

import type { NextSuggestion } from './next-handoff.js';
import type { ExecutionContext } from './session-store-types.js';

export function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function textField(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function readJsonObject(filePath: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  if (!isRecord(value)) throw new Error(`Expected a JSON object: ${filePath}`);
  return value;
}

export function latestExecutionPerStage<
  T extends { context: { executionId: string }; metadata: Record<string, unknown>; order: number },
>(rows: readonly T[]): T[] {
  const byStage = new Map<string, T>();
  for (const row of rows) {
    const stageId = typeof row.metadata.stage_id === 'string' ? row.metadata.stage_id : '';
    const current = byStage.get(stageId);
    if (
      current === undefined ||
      compareSortKey([row.order, row.context.executionId], [current.order, current.context.executionId]) > 0
    ) {
      byStage.set(stageId, row);
    }
  }
  return [...byStage.values()];
}

export function verifyReportPath(directory: string, verify: unknown): string | null {
  if (!isRecord(verify) || typeof verify.last_report !== 'string' || verify.last_report === '') {
    return null;
  }
  return path.join(directory, verify.last_report);
}

export function isDirectory(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

export function asInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return 0;
}

export function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function compareSortKey(left: [number, string], right: [number, string]): number {
  if (left[0] !== right[0]) return left[0] - right[0];
  if (left[1] < right[1]) return -1;
  if (left[1] > right[1]) return 1;
  return 0;
}

export function snapshotsIncludingSave(
  snapshots: readonly ExecutionSnapshot[],
  saved: ExecutionSnapshot,
): ExecutionSnapshot[] {
  const included = snapshots.filter((snapshot) => snapshot.executionId !== saved.executionId);
  included.push(saved);
  return included;
}

/** The next.json already on disk, read without rewriting it. */
export function existingNext(sessionDirectory: string): { path: string | null; next: NextSuggestion[] } {
  const filePath = path.join(sessionDirectory, 'next.json');
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (isRecord(parsed) && Array.isArray(parsed.next)) {
      return { path: filePath, next: parsed.next as NextSuggestion[] };
    }
  } catch {
    // No usable next.json.
  }
  return { path: null, next: [] };
}

export interface ExecutionResultInput {
  status: string;
  agentId: string | null;
  timestamp: string;
  error: string | null;
  outcome: StageOutcome | null;
  extra: Record<string, unknown> | null;
}

/** The execution metadata keys a save writes, in write order; `extra` overrides the rest. */
export function executionResultFields(result: ExecutionResultInput): Record<string, unknown> {
  const { status, agentId, timestamp, error, outcome, extra } = result;
  return {
    status,
    agent_id: agentId,
    completed_at: status === 'running' ? null : timestamp,
    ...(error === null ? {} : { error }),
    ...(outcome === null ? {} : { outcome: outcome.toJson() }),
    ...(extra ?? {}),
  };
}

export function savedOutcomeFields(
  outcome: StageOutcome | null,
): { outcomeStatus: string | null; outcomeDecision: string | null } {
  return { outcomeStatus: outcome?.status ?? null, outcomeDecision: outcome?.decision || null };
}

export function storedFailure(
  metadata: Record<string, unknown>,
): { storedError: string | null; failureReason: string | null } {
  return {
    storedError: typeof metadata.error === 'string' ? metadata.error : null,
    failureReason: typeof metadata.failure_reason === 'string' ? metadata.failure_reason : null,
  };
}

export function executionPosition(metadata: Record<string, unknown>): { stageId: string; executionOrder: number } {
  return {
    stageId: typeof metadata.stage_id === 'string' ? metadata.stage_id : '',
    executionOrder: asInt(metadata.execution_order),
  };
}

/** The question request beside an execution that asked. */
export function writeQuestionRequest(
  context: ExecutionContext,
  target: { stageId: unknown; recipient: string },
  outcome: StageOutcome,
): void {
  writeJsonAtomic(path.join(context.directory, 'questions.json'), {
    schema_version: 1, stage_id: target.stageId, execution_id: context.executionId,
    recipient: target.recipient,
    questions: outcome.questions,
  });
}
