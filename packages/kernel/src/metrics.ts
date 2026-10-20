import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isAtomicTempName } from "./atomic-file.js";
import type { AgentAdapter, TurnUsage, UsageCapture } from "./adapter.js";
import { ConfigurationError } from "./errors.js";
import { listSessionRows, readStatusFileState } from "./query.js";
import { isRecord } from "./record.js";
import { EXECUTIONS_DIRNAME, MIGENT_DIRNAME, SESSIONS_DIRNAME } from "./runtime.js";
import { readParsedEvents, streamFiles, type ParsedEvent } from "./session-events.js";
import { loadFrozenWorkflow } from "./session-freeze.js";
import { loadNamedWorkflow, loadWorkflowDocument, routeTargets, type WorkflowDocument } from "./workflow.js";

const USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cost_usd",
] as const;

type UsageField = (typeof USAGE_FIELDS)[number];

interface UsageTotals {
  sums: Record<UsageField, number>;
  seen: Record<UsageField, boolean>;
  missing: Record<UsageField, number>;
}

interface ExecutionRow {
  id: string;
  order: number | null;
  stageId: string;
  attempt: number | null;
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
}

interface NormalizedTurn {
  executionId: string;
  usage: TurnUsage;
  captured: boolean;
}

export function sessionMetrics(
  workspace: string,
  sessionId: string,
  adapters: Record<string, AgentAdapter>,
): Record<string, unknown> {
  const sessionDirectory = path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME, sessionId);
  if (sessionIsCorrupt(sessionDirectory)) return { session_id: sessionId, status: "corrupt" };
  const statusRead = readStatusFileState(path.join(sessionDirectory, "status.json"));
  const status = statusRead.state === "ok" ? statusRead.status : {};
  const workflow = loadMetricsWorkflow(workspace, sessionDirectory, status);
  const executions = readExecutions(sessionDirectory);
  const events = orderedEvents(sessionDirectory);
  const agentRole =
    status.workflow_id === "agent"
      ? (typeof status.role === "string" ? status.role : manifestRole(sessionDirectory))
      : null;
  return sessionObject(sessionId, status, workflow, executions, events, adapters, agentRole);
}

export function listSessionMetrics(
  workspace: string,
  adapters: Record<string, AgentAdapter>,
  filters: { workflow: string | null; status: string | null; limit: number | null },
): Record<string, unknown>[] {
  let rows = listSessionRows(workspace);
  // Columns are updated_at, session, workflow, status. Same order as session list.
  if (filters.workflow != null) rows = rows.filter((row) => row[2] === filters.workflow);
  if (filters.status != null) rows = rows.filter((row) => row[3] === filters.status);
  if (filters.limit != null) rows = rows.slice(0, filters.limit);
  return rows.map((row) => sessionMetrics(workspace, row[1] ?? "", adapters));
}

function sessionIsCorrupt(sessionDirectory: string): boolean {
  if (readStatusFileState(path.join(sessionDirectory, "status.json")).state === "corrupt") return true;
  const root = path.join(sessionDirectory, EXECUTIONS_DIRNAME);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || isAtomicTempName(entry.name)) continue;
    const filePath = path.join(root, entry.name, "execution.json");
    const read = readJsonFile(filePath);
    if (read.state === "corrupt") return true;
  }
  return false;
}

function readJsonFile(filePath: string): { state: "missing" | "corrupt" | "ok"; value: Record<string, unknown> | null } {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", value: null };
    return { state: "corrupt", value: null };
  }
  try {
    const payload = JSON.parse(text) as unknown;
    return isRecord(payload) ? { state: "ok", value: payload } : { state: "corrupt", value: null };
  } catch {
    return { state: "corrupt", value: null };
  }
}

function loadMetricsWorkflow(
  workspace: string,
  sessionDirectory: string,
  status: Record<string, unknown>,
): WorkflowDocument | null {
  if (status.workflow_id === "agent") return null;
  try {
    const frozen = loadFrozenWorkflow(sessionDirectory);
    if (frozen) return frozen;
    const workflowPath = status.workflow_path;
    if (typeof workflowPath === "string" && workflowPath !== "") {
      return loadWorkflowDocument(path.join(workspace, workflowPath));
    }
    const workflowId = status.workflow_id;
    if (typeof workflowId !== "string" || workflowId === "") return null;
    return loadNamedWorkflow(workspace, workflowId);
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

function readExecutions(sessionDirectory: string): ExecutionRow[] {
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
    const read = readJsonFile(path.join(root, entry.name, "execution.json"));
    if (read.state !== "ok" || read.value === null) continue;
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

function executionRow(directoryName: string, raw: Record<string, unknown>): ExecutionRow {
  const outcome = isRecord(raw.outcome) ? raw.outcome : null;
  return {
    id: typeof raw.execution_id === "string" ? raw.execution_id : directoryName,
    order: finiteNumber(raw.execution_order),
    stageId: typeof raw.stage_id === "string" ? raw.stage_id : directoryName,
    attempt: finiteNumber(raw.stage_attempt),
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
  };
}

function orderedEvents(sessionDirectory: string): ParsedEvent[] {
  const located: Array<{ event: ParsedEvent; order: number }> = [];
  let order = 0;
  const push = (events: ParsedEvent[]): void => {
    for (const event of events) located.push({ event, order: order++ });
  };
  push(readParsedEvents(path.join(sessionDirectory, "events.jsonl")));
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

function sessionObject(
  sessionId: string,
  status: Record<string, unknown>,
  workflow: WorkflowDocument | null,
  executions: ExecutionRow[],
  events: ParsedEvent[],
  adapters: Record<string, AgentAdapter>,
  agentRole: string | null,
): Record<string, unknown> {
  const known = new Set(executions.map((execution) => execution.id));
  const turns = normalizeTurns(events, executions, adapters).filter((turn) => known.has(turn.executionId));
  const cancelled = countByExecution(events, "provider.cancelled", known);
  const revisionTargets = revisionMap(executions, workflow);
  const routed = routedFrom(executions, workflow);
  const executionObjects = executions.map((execution) =>
    executionObject(
      execution,
      events,
      turns,
      cancelled.get(execution.id) ?? 0,
      workflow,
      routed.get(execution.id) ?? null,
      agentRole,
    ),
  );
  const sessionTotals = newUsageTotals();
  let turnsCount = 0;
  let uncaptured = 0;
  let verifyMs = 0;
  for (const execution of executionObjects) {
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
      executions: executions.length,
      wall_seconds: wallMs === null ? null : roundSeconds(wallMs),
      active_seconds: executions.some((execution) => elapsedMs(execution.createdAt, execution.completedAt) !== null)
        ? roundSeconds(activeMs)
        : 0,
      verify_seconds: roundSeconds(verifyMs),
      turns: turnsCount,
      uncaptured_turns: uncaptured,
      usage: usageObject(sessionTotals),
      usage_missing: missingObject(sessionTotals),
      failed_executions: executions.filter((execution) => execution.status === "failed").length,
      blocked: executions.filter((execution) => execution.outcomeStatus === "blocked").length,
      cancelled: executions.filter((execution) => execution.status === "cancelled").length,
      verify_red: executionObjects.reduce((sum, execution) => sum + (execution.verifyRed as number), 0),
      revisions,
      revisions_reset: events.filter((event) => event.event === "revisions.reset").length,
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
  workflow: WorkflowDocument | null,
  routedFromId: string | null,
  agentRole: string | null,
): {
  public: Record<string, unknown>;
  turns: number;
  uncaptured_turns: number;
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
  const started = ownEvents.find((event) => event.event === "provider.stage_started");
  const startedDetails = detailsOf(started);
  const firstTurn = ownEvents.find((event) => isRunnerTurn(event));
  const verify = verifyStats(ownEvents, (workflow?.stages[execution.stageId]?.verify.length ?? 0) > 0);
  return {
    turns: ownTurns.length,
    uncaptured_turns: uncaptured,
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
      provider: execution.provider,
      model: execution.model,
      cli_version: text(startedDetails.cli_version),
      argv: stringList(detailsOf(firstTurn).argv),
      agent_id: execution.agentId,
      resumes_execution_id: execution.resumes,
      routed_from: routedFromId,
      git_head: text(startedDetails.git_head),
      git_dirty: typeof startedDetails.git_dirty === "boolean" ? startedDetails.git_dirty : null,
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
      usage: usageObject(totals),
      usage_missing: missingObject(totals),
      verify: verify.public,
    },
  };
}

function manifestRole(sessionDirectory: string): string | null {
  let textBody: string;
  try {
    textBody = readFileSync(path.join(sessionDirectory, "manifest.yaml"), "utf8");
  } catch {
    return null;
  }
  for (const line of textBody.split("\n")) {
    const match = /^role:\s*(.*?)\s*$/.exec(line);
    const value = match?.[1] ?? "";
    if (value === "" || value === "null" || value === "~") continue;
    return value.replace(/^["']|["']$/g, "");
  }
  return null;
}

// Old sessions recorded turn_completed with no details.turn. Progress never emits
// turn_completed, so those still count. A turn_failed counts only with details.turn,
// because the progress path emits the same event without it.
function isRunnerTurn(event: ParsedEvent): boolean {
  if (event.event === "provider.turn_completed") return true;
  if (event.event !== "provider.turn_failed") return false;
  return typeof detailsOf(event).turn === "number";
}

function normalizeTurns(
  events: ParsedEvent[],
  executions: ExecutionRow[],
  adapters: Record<string, AgentAdapter>,
): NormalizedTurn[] {
  const providers = new Map(executions.map((execution) => [execution.id, execution.provider]));
  const previous = new Map<string, UsageCapture>();
  const turns: NormalizedTurn[] = [];
  for (const event of events) {
    if (!isRunnerTurn(event) || event.executionId === null) continue;
    const details = detailsOf(event);
    const provider = text(event.raw.provider) ?? providers.get(event.executionId) ?? "";
    const agentId = typeof details.agent_id === "string" ? details.agent_id : null;
    const key = JSON.stringify([provider, agentId]);
    const capture = isRecord(details.usage) ? details.usage : null;
    const adapter = adapters[provider.toLowerCase()];
    let usage = blankUsage();
    if (capture !== null && adapter?.normalizeUsage) {
      try {
        usage = coerceUsage(adapter.normalizeUsage(capture, previous.get(key) ?? null));
      } catch {
        usage = blankUsage();
      }
    }
    if (capture !== null) previous.set(key, capture);
    turns.push({ executionId: event.executionId, usage, captured: capture !== null });
  }
  return turns;
}

function revisionMap(executions: ExecutionRow[], workflow: WorkflowDocument | null): Map<string, number> {
  const counts = new Map<string, number>();
  if (workflow === null) return counts;
  for (const execution of executions) {
    if (execution.status !== "completed") continue;
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
    if (workflow === null || execution.status !== "completed") continue;
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
  return routeTargets(stage.routes[decision]).filter((target) => target !== "complete");
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
      executions: own.length,
      revisions: workflow === null ? null : (revisions.get(stageId) ?? 0),
      failed: own.filter((execution) => execution.status === "failed").length,
      blocked: own.filter((execution) => execution.outcomeStatus === "blocked").length,
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
    if (event.event === "verify.started") {
      saw = true;
      openStart = parseTime(event.timestamp);
      continue;
    }
    if (event.event !== "verify.passed" && event.event !== "verify.failed") continue;
    saw = true;
    runs += 1;
    if (firstPass === null) firstPass = event.event === "verify.passed";
    if (event.event === "verify.failed") {
      red += 1;
      const command = detailsOf(event).command;
      if (typeof command === "string") failedCommands.push(command);
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
    if (event.event === "session.created" && typeof event.data.hash === "string") return event.data.hash;
  }
  return null;
}

function detailsOf(event: ParsedEvent | undefined): Record<string, unknown> {
  if (event === undefined) return {};
  return isRecord(event.raw.details) ? event.raw.details : {};
}

function addTurn(totals: UsageTotals, usage: TurnUsage): void {
  for (const field of USAGE_FIELDS) {
    const value = usage[field];
    if (value === null) totals.missing[field] += 1;
    else {
      totals.sums[field] += value;
      totals.seen[field] = true;
    }
  }
}

function addUsageRecord(totals: UsageTotals, usage: TurnUsage, missing: Record<UsageField, number>): void {
  for (const field of USAGE_FIELDS) {
    totals.missing[field] += missing[field];
    if (usage[field] !== null) {
      totals.sums[field] += usage[field];
      totals.seen[field] = true;
    }
  }
}

function newUsageTotals(): UsageTotals {
  const sums = {} as Record<UsageField, number>;
  const seen = {} as Record<UsageField, boolean>;
  const missing = {} as Record<UsageField, number>;
  for (const field of USAGE_FIELDS) {
    sums[field] = 0;
    seen[field] = false;
    missing[field] = 0;
  }
  return { sums, seen, missing };
}

function usageObject(totals: UsageTotals): TurnUsage {
  return {
    input_tokens: totals.seen.input_tokens ? totals.sums.input_tokens : null,
    output_tokens: totals.seen.output_tokens ? totals.sums.output_tokens : null,
    reasoning_tokens: totals.seen.reasoning_tokens ? totals.sums.reasoning_tokens : null,
    cache_read_tokens: totals.seen.cache_read_tokens ? totals.sums.cache_read_tokens : null,
    cache_write_tokens: totals.seen.cache_write_tokens ? totals.sums.cache_write_tokens : null,
    cost_usd: totals.seen.cost_usd ? totals.sums.cost_usd : null,
  };
}

function missingObject(totals: UsageTotals): Record<UsageField, number> {
  return {
    input_tokens: totals.missing.input_tokens,
    output_tokens: totals.missing.output_tokens,
    reasoning_tokens: totals.missing.reasoning_tokens,
    cache_read_tokens: totals.missing.cache_read_tokens,
    cache_write_tokens: totals.missing.cache_write_tokens,
    cost_usd: totals.missing.cost_usd,
  };
}

function blankUsage(): TurnUsage {
  return {
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_usd: null,
  };
}

function coerceUsage(value: TurnUsage): TurnUsage {
  return {
    input_tokens: coerceNumber(value?.input_tokens),
    output_tokens: coerceNumber(value?.output_tokens),
    reasoning_tokens: coerceNumber(value?.reasoning_tokens),
    cache_read_tokens: coerceNumber(value?.cache_read_tokens),
    cache_write_tokens: coerceNumber(value?.cache_write_tokens),
    cost_usd: coerceNumber(value?.cost_usd),
  };
}

function coerceNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return value;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function elapsedMs(start: string | null, end: string | null): number | null {
  const started = parseTime(start);
  const finished = parseTime(end);
  if (started === null || finished === null) return null;
  return finished - started;
}

function wallSeconds(start: string | null, end: string | null): number | null {
  const elapsed = elapsedMs(start, end);
  return elapsed === null ? null : roundSeconds(elapsed);
}

function roundSeconds(milliseconds: number): number {
  return Math.round((milliseconds / 1000) * 10) / 10;
}
