import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { CliClient, ClientRegistry, TurnUsage, UsageCapture } from '@nodeint/migent-kernel';
import { writeJsonAtomic } from '@nodeint/migent-kernel';
import { normalizeUsage } from '@nodeint/migent-kernel';
import { clientOfCommand } from '@nodeint/migent-kernel';
import { MIGENT_DIRNAME, SESSIONS_DIRNAME } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';
import { routeTargets, type WorkflowDocument } from '@nodeint/migent-workflow';

import { exitAnomaliesOf } from './exit-anomaly.js';
import { executionCommands, legacyExecutionClient } from './legacy-execution-client.js';
import { type ExecutionRow,loadMetricsWorkflow, orderedEvents, readExecutions, sessionIsCorrupt } from './metrics-read.js';
import { addTurn, addUsageRecord, blankUsage, coerceUsage, missingObject, newUsageTotals, type UsageField,usageObject } from './metrics-usage.js';
import { detailsOf, elapsedMs, parseTime, roundSeconds, stringList, text, wallSeconds } from './metrics-values.js';
import { listSessionRows, readStatusFileState } from './query.js';
import { type ParsedEvent } from './session-events.js';

interface NormalizedTurn {
  executionId: string;
  usage: TurnUsage;
  captured: boolean;
}

export function sessionMetrics(
  workspace: string,
  sessionId: string,
  clients: ClientRegistry,
): Record<string, unknown> {
  const sessionDirectory = path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME, sessionId);
  if (sessionIsCorrupt(sessionDirectory)) return { session_id: sessionId, status: 'corrupt' };
  const statusRead = readStatusFileState(path.join(sessionDirectory, 'status.json'));
  const status = statusRead.state === 'ok' ? statusRead.status : {};
  const workflow = loadMetricsWorkflow(workspace, sessionDirectory, status);
  const executions = readExecutions(sessionDirectory);
  const events = orderedEvents(sessionDirectory);
  const agentRole =
    status.workflow_id === 'agent'
      ? (typeof status.role === 'string' ? status.role : manifestRole(sessionDirectory))
      : null;
  return sessionObject(sessionId, status, workflow, executions, events, clients, agentRole);
}

export function listSessionMetrics(
  workspace: string,
  clients: ClientRegistry,
  filters: { workflow: string | null; status: string | null; limit: number | null },
): Record<string, unknown>[] {
  let rows = listSessionRows(workspace);
  // Columns are updated_at, session, workflow, status. Same order as session list.
  if ((filters.workflow !== null && filters.workflow !== undefined)) rows = rows.filter((row) => row[2] === filters.workflow);
  if ((filters.status !== null && filters.status !== undefined)) rows = rows.filter((row) => row[3] === filters.status);
  if ((filters.limit !== null && filters.limit !== undefined)) rows = rows.slice(0, filters.limit);
  return rows.map((row) => sessionMetrics(workspace, row[1] ?? '', clients));
}

export function sealedMetricsPath(workspace: string, sessionId: string): string {
  return path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME, sessionId, 'metrics.json');
}

/** The sealed file, or why it cannot be used. A present file is never rewritten. */
export function readSealedMetrics(
  workspace: string,
  sessionId: string,
): { state: 'ok'; metrics: Record<string, unknown> } | { state: 'missing' } | { state: 'corrupt' } {
  let text: string;
  try {
    text = readFileSync(sealedMetricsPath(workspace, sessionId), 'utf8');
  } catch {
    return { state: 'missing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'corrupt' };
  }
  if (!isRecord(parsed)) return { state: 'corrupt' };
  return { state: 'ok', metrics: parsed };
}

/** Write metrics.json once when a session is completed. An existing file stays. */
export function sealSessionMetrics(
  workspace: string,
  sessionId: string,
  clients: ClientRegistry,
): void {
  if (readSealedMetrics(workspace, sessionId).state !== 'missing') return;
  const metrics = sessionMetrics(workspace, sessionId, clients);
  if (metrics.status !== 'completed') return;
  writeJsonAtomic(sealedMetricsPath(workspace, sessionId), metrics);
}

/** Sealed sessions, newest first. Sessions without a usable metrics.json are omitted. */
export function listSealedMetrics(
  workspace: string,
  filters: { workflow: string | null; status: string | null; limit: number | null },
): Record<string, unknown>[] {
  const sealed: Record<string, unknown>[] = [];
  for (const row of listSessionRows(workspace)) {
    const read = readSealedMetrics(workspace, row[1] ?? '');
    if (read.state !== 'ok') continue;
    sealed.push(read.metrics);
  }
  let rows = sealed;
  if ((filters.workflow !== null && filters.workflow !== undefined)) rows = rows.filter((row) => row.workflow_id === filters.workflow);
  if ((filters.status !== null && filters.status !== undefined)) rows = rows.filter((row) => row.status === filters.status);
  if ((filters.limit !== null && filters.limit !== undefined)) rows = rows.slice(0, filters.limit);
  return rows;
}

function sessionObject(
  sessionId: string,
  status: Record<string, unknown>,
  workflow: WorkflowDocument | null,
  executions: ExecutionRow[],
  events: ParsedEvent[],
  clients: ClientRegistry,
  agentRole: string | null,
): Record<string, unknown> {
  const known = new Set(executions.map((execution) => execution.id));
  const executionClients = resolveExecutionClients(events, executions, status);
  const turns = normalizeTurns(events, executionClients, clients).filter((turn) => known.has(turn.executionId));
  const cancelled = countByExecution(events, 'provider.cancelled', known);
  const anomalies = new Map<string, { total: number; accepted: number }>();
  for (const anomaly of exitAnomaliesOf(events)) {
    if (!known.has(anomaly.executionId)) continue;
    const count = anomalies.get(anomaly.executionId) ?? { total: 0, accepted: 0 };
    count.total += 1;
    if (anomaly.accepted) count.accepted += 1;
    anomalies.set(anomaly.executionId, count);
  }
  const revisionTargets = revisionMap(executions, workflow);
  const routed = routedFrom(executions, workflow);
  const executionObjects = executions.map((execution) =>
    executionObject(
      execution,
      events,
      turns,
      cancelled.get(execution.id) ?? 0,
      anomalies.get(execution.id) ?? { total: 0, accepted: 0 },
      workflow,
      routed.get(execution.id) ?? null,
      agentRole,
      executionClients.get(execution.id) ?? null,
    ),
  );
  const sessionTotals = newUsageTotals();
  let turnsCount = 0;
  let uncaptured = 0;
  let verifyMs = 0;
  let anomalyTotal = 0;
  let anomalyAccepted = 0;
  for (const execution of executionObjects) {
    anomalyTotal += execution.anomalies.total;
    anomalyAccepted += execution.anomalies.accepted;
    turnsCount += execution.turns as number;
    uncaptured += execution.uncaptured_turns as number;
    verifyMs += execution.verifyMs as number;
    addUsageRecord(sessionTotals, execution.usage as TurnUsage, execution.usage_missing as Record<UsageField, number>);
  }
  const wallMs = sessionWallMs(executions);
  const activeMs = executions.reduce((sum, execution) => {
    const elapsed = elapsedMs(execution.createdAt, execution.completedAt);
    return elapsed === null ? sum : sum + elapsed;
  }, 0);
  const stages = stageObjects(executions, workflow, revisionTargets);
  const revisions = workflow === null ? null : [...revisionTargets.values()].reduce((sum, count) => sum + count, 0);
  return {
    session_id: sessionId,
    workflow_id: text(status.workflow_id),
    workflow_hash: workflowHash(events),
    status: text(status.status),
    latest_decision: text(status.latest_decision),
    task_sha256: text(status.task_sha256),
    prior_session_id: text(status.prior_session_id),
    created_at: text(status.created_at),
    updated_at: text(status.updated_at),
    totals: {
      executions: executions.filter((execution) => execution.status !== 'skipped').length,
      skipped: executions.filter((execution) => execution.status === 'skipped').length,
      wall_seconds: wallMs === null ? null : roundSeconds(wallMs),
      active_seconds: executions.some((execution) => elapsedMs(execution.createdAt, execution.completedAt) !== null)
        ? roundSeconds(activeMs)
        : 0,
      verify_seconds: roundSeconds(verifyMs),
      turns: turnsCount,
      uncaptured_turns: uncaptured,
      provider_exit_anomalies: anomalyTotal,
      provider_exit_anomalies_accepted: anomalyAccepted,
      usage: usageObject(sessionTotals),
      usage_missing: missingObject(sessionTotals),
      cost_partial: sessionTotals.seen.cost_usd && sessionTotals.missing.cost_usd > 0,
      failed_executions: executions.filter((execution) => execution.status === 'failed').length,
      blocked: executions.filter((execution) => execution.outcomeStatus === 'blocked').length,
      cancelled: executions.filter((execution) => execution.status === 'cancelled').length,
      verify_red: executionObjects.reduce((sum, execution) => sum + (execution.verifyRed as number), 0),
      revisions,
      revisions_reset: events.filter((event) => event.event === 'revisions.reset').length,
    },
    stages,
    executions: executionObjects.map((execution) => execution.public),
  };
}

function executionObject(
  execution: ExecutionRow,
  events: ParsedEvent[],
  turns: NormalizedTurn[],
  cancelled: number,
  anomalies: { total: number; accepted: number },
  workflow: WorkflowDocument | null,
  routedFromId: string | null,
  agentRole: string | null,
  client: string | null,
): {
  public: Record<string, unknown>;
  turns: number;
  uncaptured_turns: number;
  anomalies: { total: number; accepted: number };
  usage: TurnUsage;
  usage_missing: Record<UsageField, number>;
  verifyMs: number;
  verifyRed: number;
} {
  const ownEvents = events.filter((event) => event.executionId === execution.id);
  const ownTurns = turns.filter((turn) => turn.executionId === execution.id);
  const totals = newUsageTotals();
  let uncaptured = cancelled;
  for (const turn of ownTurns) {
    if (!turn.captured) uncaptured += 1;
    addTurn(totals, turn.usage);
  }
  const started = ownEvents.find((event) => event.event === 'provider.stage_started');
  const startedDetails = detailsOf(started);
  const firstTurn = ownEvents.find((event) => isRunnerTurn(event));
  const verify = verifyStats(ownEvents, (workflow?.stages[execution.stageId]?.verify.length ?? 0) > 0);
  return {
    turns: ownTurns.length,
    uncaptured_turns: uncaptured,
    anomalies,
    usage: usageObject(totals),
    usage_missing: missingObject(totals),
    verifyMs: verify.milliseconds,
    verifyRed: verify.public?.red ?? 0,
    public: {
      execution_id: execution.id,
      execution_order: execution.order,
      stage_id: execution.stageId,
      stage_attempt: execution.attempt,
      role: workflow ? (workflow.stages[execution.stageId]?.role ?? null) : agentRole,
      client,
      model: execution.model,
      cli_version: text(startedDetails.cli_version),
      argv: stringList(detailsOf(firstTurn).argv),
      agent_id: execution.agentId,
      resumes_execution_id: execution.resumes,
      routed_from: routedFromId,
      git_head: text(startedDetails.git_head),
      git_dirty: typeof startedDetails.git_dirty === 'boolean' ? startedDetails.git_dirty : null,
      status: execution.status,
      outcome_status: execution.outcomeStatus,
      decision: execution.decision,
      blocker: execution.blocker,
      error: execution.error,
      failure_reason: execution.failureReason,
      created_at: execution.createdAt,
      completed_at: execution.completedAt,
      wall_seconds: wallSeconds(execution.createdAt, execution.completedAt),
      verify_seconds: roundSeconds(verify.milliseconds),
      turns: ownTurns.length,
      uncaptured_turns: uncaptured,
      provider_exit_anomalies: anomalies.total,
      provider_exit_anomalies_accepted: anomalies.accepted,
      usage: usageObject(totals),
      usage_missing: missingObject(totals),
      verify: verify.public,
      skip: execution.skip,
    },
  };
}

function manifestRole(sessionDirectory: string): string | null {
  let textBody: string;
  try {
    textBody = readFileSync(path.join(sessionDirectory, 'manifest.yaml'), 'utf8');
  } catch {
    return null;
  }
  for (const line of textBody.split('\n')) {
    const match = /^role:\s*(.*?)\s*$/.exec(line);
    const value = match?.[1] ?? '';
    if (value === '' || value === 'null' || value === '~') continue;
    return value.replace(/^["']|["']$/g, '');
  }
  return null;
}

// Old sessions recorded turn_completed with no details.turn. Progress never emits
// turn_completed, so those still count. A turn_failed counts only with details.turn,
// because the progress path emits the same event without it.
function isRunnerTurn(event: ParsedEvent): boolean {
  if (event.event === 'provider.turn_completed') return true;
  if (event.event !== 'provider.turn_failed') return false;
  return typeof detailsOf(event).turn === 'number';
}

function resolveExecutionClients(
  events: ParsedEvent[],
  executions: ExecutionRow[],
  status: Record<string, unknown>,
): Map<string, string | null> {
  const executables = executionCommands(events);
  const roleSession = status.workflow_id === 'agent';
  return new Map(executions.map((execution) => {
    const {client} = legacyExecutionClient({
      recorded: execution.client,
      provider: execution.provider,
      executables: executables.get(execution.id),
      roleSession,
    });
    return [execution.id, client];
  }));
}

function normalizeTurns(
  events: ParsedEvent[],
  executionClients: ReadonlyMap<string, string | null>,
  clients: ClientRegistry,
): NormalizedTurn[] {
  const previous = new Map<string, UsageCapture>();
  const turns: NormalizedTurn[] = [];
  for (const event of events) {
    if (!isRunnerTurn(event) || event.executionId === null) continue;
    const details = detailsOf(event);
    // Usage is read with the CLI that actually ran the turn. Legacy records name no
    // client, so this follows the same evidence policy as resume.
    const {argv} = details;
    const command = Array.isArray(argv) && typeof argv[0] === 'string' ? argv[0] : null;
    // A conflicting history cannot be resumed, but each turn still proves its own output format.
    const clientId = clientOfCommand(command) ?? executionClients.get(event.executionId) ?? null;
    const agentId = typeof details.agent_id === 'string' ? details.agent_id : null;
    const key = JSON.stringify([clientId, agentId]);
    const capture = isRecord(details.usage) ? details.usage : null;
    let reader: Pick<CliClient, 'readUsage'> | null = null;
    if (clientId !== null) {
      try {
        reader = clients.get(clientId);
      } catch {
        reader = null;
      }
    }
    let usage = blankUsage();
    if (capture !== null && reader !== null) {
      try {
        usage = coerceUsage(normalizeUsage(reader, capture, previous.get(key) ?? null));
      } catch {
        usage = blankUsage();
      }
    }
    if (capture !== null) previous.set(key, capture);
    turns.push({ executionId: event.executionId, usage, captured: capture !== null && reader !== null });
  }
  return turns;
}

function revisionMap(executions: ExecutionRow[], workflow: WorkflowDocument | null): Map<string, number> {
  const counts = new Map<string, number>();
  if (workflow === null) return counts;
  for (const execution of executions) {
    if (execution.status !== 'completed') continue;
    for (const target of decisionTargets(workflow, execution.stageId, execution.decision)) {
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  }
  return counts;
}

function routedFrom(executions: ExecutionRow[], workflow: WorkflowDocument | null): Map<string, string | null> {
  const routed = new Map<string, string | null>();
  const candidate = new Map<string, string | null>();
  for (const execution of executions) {
    routed.set(execution.id, candidate.get(execution.stageId) ?? null);
    if (workflow === null || execution.status !== 'completed') continue;
    candidate.set(execution.stageId, null);
    for (const target of decisionTargets(workflow, execution.stageId, execution.decision)) {
      candidate.set(target, execution.id);
    }
  }
  return routed;
}

function decisionTargets(workflow: WorkflowDocument, stageId: string, decision: string | null): string[] {
  if (decision === null) return [];
  const stage = workflow.stages[stageId];
  if (stage === undefined) return [];
  return routeTargets(stage.routes[decision]).filter((target) => target !== 'complete');
}

function stageObjects(
  executions: ExecutionRow[],
  workflow: WorkflowDocument | null,
  revisions: Map<string, number>,
): Record<string, unknown> {
  const ids: string[] = [];
  const declared = workflow === null ? [] : Object.keys(workflow.stages);
  for (const stageId of declared) {
    const ran = executions.some((execution) => execution.stageId === stageId);
    const revisionCount = revisions.get(stageId) ?? 0;
    if (ran || revisionCount > 0) ids.push(stageId);
  }
  for (const execution of executions) {
    if (!ids.includes(execution.stageId)) ids.push(execution.stageId);
  }
  const stages: Record<string, unknown> = {};
  for (const stageId of ids) {
    const own = executions.filter((execution) => execution.stageId === stageId);
    if (own.length === 0 && (revisions.get(stageId) ?? 0) === 0) continue;
    stages[stageId] = {
      executions: own.filter((execution) => execution.status !== 'skipped').length,
      skipped: own.filter((execution) => execution.status === 'skipped').length,
      revisions: workflow === null ? null : (revisions.get(stageId) ?? 0),
      failed: own.filter((execution) => execution.status === 'failed').length,
      blocked: own.filter((execution) => execution.outcomeStatus === 'blocked').length,
    };
  }
  return stages;
}

function verifyStats(
  events: ParsedEvent[],
  hasCommands: boolean,
): {
  public: { runs: number; red: number; first_pass: boolean; failed_commands: string[] } | null;
  milliseconds: number;
} {
  let runs = 0;
  let red = 0;
  let firstPass: boolean | null = null;
  const failedCommands: string[] = [];
  let openStart: number | null = null;
  let milliseconds = 0;
  let saw = false;
  for (const event of events) {
    if (event.event === 'verify.started') {
      saw = true;
      openStart = parseTime(event.timestamp);
      continue;
    }
    if (event.event !== 'verify.passed' && event.event !== 'verify.failed') continue;
    saw = true;
    runs += 1;
    if (firstPass === null) firstPass = event.event === 'verify.passed';
    if (event.event === 'verify.failed') {
      red += 1;
      const {command} = detailsOf(event);
      if (typeof command === 'string') failedCommands.push(command);
    }
    const finished = parseTime(event.timestamp);
    if (openStart !== null && finished !== null) milliseconds += finished - openStart;
    openStart = null;
  }
  if (!saw && !hasCommands) return { public: null, milliseconds: 0 };
  return {
    milliseconds,
    public: { runs, red, first_pass: firstPass === true, failed_commands: failedCommands },
  };
}

function sessionWallMs(executions: ExecutionRow[]): number | null {
  if (executions.length === 0) return null;
  if (executions.some((execution) => execution.completedAt === null || execution.createdAt === null)) return null;
  const first = executions[0];
  if (first === undefined) return null;
  let latest = parseTime(first.completedAt);
  const start = parseTime(first.createdAt);
  if (latest === null || start === null) return null;
  for (const execution of executions) {
    const completed = parseTime(execution.completedAt);
    if (completed === null) return null;
    if (completed > latest) latest = completed;
  }
  return latest - start;
}

function countByExecution(events: ParsedEvent[], name: string, known: Set<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.event !== name || event.executionId === null || !known.has(event.executionId)) continue;
    counts.set(event.executionId, (counts.get(event.executionId) ?? 0) + 1);
  }
  return counts;
}

function workflowHash(events: ParsedEvent[]): string | null {
  for (const event of events) {
    if ((event.event === 'session.created' || event.event === 'handoff.bound') && typeof event.data.hash === 'string') return event.data.hash;
  }
  return null;
}
