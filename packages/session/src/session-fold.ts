import path from 'node:path';

import { writeJsonAtomic } from '@nodeint/migent-kernel';
import { storedQuestions } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';

import { readStatusFileState } from './query.js';
import {
  CANCELLED_REPLY,
  type ParsedEvent,
  skipsStatusWrite,
} from './session-events.js';
import { loadFoldInputs, readSessionManifest } from './session-fold-read.js';
import type { FoldExecution, FoldInputs, SessionManifest } from './session-fold-types.js';
import { cloneRecord, decisionOf, differingKeys, eventExecutionOrder, isExecutionScoped, later, latestExecution, outcomeRecord, textOr, toStageOutcome } from './session-fold-util.js';
import {
  applyTerminalFields,
  blockedExecutions,
  decisionOfOutcome,
  latestDecision,
  latestPerStage,
  recordLatestDecision,
  sessionStatusFromExecutions,
  type StatusExecution,
} from './session-ledger.js';
import { effectiveTitleFrom, overlayTitle } from './session-title.js';

export function foldStatus(inputs: FoldInputs): Record<string, unknown> {
  const status = inputs.schemaVersion >= 2 ? foldSchema2(inputs) : foldV1(inputs);
  applyManualCompletion(status, inputs.events);
  applyEffectiveTitle(status, inputs);
  addPathOnlyOutputs(status, inputs.outputFiles);
  return status;
}

/**
 * The last human `session.completed` (`data.manual: true`, no execution). It is terminal: the fold
 * derives it from the log, so status.json survives a repair.
 */
export function manualCompletionEvent(events: readonly ParsedEvent[]): ParsedEvent | null {
  let found: ParsedEvent | null = null;
  for (const event of events) {
    if (event.event === 'session.completed' && event.executionId === null && event.data.manual === true) found = event;
  }
  return found;
}

function applyManualCompletion(status: Record<string, unknown>, events: readonly ParsedEvent[]): void {
  const event = manualCompletionEvent(events);
  if (event === null) return;
  status.status = 'completed';
  status.completion_method = 'manual';
  applyTerminalFields(status, 'completed', null, null);
  delete status.questions;
  status.manual_completion = { completed_at: event.timestamp, from: textOr(event.data.from) };
  status.updated_at = later(textOr(status.updated_at), event.timestamp);
}

export function readFoldedStatus(workspace: string, sessionDirectory: string): Record<string, unknown> {
  return foldStatus(loadFoldInputs(workspace, sessionDirectory));
}

export function commitFoldedStatus(workspace: string, sessionDirectory: string): Record<string, unknown> {
  const inputs = loadFoldInputs(workspace, sessionDirectory);
  const folded = foldStatus(inputs);
  writeQuestionsFile(sessionDirectory, inputs);
  writeJsonAtomic(path.join(sessionDirectory, 'status.json'), folded);
  return folded;
}

/** A stable machine-readable list of every question and answer, across execution boundaries. */
export function writeQuestionsFile(sessionDirectory: string, inputs: FoldInputs): void {
  const latest = new Set(latestPerStage(statusExecutionsFromFolds(inputs.executions)).map((row) => row.executionId));
  const manuallyCompleted = manualCompletionEvent(inputs.events) !== null;
  const questions = inputs.executions.flatMap((execution) => {
    if (execution.outcome?.status !== 'question') return [];
    const reply = [...inputs.events].reverse().find((event) =>
      event.event === 'session.active' && event.executionId === execution.executionId && event.data.from === 'question',
    );
    const answers = Array.isArray(reply?.data.answers) ? reply.data.answers.filter(isRecord) : [];
    let questionStatus: 'answered' | 'pending' | 'superseded' = 'superseded';
    if (reply) questionStatus = 'answered';
    else if (latest.has(execution.executionId) && !manuallyCompleted) questionStatus = 'pending';
    return storedQuestions(execution.outcome).map((question) => ({
      ...question, execution_id: execution.executionId, stage_id: execution.stageId,
      recipient: inputs.workflow?.stages[execution.stageId]?.ask ?? 'human',
      status: questionStatus,
      answer: answers.find((answer) => answer.question_id === question.id) ?? null,
      ...(reply ? { answered_at: reply.timestamp } : {}),
    }));
  });
  writeJsonAtomic(path.join(sessionDirectory, 'questions.json'), { schema_version: 1, questions });
}

/** Schema 2 only. Show prints this on stderr and does not rewrite status.json. */
export function statusDriftMessage(workspace: string, sessionId: string): string | null {
  const sessionDirectory = path.join(workspace, '.migent', 'sessions', sessionId);
  const manifest = readSessionManifest(sessionDirectory);
  if (manifest.schemaVersion < 2) return null;
  const read = readStatusFileState(path.join(sessionDirectory, 'status.json'));
  if (read.state !== 'ok') return null;
  let folded: Record<string, unknown>;
  try {
    folded = readFoldedStatus(workspace, sessionDirectory);
  } catch {
    return null;
  }
  const fields = differingKeys(overlayTitle({ ...read.status }, sessionDirectory), folded);
  if (fields.length === 0) return null;
  return `status.json differs from the event fold: ${fields.join(', ')}.`;
}

function foldV1(inputs: FoldInputs): Record<string, unknown> {
  const status: Record<string, unknown> = inputs.previousStatus ? cloneRecord(inputs.previousStatus) : {};
  applyManifestIdentity(status, inputs.manifest);
  if (inputs.executions.length === 0) status.status = manifestStatusToSession(inputs.manifest.manifestStatus);
  const noted = new Map<string, RunningStage>();
  let updatedAt = textOr(status.updated_at) ?? inputs.manifest.createdAt;
  for (const event of inputs.events) {
    if (event.v < 2) continue;
    if (event.event === 'workflow.refreshed') continue;
    if (applySharedEvent(status, event, noted)) updatedAt = later(updatedAt, event.timestamp);
  }
  updatedAt = publishExecutionStatus(status, inputs, updatedAt);
  publishRunningStages(status, noted, inputs.executions);
  if (updatedAt) status.updated_at = updatedAt;
  return status;
}

interface SeenExecution {
  order: number;
  stageId: string;
  status: string;
  outcome: Record<string, unknown> | null;
}

function foldSchema2(inputs: FoldInputs): Record<string, unknown> {
  const status = initialStatus(inputs.manifest, inputs.schemaVersion);
  const seen = new Map<string, SeenExecution>();
  const noted = new Map<string, RunningStage>();
  let updatedAt = inputs.manifest.createdAt;
  for (const event of inputs.events) {
    if (event.event === 'workflow.refreshed') continue;
    if (event.executionId && !inputs.presentExecutionIds.has(event.executionId) && isExecutionScoped(event.event)) {
      continue;
    }
    const applied = applySharedEvent(status, event, noted) || applySchema2Execution(status, event, seen);
    if (applied) updatedAt = later(updatedAt, event.timestamp);
  }
  // Reconcile appends missing events at the end of the file. Latest is the highest order, not the last line.
  publishLatestExecution(status, seen);
  updatedAt = publishExecutionStatus(status, inputs, updatedAt);
  publishRunningStages(status, noted, inputs.executions);
  publishSkippedStages(status, inputs.executions);
  if (updatedAt) status.updated_at = updatedAt;
  return status;
}

/** Stages whose latest execution is a run_when skip. The key is absent when there are none. */
function publishSkippedStages(status: Record<string, unknown>, executions: readonly FoldExecution[]): void {
  delete status.skipped_stages;
  const latest = new Map<string, FoldExecution>();
  for (const execution of executions) {
    const current = latest.get(execution.stageId);
    if (
      current === undefined ||
      execution.executionOrder > current.executionOrder ||
      (execution.executionOrder === current.executionOrder && execution.executionId > current.executionId)
    ) {
      latest.set(execution.stageId, execution);
    }
  }
  const rows = [...latest.values()]
    .filter((execution) => execution.status === 'skipped')
    .sort((left, right) => left.executionOrder - right.executionOrder)
    .map((execution) => ({ stage_id: execution.stageId, execution_id: execution.executionId }));
  if (rows.length > 0) status.skipped_stages = rows;
}

interface RunningStage {
  execution_id: string | null;
  stage_id: string | null;
  client: unknown;
  event: string;
  summary: string | null;
  updated_at: string | null;
}

function applySharedEvent(
  status: Record<string, unknown>,
  event: ParsedEvent,
  noted: Map<string, RunningStage>,
): boolean {
  if (event.event === 'workflow.refreshed') return false;
  if (event.event === 'session.created') {
    if (isRecord(event.data.handoff)) status.handoff = cloneRecord(event.data.handoff);
    if (event.data.prepared === true) {
      status.status = 'prepared';
      return true;
    }
    return false;
  }
  if (event.event === 'handoff.bound') {
    if (isRecord(event.data.handoff)) status.handoff = cloneRecord(event.data.handoff);
    return true;
  }
  if (event.event === 'task.frozen') {
    const hash = textOr(event.data.sha256);
    if (hash) status.task_sha256 = hash;
    return true;
  }
  if (event.event === 'baseline.captured') {
    if (!isRecord(status.baseline)) {
      const baseline: Record<string, unknown> = {
        commit: typeof event.data.commit === 'string' ? event.data.commit : null,
        captured_at: event.timestamp,
      };
      const error = textOr(event.data.error);
      if (error) baseline.error = error;
      status.baseline = baseline;
    }
    return true;
  }
  if (event.event === 'revisions.reset') {
    if (isRecord(event.data.baselines)) status.revision_baselines = cloneRecord(event.data.baselines);
    return true;
  }
  if (event.event === 'outputs.published') {
    mergePublished(status, event.data.outputs);
    return true;
  }
  if (event.event === 'session.activated') {
    status.status = 'active';
    return true;
  }
  if (event.event.startsWith('provider.') || event.event.startsWith('verify.')) {
    if (skipsStatusWrite(event.event)) return false;
    status.latest_provider_event = event.raw;
    if (event.executionId) {
      noted.set(event.executionId, {
        execution_id: event.executionId,
        stage_id: event.stageId,
        client: event.raw.client ?? null,
        event: event.event,
        summary: event.summary,
        updated_at: event.timestamp,
      });
    }
    return true;
  }
  return false;
}

function applySchema2Execution(
  status: Record<string, unknown>,
  event: ParsedEvent,
  seen: Map<string, SeenExecution>,
): boolean {
  if (event.event === 'workflow.refreshed') return false;
  if (!event.executionId) {
    if (event.event.startsWith('session.') && event.event !== 'session.created' && event.event !== 'session.activated') {
      const sessionStatus = event.event.slice('session.'.length);
      status.status = sessionStatus;
      if (sessionStatus === 'completed' && event.data.manual !== true) {
        status.completion_method = 'agent';
      }
      applyTerminalFields(status, sessionStatus, null, textOr(event.data.reason));
      return true;
    }
    return false;
  }
  if (event.event === 'execution.started') {
    const current = seen.get(event.executionId);
    const order = Math.max(current?.order ?? 0, eventExecutionOrder(event));
    if (current && current.status !== 'running') {
      current.order = order;
      if (event.stageId) current.stageId = event.stageId;
      return true;
    }
    seen.set(event.executionId, {
      order,
      stageId: event.stageId ?? current?.stageId ?? '',
      status: 'running',
      outcome: null,
    });
    return true;
  }
  if (event.event.startsWith('execution.')) {
    const executionStatus = event.event.slice('execution.'.length);
    const current = seen.get(event.executionId) ?? {
      order: 0,
      stageId: event.stageId ?? '',
      status: executionStatus,
      outcome: null,
    };
    current.status = executionStatus;
    current.outcome = isRecord(event.data.outcome) ? event.data.outcome : null;
    current.order = Math.max(current.order, eventExecutionOrder(event));
    if (event.stageId) current.stageId = event.stageId;
    seen.set(event.executionId, current);
    return true;
  }
  if (event.event.startsWith('stage.')) {
    const outcome = outcomeRecord(event);
    return decisionOf(outcome) !== null;
  }
  if (event.event.startsWith('session.') && event.event !== 'session.created') return true;
  return false;
}

function publishLatestExecution(status: Record<string, unknown>, seen: ReadonlyMap<string, SeenExecution>): void {
  const latestId = latestSeenId(seen);
  if (latestId === null) return;
  const latest = seen.get(latestId);
  if (!latest) return;
  noteLatest(status, latestId, latest.status, latest.stageId);
  recordLatestDecision(
    status,
    latestDecision([...seen.values()].map((row) => ({ order: row.order, outcome: row.outcome }))),
  );
}

function publishRunningStages(
  status: Record<string, unknown>,
  noted: ReadonlyMap<string, RunningStage>,
  executions: readonly FoldExecution[],
): void {
  delete status.current_stage;
  delete status.running_stages;
  const rows = executions
    .filter((execution) => execution.status === 'running' && noted.has(execution.executionId))
    .sort((left, right) => {
      if (left.executionOrder !== right.executionOrder) return left.executionOrder - right.executionOrder;
      if (left.executionId < right.executionId) return -1;
      if (left.executionId > right.executionId) return 1;
      return 0;
    })
    .map((execution) => ({ ...noted.get(execution.executionId)!, client: execution.client || null }));
  if (rows.length > 0) status.running_stages = rows;
}

/** Session status is the latest execution of each stage, not the highest-order row's stored status. */
function publishExecutionStatus(
  status: Record<string, unknown>,
  inputs: FoldInputs,
  updatedAt: string | null,
): string | null {
  const latest = latestExecution(inputs.executions);
  if (latest === null) return updatedAt;
  const rows = statusExecutionsFromFolds(inputs.executions);
  const sessionStatus = sessionStatusFromExecutions(rows, status, inputs.workflow);
  status.status = sessionStatus;
  if (sessionStatus === 'completed' && !status.completion_method) {
    status.completion_method = 'agent';
  }
  if (inputs.schemaVersion < 2) {
    noteLatest(status, latest.executionId, latest.status, latest.stageId);
    recordLatestDecision(status, decisionOfOutcome(latest.outcome));
  }
  const questions = latestPerStage(rows).filter((row) => row.outcome?.status === 'question' && row.status !== 'running');
  status.questions = questions.flatMap((row) => row.outcome!.questions.map((question) => ({
    ...question, execution_id: row.executionId, stage_id: row.stageId,
    recipient: inputs.workflow?.stages[row.stageId]?.ask ?? 'human',
    file: 'executions/' + row.executionId + '/questions.json',
  })));
  if (questions.length === 0) delete status.questions;
  const blocked = blockedExecutions(rows, status, inputs.workflow).map((row) => ({
    executionId: row.executionId,
    stageId: row.stageId,
    blocker: textOr(inputs.executions.find((execution) => execution.executionId === row.executionId)?.outcome?.blocker),
  }));
  applyTerminalFields(
    status,
    sessionStatus,
    {
      executionId: latest.executionId,
      stageId: latest.stageId,
      blocker: textOr(latest.outcome?.blocker),
    },
    null,
    blocked,
  );
  const resumedAt = applyBlockedResume(
    status,
    inputs.events,
    [...blocked, ...questions].map((row) => row.executionId),
    later(updatedAt, latest.completedAt ?? latest.createdAt),
  );
  return applyCancelledReply(
    status,
    inputs.events,
    latestPerStage(rows).filter((row) => row.status === 'cancelled').map((row) => row.executionId),
    resumedAt,
  );
}

/**
 * A recorded reply to a cancelled stage makes the session runnable until the reply is dispatched.
 * Any cancelled stage with a reply is enough: the reply dispatches first, then the command reopens
 * the other cancelled stages in place.
 */
function applyCancelledReply(
  status: Record<string, unknown>,
  events: readonly ParsedEvent[],
  cancelledIds: readonly string[],
  updatedAt: string | null,
): string | null {
  const current = status.status;
  if ((current !== 'cancelled' && current !== 'blocked' && current !== 'question') || cancelledIds.length === 0) return updatedAt;
  let next = updatedAt;
  let replied = 0;
  for (const executionId of cancelledIds) {
    const replies = events.filter((event) =>
      event.event === 'session.active' && event.executionId === executionId && event.data.from === CANCELLED_REPLY);
    if (replies.length === 0) continue;
    replied += 1;
    for (const reply of replies) next = later(next, reply.timestamp);
  }
  if (replied === 0) return updatedAt;
  status.status = 'active';
  applyTerminalFields(status, 'active', null, null);
  return next;
}

function statusExecutionsFromFolds(executions: readonly FoldExecution[]): StatusExecution[] {
  return executions.map((execution) => ({
    executionId: execution.executionId,
    stageId: execution.stageId,
    executionOrder: execution.executionOrder,
    status: execution.status,
    outcome: toStageOutcome(execution.outcome),
    artifactDirectory: execution.artifactDirectory,
    failureReason: execution.failureReason,
  }));
}

/**
 * An explicit resume of a blocker or an answered question makes the session runnable.
 * Each stopped execution still requires its own resume event before dispatch.
 */
function applyBlockedResume(
  status: Record<string, unknown>,
  events: readonly ParsedEvent[],
  blockedIds: readonly string[],
  updatedAt: string | null,
): string | null {
  if ((status.status !== 'blocked' && status.status !== 'question') || blockedIds.length === 0) return updatedAt;
  const resumes: ParsedEvent[] = [];
  for (const executionId of blockedIds) {
    let resume: ParsedEvent | null = null;
    for (const event of events) {
      if (event.event !== 'session.active' || event.executionId !== executionId) continue;
      if (event.data.from !== 'blocked' && event.data.from !== 'question') continue;
      resume = event;
    }
    if (resume !== null) resumes.push(resume);
  }
  if (resumes.length === 0) return updatedAt;
  status.status = 'active';
  applyTerminalFields(status, 'active', null, null);
  let next = updatedAt;
  for (const resume of resumes) next = later(next, resume.timestamp);
  return next;
}

function noteLatest(status: Record<string, unknown>, executionId: string, executionStatus: string, stageId: string): void {
  status.latest_execution_id = executionId;
  status.latest_execution_status = executionStatus;
  status.latest_stage_id = stageId;
}

function latestSeenId(seen: ReadonlyMap<string, SeenExecution>): string | null {
  let best: string | null = null;
  let bestOrder = -1;
  for (const [executionId, execution] of seen) {
    if (best === null || execution.order > bestOrder || (execution.order === bestOrder && executionId > best)) {
      best = executionId;
      bestOrder = execution.order;
    }
  }
  return best;
}

function mergePublished(status: Record<string, unknown>, raw: unknown): void {
  if (!Array.isArray(raw)) return;
  const outputs = isRecord(status.outputs) ? cloneRecord(status.outputs) : {};
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name === '') continue;
    const row: Record<string, unknown> = {};
    if (typeof entry.path === 'string') row.path = entry.path;
    if (typeof entry.source_execution_id === 'string') row.source_execution_id = entry.source_execution_id;
    if (typeof entry.published_by_execution_id === 'string') {
      row.published_by_execution_id = entry.published_by_execution_id;
    }
    outputs[entry.name] = row;
  }
  if (Object.keys(outputs).length > 0) status.outputs = outputs;
}

function addPathOnlyOutputs(status: Record<string, unknown>, outputFiles: readonly string[]): void {
  if (outputFiles.length === 0) return;
  const outputs = isRecord(status.outputs) ? cloneRecord(status.outputs) : {};
  const recorded = new Set<string>();
  for (const value of Object.values(outputs)) {
    if (isRecord(value) && typeof value.path === 'string' && value.path !== '') recorded.add(path.basename(value.path));
  }
  for (const name of outputFiles) {
    if (Object.hasOwn(outputs, name) || recorded.has(name)) continue;
    outputs[name] = { path: `outputs/${name}` };
  }
  if (Object.keys(outputs).length > 0) status.outputs = outputs;
}

function initialStatus(manifest: SessionManifest, schemaVersion: number): Record<string, unknown> {
  const status: Record<string, unknown> = {
    session_id: manifest.sessionId,
    status: schemaVersion >= 2 ? 'active' : manifestStatusToSession(manifest.manifestStatus),
  };
  applyManifestIdentity(status, manifest);
  if (manifest.createdAt) status.updated_at = manifest.createdAt;
  return status;
}

function applyEffectiveTitle(status: Record<string, unknown>, inputs: FoldInputs): void {
  const title = effectiveTitleFrom(inputs.titleRecord, inputs.manifest.title);
  if (title !== null) status.title = title;
  else delete status.title;
}

function applyManifestIdentity(status: Record<string, unknown>, manifest: SessionManifest): void {
  status.session_id = manifest.sessionId || status.session_id;
  if (manifest.title) status.title = manifest.title;
  if (manifest.workflowId) status.workflow_id = manifest.workflowId;
  if (manifest.workflowPath) status.workflow_path = manifest.workflowPath;
  if (manifest.role) status.role = manifest.role;
  if (manifest.task !== null) status.task = manifest.task;
  if (manifest.createdAt) status.created_at = manifest.createdAt;
  if (manifest.priorSessionId) status.prior_session_id = manifest.priorSessionId;
}

function manifestStatusToSession(manifestStatus: string | null): string {
  if (manifestStatus === 'prepared') return 'prepared';
  if (manifestStatus === 'completed' || manifestStatus === 'blocked' || manifestStatus === 'question' || manifestStatus === 'cancelled') {
    return manifestStatus;
  }
  return 'active';
}

export { readExecutions, readSessionManifest } from './session-fold-read.js';
export type { FoldExecution, FoldInputs, SessionManifest } from './session-fold-types.js';
