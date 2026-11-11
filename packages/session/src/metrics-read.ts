import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ConfigurationError, EXECUTIONS_DIRNAME, isAtomicTempName } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';
import { loadNamedWorkflow, loadWorkflowDocument, type WorkflowDocument } from '@nodeint/migent-workflow';

import { finiteNumber, text } from './metrics-values.js';
import { readStatusFileState } from './query.js';
import { type ParsedEvent,readParsedEvents, streamFiles } from './session-events.js';
import { loadFrozenWorkflow } from './session-freeze.js';

export interface ExecutionRow {
  id: string;
  order: number | null;
  stageId: string;
  attempt: number | null;
  client: string | null;
  provider: string | null;
  model: string | null;
  agentId: string | null;
  resumes: string | null;
  status: string | null;
  outcomeStatus: string | null;
  decision: string | null;
  blocker: string | null;
  error: string | null;
  failureReason: string | null;
  createdAt: string | null;
  completedAt: string | null;
  skip: Record<string, unknown> | null;
}

export function sessionIsCorrupt(sessionDirectory: string): boolean {
  if (readStatusFileState(path.join(sessionDirectory, 'status.json')).state === 'corrupt') return true;
  const root = path.join(sessionDirectory, EXECUTIONS_DIRNAME);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || isAtomicTempName(entry.name)) continue;
    const filePath = path.join(root, entry.name, 'execution.json');
    const read = readJsonFile(filePath);
    if (read.state === 'corrupt') return true;
  }
  return false;
}

export function readJsonFile(filePath: string): { state: 'missing' | 'corrupt' | 'ok'; value: Record<string, unknown> | null } {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing', value: null };
    return { state: 'corrupt', value: null };
  }
  try {
    const payload = JSON.parse(text) as unknown;
    return isRecord(payload) ? { state: 'ok', value: payload } : { state: 'corrupt', value: null };
  } catch {
    return { state: 'corrupt', value: null };
  }
}

export function loadMetricsWorkflow(
  workspace: string,
  sessionDirectory: string,
  status: Record<string, unknown>,
): WorkflowDocument | null {
  if (status.workflow_id === 'agent') return null;
  try {
    const frozen = loadFrozenWorkflow(sessionDirectory);
    if (frozen) return frozen;
    const workflowPath = status.workflow_path;
    if (typeof workflowPath === 'string' && workflowPath !== '') {
      return loadWorkflowDocument(path.join(workspace, workflowPath));
    }
    const workflowId = status.workflow_id;
    if (typeof workflowId !== 'string' || workflowId === '') return null;
    return loadNamedWorkflow(workspace, workflowId);
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

export function readExecutions(sessionDirectory: string): ExecutionRow[] {
  const root = path.join(sessionDirectory, EXECUTIONS_DIRNAME);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows: ExecutionRow[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || isAtomicTempName(entry.name)) continue;
    const read = readJsonFile(path.join(root, entry.name, 'execution.json'));
    if (read.state !== 'ok' || read.value === null) continue;
    rows.push(executionRow(entry.name, read.value));
  }
  rows.sort((left, right) => {
    const leftOrder = left.order ?? Number.POSITIVE_INFINITY;
    const rightOrder = right.order ?? Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return rows;
}

export function executionRow(directoryName: string, raw: Record<string, unknown>): ExecutionRow {
  const outcome = isRecord(raw.outcome) ? raw.outcome : null;
  return {
    id: typeof raw.execution_id === 'string' ? raw.execution_id : directoryName,
    order: finiteNumber(raw.execution_order),
    stageId: typeof raw.stage_id === 'string' ? raw.stage_id : directoryName,
    attempt: finiteNumber(raw.stage_attempt),
    client: text(raw.client),
    provider: text(raw.provider),
    model: text(raw.model),
    agentId: text(raw.agent_id),
    resumes: text(raw.resumes_execution_id),
    status: text(raw.status),
    outcomeStatus: text(outcome?.status),
    decision: text(outcome?.decision),
    blocker: text(outcome?.blocker),
    error: text(raw.error),
    failureReason: text(raw.failure_reason),
    createdAt: text(raw.created_at),
    completedAt: text(raw.completed_at),
    skip: isRecord(raw.skip) ? raw.skip : null,
  };
}

export function orderedEvents(sessionDirectory: string): ParsedEvent[] {
  const located: { event: ParsedEvent; order: number }[] = [];
  let order = 0;
  const push = (events: ParsedEvent[]): void => {
    for (const event of events) located.push({ event, order: order++ });
  };
  push(readParsedEvents(path.join(sessionDirectory, 'events.jsonl')));
  for (const file of streamFiles(sessionDirectory)) push(readParsedEvents(file));
  located.sort((left, right) => {
    const a = left.event.seq;
    const b = right.event.seq;
    if (a === null && b === null) return left.order - right.order;
    if (a === null) return 1;
    if (b === null) return -1;
    if (a !== b) return a - b;
    return left.order - right.order;
  });
  return located.map((item) => item.event);
}
