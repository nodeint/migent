import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { MIGENT_DIRNAME, SESSIONS_DIRNAME } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';

import { readExitAnomalies } from './exit-anomaly.js';
import { readPendingResumes } from './resume-pending.js';
import { latestDiagnosticsPathIn } from './session-diagnostics.js';
import { parseExecutionId } from './session-events.js';
import { loadFrozenWorkflow } from './session-freeze.js';
import { effectiveTitle } from './session-title.js';

export function readStatusFile(filePath: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  try {
    const payload = JSON.parse(text) as unknown;
    return isRecord(payload) ? payload : {};
  } catch {
    return {};
  }
}

export type StatusFileState =
  | { state: 'missing'; status: Record<string, never> }
  | { state: 'corrupt'; status: Record<string, never> }
  | { state: 'ok'; status: Record<string, unknown> };

/** Like readStatusFile, but tells a missing file from one that exists and does not parse. */
export function readStatusFileState(filePath: string): StatusFileState {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing', status: {} };
    return { state: 'corrupt', status: {} };
  }
  try {
    const payload = JSON.parse(text) as unknown;
    return isRecord(payload) ? { state: 'ok', status: payload } : { state: 'corrupt', status: {} };
  } catch {
    return { state: 'corrupt', status: {} };
  }
}

export function corruptStatusMessage(filePath: string): string {
  return `Session status file is corrupt: ${filePath}.`;
}

export function readExecutionFile(filePath: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(text) as unknown;
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

/** Optional registry artifacts of the frozen workflow that the session did not publish (schema 7). */
function optionalNotProduced(sessionDirectory: string, outputs: Record<string, unknown>): string[] {
  try {
    return (loadFrozenWorkflow(sessionDirectory)?.artifacts ?? [])
      .filter((artifact) => !artifact.required && !Object.hasOwn(outputs, artifact.id))
      .map((artifact) => artifact.id);
  } catch {
    return [];
  }
}

function eventsCursor(sessionDirectory: string): number {
  try {
    return statSync(path.join(sessionDirectory, 'events.jsonl')).size;
  } catch {
    return 0;
  }
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

interface WatchSource {
  sessionDirectory: string;
  status: Record<string, unknown>;
  selectedId: string;
  execution: Record<string, unknown> | null;
}

function sessionWatchFields(sessionDirectory: string, status: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: status.session_id || path.basename(sessionDirectory),
    status: status.status || 'unknown',
    workflow_id: status.workflow_id ?? null,
    task: status.task ?? null,
    latest_execution_id: status.latest_execution_id ?? null,
    latest_execution_status: status.latest_execution_status ?? null,
  };
}

function executionWatchFields(selectedId: string, execution: Record<string, unknown> | null): Record<string, unknown> {
  return {
    execution_id: selectedId || null,
    execution_status: execution ? (execution.status ?? null) : null,
    outcome: execution && isRecord(execution.outcome) ? execution.outcome : null,
  };
}

function progressWatchFields(sessionDirectory: string, status: Record<string, unknown>): Record<string, unknown> {
  const outputs = isRecord(status.outputs) ? status.outputs : {};
  return {
    questions: recordList(status.questions),
    blocked_by_execution_ids: status.blocked_by_execution_ids ?? [],
    blocker: status.blocker ?? null,
    updated_at: status.updated_at ?? null,
    outputs,
    outputs_not_produced: optionalNotProduced(sessionDirectory, outputs),
    running_stages: recordList(status.running_stages),
    events_cursor: eventsCursor(sessionDirectory),
    baseline: isRecord(status.baseline) ? status.baseline : null,
  };
}

/** A field present only when it has a value. */
function whenPresent(key: string, value: unknown, present: boolean): Record<string, unknown> {
  return present ? { [key]: value } : {};
}

function optionalWatchFields(source: WatchSource): Record<string, unknown> {
  const { sessionDirectory, status, execution } = source;
  const quotaFailures = unresolvedQuotaFailures(sessionDirectory);
  const title = effectiveTitle(sessionDirectory);
  const diagnostics = latestDiagnosticsPathIn(sessionDirectory);
  const exitAnomalies = exitAnomalySummaries(sessionDirectory);
  const resumeDecisions = readPendingResumes(sessionDirectory).map((stop) => ({
    stage_id: stop.stageId,
    source_execution_id: stop.sourceExecutionId,
    raised_at: stop.raisedAt,
    policy: stop.policy,
    estimate: stop.estimate === null ? null : {
      idle_seconds: stop.estimate.idleSec,
      threshold_seconds: stop.estimate.thresholdSec,
      cache_ttl_seconds: stop.estimate.cacheTtlSec,
      margin_seconds: stop.estimate.marginSec,
      context_tokens: stop.estimate.contextTokens,
    },
  }));
  return {
    ...whenPresent('handoff', status.handoff, isRecord(status.handoff)),
    skipped_stages: recordList(status.skipped_stages),
    ...whenPresent('skip', execution?.skip, execution !== null && isRecord(execution.skip)),
    ...whenPresent('quota_failures', quotaFailures, quotaFailures.length > 0),
    ...whenPresent('title', title, title !== null),
    ...whenPresent('diagnostics', diagnostics, diagnostics !== null),
    ...whenPresent('exit_anomalies', exitAnomalies, exitAnomalies.length > 0),
    ...whenPresent('resume_decisions', resumeDecisions, resumeDecisions.length > 0),
  };
}

export function watchSnapshot(
  sessionDirectory: string,
  executionId?: string | null,
): Record<string, unknown> {
  const status = readStatusFile(path.join(sessionDirectory, 'status.json'));
  const latest = status.latest_execution_id;
  const selectedId = executionId || (typeof latest === 'string' ? latest : '');
  const execution = selectedId
    ? readExecutionFile(path.join(sessionDirectory, 'executions', selectedId, 'execution.json'))
    : null;
  return {
    ...sessionWatchFields(sessionDirectory, status),
    ...executionWatchFields(selectedId, execution),
    ...progressWatchFields(sessionDirectory, status),
    ...optionalWatchFields({ sessionDirectory, status, selectedId, execution }),
  };
}

function quotaFailureEntry(
  stageId: string,
  executionId: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    stage_id: stageId,
    execution_id: executionId,
    message: typeof metadata.error === 'string' ? metadata.error : null,
    reset_at: typeof metadata.retry_at === 'string' && metadata.retry_at !== '' ? metadata.retry_at : null,
    window: typeof metadata.quota_window === 'string' ? metadata.quota_window : null,
  };
}

/** Stages whose latest execution failed on a client quota. A later execution of the stage resolves it. */
function unresolvedQuotaFailures(sessionDirectory: string): Record<string, unknown>[] {
  const root = path.join(sessionDirectory, 'executions');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const latest = new Map<string, { order: number; executionId: string; metadata: Record<string, unknown> }>();
  for (const name of names) {
    const metadata = readExecutionFile(path.join(root, name, 'execution.json'));
    if (metadata === null) continue;
    const stageId = typeof metadata.stage_id === 'string' && metadata.stage_id !== '' ? metadata.stage_id : name;
    const order = typeof metadata.execution_order === 'number' ? metadata.execution_order : 0;
    const current = latest.get(stageId);
    if (current === undefined || order >= current.order) latest.set(stageId, { order, executionId: name, metadata });
  }
  const failures: Record<string, unknown>[] = [];
  for (const [stageId, { executionId, metadata }] of [...latest.entries()].sort((a, b) => a[1].order - b[1].order)) {
    if (metadata.status !== 'failed' || metadata.failure_reason !== 'quota') continue;
    failures.push(quotaFailureEntry(stageId, executionId, metadata));
  }
  return failures;
}

/** One entry per stage that recorded an exit-only anomaly: its latest anomaly and the stage's count. */
function exitAnomalySummaries(sessionDirectory: string): Record<string, unknown>[] {
  type StageAnomalies = { latest: ReturnType<typeof readExitAnomalies>[number]; stageId: string; count: number };
  const byStage = new Map<string, StageAnomalies>();
  for (const anomaly of readExitAnomalies(sessionDirectory)) {
    const stageId = anomaly.stageId ?? parseExecutionId(anomaly.executionId)?.stageId ?? anomaly.executionId;
    const current = byStage.get(stageId);
    byStage.set(stageId, { latest: anomaly, stageId, count: (current?.count ?? 0) + 1 });
  }
  return [...byStage.values()].map(({ latest, stageId, count }) => {
    const relative = path.posix.join('executions', latest.executionId, 'diagnostics.json');
    const present = existsSync(path.join(sessionDirectory, 'executions', latest.executionId, 'diagnostics.json'));
    return {
      stage_id: stageId,
      execution_id: latest.executionId,
      turn: latest.turn,
      exit_code: latest.exitCode,
      accepted: latest.accepted,
      count,
      diagnostics: present ? relative : null,
    };
  });
}

function sessionRow(sessionsDirectory: string, name: string): string[] | null {
  const statusPath = path.join(sessionsDirectory, name, 'status.json');
  try {
    if (!statSync(statusPath).isFile()) return null;
  } catch {
    return null;
  }
  const read = readStatusFileState(statusPath);
  if (read.state === 'corrupt') {
    return ['', name, 'legacy/unknown', 'corrupt', 'not started', '--', 'none', '', name];
  }
  const {status} = read;
  if (Object.keys(status).length === 0) return null;
  const {outputs} = status;
  const outputLabel =
    isRecord(outputs) && Object.keys(outputs).length > 0 ? Object.keys(outputs).join(',') : 'none';
  return [
    text(status.updated_at, ''),
    name,
    text(status.workflow_id, 'legacy/unknown'),
    text(status.status, 'unknown'),
    text(status.latest_execution_id, 'not started'),
    status.latest_decision ? text(status.latest_decision) : '--',
    outputLabel,
    text(status.task, ''),
    effectiveTitle(path.join(sessionsDirectory, name)) ?? name,
  ];
}

export function listSessionRows(workspace: string): string[][] {
  const sessionsDirectory = path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME);
  let entries;
  try {
    if (!statSync(sessionsDirectory).isDirectory()) return [];
    entries = readdirSync(sessionsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows: string[][] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const row = sessionRow(sessionsDirectory, entry.name);
    if (row !== null) rows.push(row);
  }
  rows.sort((left, right) => {
    for (let index = 0; index < left.length; index += 1) {
      const a = left[index] ?? '';
      const b = right[index] ?? '';
      if (a < b) return 1;
      if (a > b) return -1;
    }
    return 0;
  });
  return rows;
}

function text(value: unknown, fallback = ''): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}
