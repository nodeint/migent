import { readFileSync } from 'node:fs';
import path from 'node:path';

import { formatClock, formatDuration } from '@nodeint/migent-kernel';
import { parseExecutionId } from '@nodeint/migent-session';
import { isRecord } from '@nodeint/migent-workflow';

export function roleStartLine(
  stageId: string,
  target: { client: string; model: string; optionLabel: string },
  detail: { description: string | null; attempt: number | null },
): string {
  const { client, model, optionLabel } = target;
  const { description, attempt } = detail;
  const parts = [`stage ${stageId}`];
  if (attempt !== null) parts.push(`attempt ${attempt}`);
  parts.push(formatClock(), `${client}/${model} (${optionLabel})`);
  const base = parts.join(' · ');
  if (description === null) return `${base}.`;
  return `${base} — ${description}.`;
}

export function stageFinishLine(
  session: { workspace: string; sessionId: string },
  stage: { stageId: string; executionId: string },
  result: { outcome: string; decision: string },
): string {
  const { workspace, sessionId } = session;
  const { stageId, executionId } = stage;
  const { outcome, decision } = result;
  const parts = [`stage ${stageId}`];
  const attempt = parseExecutionId(executionId)?.attempt;
  if (attempt !== undefined) parts.push(`attempt ${attempt}`);
  const duration = stageDurationLabel(workspace, sessionId, executionId);
  if (duration !== null) parts.push(duration);
  const tail = decision ? `${outcome} decision=${decision}` : outcome;
  return `${parts.join(' · ')} · ${tail}.`;
}

function stageDurationLabel(workspace: string, sessionId: string, executionId: string): string | null {
  if (executionId === '') return null;
  const filePath = path.join(
    workspace,
    '.migent',
    'sessions',
    sessionId,
    'executions',
    executionId,
    'execution.json',
  );
  const elapsed = elapsedMs(readExecutionTimes(filePath));
  return elapsed === null ? null : formatDuration(elapsed);
}

function readExecutionTimes(filePath: string): { started: number | null; finished: number | null } {
  try {
    const metadata = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!isRecord(metadata)) return { started: null, finished: null };
    return {
      started: parsedTime(metadata.created_at),
      finished: parsedTime(metadata.completed_at),
    };
  } catch {
    return { started: null, finished: null };
  }
}

function elapsedMs(times: { started: number | null; finished: number | null }): number | null {
  if (times.started === null) return null;
  return (times.finished ?? Date.now()) - times.started;
}

function parsedTime(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
