import type { PluginExecutionRow, PluginSessionEvent, PluginSessionSnapshot } from '@nodeint/migent-contracts';

import {
  addTurn,
  addUsageRecord,
  detailsOf,
  elapsedMs,
  isRecord,
  missingObject,
  newUsageTotals,
  parseTime,
  roundSeconds,
  stringList,
  text,
  type Usage,
  type UsageField,
  usageObject,
  wallSeconds,
} from './values.js';

type Event = PluginSessionEvent;

interface Stage {
  role?: string | null;
  verify?: readonly unknown[];
  routes?: Record<string, string | readonly string[] | undefined>;
}

interface Workflow {
  stages: Record<string, Stage>;
}

interface Turn {
  execution_id: string;
  usage: Readonly<Record<string, number | null>>;
  captured: boolean;
}

interface Anomaly {
  executionId: string;
  accepted: boolean;
}

type Anomalies = { total: number; accepted: number };

interface Source {
  sessionId: string;
  status: Readonly<Record<string, unknown>>;
  workflow: Workflow | null;
  executions: PluginExecutionRow[];
  events: readonly Event[];
  turns: readonly Turn[];
  clients: Readonly<Record<string, string | null>>;
  anomalies: readonly Anomaly[];
}

const routeTargets = (target: string | readonly string[] | undefined): readonly string[] => {
  if (typeof target === 'string') return [target];
  if (Array.isArray(target)) return target as readonly string[];
  return [];
};

function anomalyCounts(anomalies: readonly Anomaly[], known: ReadonlySet<string>): Map<string, Anomalies> {
  const counts = new Map<string, Anomalies>();
  for (const anomaly of anomalies) {
    if (!known.has(anomaly.executionId)) continue;
    const count = counts.get(anomaly.executionId) ?? { total: 0, accepted: 0 };
    count.total += 1;
    if (anomaly.accepted) count.accepted += 1;
    counts.set(anomaly.executionId, count);
  }
  return counts;
}

function countByExecution(events: readonly Event[], name: string, known: ReadonlySet<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.event !== name || event.executionId === null || !known.has(event.executionId)) continue;
    counts.set(event.executionId, (counts.get(event.executionId) ?? 0) + 1);
  }
  return counts;
}

function decisionTargets(workflow: Workflow, stageId: string, decision: string | null): string[] {
  if (decision === null) return [];
  const stage = workflow.stages[stageId];
  if (stage === undefined) return [];
  return routeTargets(stage.routes?.[decision]).filter((target) => target !== 'complete');
}

function revisionMap(executions: PluginExecutionRow[], workflow: Workflow | null): Map<string, number> {
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

function routedFrom(executions: PluginExecutionRow[], workflow: Workflow | null): Map<string, string | null> {
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

function stageObjects(
  executions: PluginExecutionRow[],
  workflow: Workflow | null,
  revisions: Map<string, number>,
): Record<string, unknown> {
  const ids: string[] = [];
  const declared = workflow === null ? [] : Object.keys(workflow.stages);
  for (const stageId of declared) {
    const ran = executions.some((execution) => execution.stageId === stageId);
    if (ran || (revisions.get(stageId) ?? 0) > 0) ids.push(stageId);
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

const VERIFY_RESULTS = new Set(['verify.passed', 'verify.failed']);

/** Time from each `verify.started` to the result that closes it. */
function verifyMilliseconds(events: readonly Event[]): number {
  let openStart: number | null = null;
  let milliseconds = 0;
  for (const event of events) {
    if (event.event === 'verify.started') openStart = parseTime(event.timestamp);
    if (!VERIFY_RESULTS.has(event.event)) continue;
    const finished = parseTime(event.timestamp);
    if (openStart !== null && finished !== null) milliseconds += finished - openStart;
    openStart = null;
  }
  return milliseconds;
}

function verifyStats(events: readonly Event[], hasCommands: boolean): {
  public: { runs: number; red: number; first_pass: boolean; failed_commands: string[] } | null;
  milliseconds: number;
} {
  const results = events.filter((event) => VERIFY_RESULTS.has(event.event));
  const saw = results.length > 0 || events.some((event) => event.event === 'verify.started');
  if (!saw && !hasCommands) return { public: null, milliseconds: 0 };
  const failed = results.filter((event) => event.event === 'verify.failed');
  const failedCommands = failed
    .map((event) => detailsOf(event).command)
    .filter((command): command is string => typeof command === 'string');
  return {
    milliseconds: verifyMilliseconds(events),
    public: {
      runs: results.length,
      red: failed.length,
      first_pass: results[0]?.event === 'verify.passed',
      failed_commands: failedCommands,
    },
  };
}

function sessionWallMs(executions: PluginExecutionRow[]): number | null {
  const [first] = executions;
  if (first === undefined) return null;
  if (executions.some((execution) => execution.completedAt === null || execution.createdAt === null)) return null;
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

function workflowHash(events: readonly Event[]): string | null {
  for (const event of events) {
    if ((event.event === 'session.created' || event.event === 'handoff.bound') && typeof event.data.hash === 'string') {
      return event.data.hash;
    }
  }
  return null;
}

// Old sessions recorded turn_completed with no details.turn. Progress never emits
// turn_completed, so those still count. A turn_failed counts only with details.turn,
// because the progress path emits the same event without it.
function isRunnerTurn(event: Event): boolean {
  if (event.event === 'provider.turn_completed') return true;
  if (event.event !== 'provider.turn_failed') return false;
  return typeof detailsOf(event).turn === 'number';
}

/** A resume the policy found expired that went ahead on the old conversation, by the policy or by a human. */
const isExpiredResume = (event: Event): boolean =>
  (event.event === 'resume.expired' && event.data.action === 'resume')
  || (event.event === 'resume.decided' && event.data.choice === 'resume');

interface ExecutionResult {
  public: Record<string, unknown>;
  turns: number;
  uncaptured_turns: number;
  anomalies: Anomalies;
  usage: Usage;
  usage_missing: Record<UsageField, number>;
  verifyMs: number;
  verifyRed: number;
}

function executionObject(
  execution: PluginExecutionRow,
  shared: { events: readonly Event[]; turns: readonly Turn[]; workflow: Workflow | null },
  facts: { cancelled: number; anomalies: Anomalies; routedFromId: string | null; client: string | null },
): ExecutionResult {
  const { events, turns, workflow } = shared;
  const { cancelled, anomalies, routedFromId, client } = facts;
  const ownEvents = events.filter((event) => event.executionId === execution.id);
  const ownTurns = turns.filter((turn) => turn.execution_id === execution.id);
  let totals = newUsageTotals();
  let uncaptured = cancelled;
  for (const turn of ownTurns) {
    if (!turn.captured) uncaptured += 1;
    totals = addTurn(totals, turn.usage);
  }
  const startedDetails = detailsOf(ownEvents.find((event) => event.event === 'provider.stage_started'));
  const firstTurn = ownEvents.find((event) => isRunnerTurn(event));
  const verify = verifyStats(ownEvents, (workflow?.stages[execution.stageId]?.verify?.length ?? 0) > 0);
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
      role: workflow ? (workflow.stages[execution.stageId]?.role ?? null) : null,
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
      fresh_reason: execution.freshReason,
    },
  };
}

function sumExecutions(executionObjects: readonly ExecutionResult[]): {
  sessionTotals: ReturnType<typeof newUsageTotals>;
  turnsCount: number;
  uncaptured: number;
  verifyMs: number;
  anomalyTotal: number;
  anomalyAccepted: number;
} {
  let sessionTotals = newUsageTotals();
  let turnsCount = 0;
  let uncaptured = 0;
  let verifyMs = 0;
  let anomalyTotal = 0;
  let anomalyAccepted = 0;
  for (const execution of executionObjects) {
    anomalyTotal += execution.anomalies.total;
    anomalyAccepted += execution.anomalies.accepted;
    turnsCount += execution.turns;
    uncaptured += execution.uncaptured_turns;
    verifyMs += execution.verifyMs;
    sessionTotals = addUsageRecord(sessionTotals, execution.usage, execution.usage_missing);
  }
  return { sessionTotals, turnsCount, uncaptured, verifyMs, anomalyTotal, anomalyAccepted };
}

function sessionObject(source: Source): Record<string, unknown> {
  const { sessionId, status, workflow, executions, events, turns, clients } = source;
  const known = new Set(executions.map((execution) => execution.id));
  const cancelled = countByExecution(events, 'provider.cancelled', known);
  const anomalies = anomalyCounts(source.anomalies, known);
  const revisionTargets = revisionMap(executions, workflow);
  const routed = routedFrom(executions, workflow);
  const executionObjects = executions.map((execution) =>
    executionObject(
      execution,
      { events, turns, workflow },
      {
        cancelled: cancelled.get(execution.id) ?? 0,
        anomalies: anomalies.get(execution.id) ?? { total: 0, accepted: 0 },
        routedFromId: routed.get(execution.id) ?? null,
        client: clients[execution.id] ?? null,
      },
    ),
  );
  const totals = sumExecutions(executionObjects);
  const { sessionTotals, turnsCount, uncaptured, verifyMs, anomalyTotal, anomalyAccepted } = totals;
  const wallMs = sessionWallMs(executions);
  const activeMs = executions.reduce((sum, execution) => {
    const elapsed = elapsedMs(execution.createdAt, execution.completedAt);
    return elapsed === null ? sum : sum + elapsed;
  }, 0);
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
      verify_red: executionObjects.reduce((sum, execution) => sum + execution.verifyRed, 0),
      revisions,
      revisions_reset: events.filter((event) => event.event === 'revisions.reset').length,
      fresh_starts: executions.filter((execution) => execution.freshReason !== null).length,
      expired_resumes: events.filter(isExpiredResume).length,
    },
    stages: stageObjects(executions, workflow, revisionTargets),
    executions: executionObjects.map((execution) => execution.public),
  };
}

/** The metrics document of one completed, non-agent session, from snapshot facts alone. */
export function buildMetrics(sessionId: string, snapshot: PluginSessionSnapshot): Record<string, unknown> {
  const workflow = isRecord(snapshot.workflow) && isRecord(snapshot.workflow.stages)
    ? (snapshot.workflow as unknown as Workflow)
    : null;
  return sessionObject({
    sessionId,
    status: snapshot.status,
    workflow,
    executions: snapshot.executions as unknown as PluginExecutionRow[],
    events: snapshot.events,
    turns: snapshot.turns as unknown as Turn[],
    clients: snapshot.execution_clients,
    anomalies: snapshot.exit_anomalies as unknown as Anomaly[],
  });
}
