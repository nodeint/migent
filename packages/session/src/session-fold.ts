import path from 'node:path';

import { type PendingResumeStop, writeJsonAtomic } from '@nodeint/migent-kernel';
import { isStageStop, isStopped, isStopResolutionEvent, manifestStatusToSession, resolutionFrom, storedQuestions } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';

import { MANIFEST_SCHEMA_EVENT_LOG } from './constants.js';
import { readStatusFileState } from './query.js';
import { pendingResumesOf } from './resume-pending.js';
import {
  CANCELLED_REPLY,
  type ParsedEvent,
  skipsStatusWrite,
} from './session-events.js';
import { EVENT_VERSION } from './session-events.js';
import { pendingExpiryStatus } from './session-fold-pending.js';
import { loadFoldInputs, readSessionManifest } from './session-fold-read.js';
import type { FoldExecution, FoldInputs, SessionManifest } from './session-fold-types.js';
import { cloneRecord, decisionOf, differingKeys, eventExecutionOrder, isExecutionScoped, later, latestExecution, outcomeRecord, textOr, toStageOutcome } from './session-fold-util.js';
import {
  blockedExecutions,
  decisionOfOutcome,
  latestDecision,
  latestPerStage,
  sessionStatusWithPending,
  type StatusExecution,
} from './session-ledger.js';
import { StatusDraft } from './session-status-draft.js';
import { effectiveTitleFrom, overlayTitle } from './session-title.js';

export function foldStatus(inputs: FoldInputs): Record<string, unknown> {
  const draft = inputs.schemaVersion >= MANIFEST_SCHEMA_EVENT_LOG ? foldSchema2(inputs) : foldV1(inputs);
  applyManualCompletion(draft, inputs.events);
  draft.applyTitle(effectiveTitleFrom(inputs.titleRecord, inputs.manifest.title));
  draft.addPathOnlyOutputs(inputs.outputFiles);
  return draft.toRecord();
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

function applyManualCompletion(draft: StatusDraft, events: readonly ParsedEvent[]): void {
  const event = manualCompletionEvent(events);
  if (event === null) return;
  draft.set('status', 'completed');
  draft.set('completion_method', 'manual');
  draft.applyTerminalFields('completed', { source: null, reason: null });
  draft.clear('questions');
  draft.set('manual_completion', { completed_at: event.timestamp, from: textOr(event.data.from) });
  draft.set('updated_at', later(textOr(draft.get('updated_at')), event.timestamp));
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
  const newestFirst = [...inputs.events].reverse();
  const questions = inputs.executions.flatMap((execution) => {
    if (execution.outcome?.status !== 'question') return [];
    const reply = questionReply(newestFirst, execution.executionId);
    let questionStatus: QuestionRecordStatus = 'superseded';
    if (reply) questionStatus = 'answered';
    else if (latest.has(execution.executionId) && !manuallyCompleted) questionStatus = 'pending';
    return questionRecords(execution, { reply, status: questionStatus, workflow: inputs.workflow });
  });
  writeJsonAtomic(path.join(sessionDirectory, 'questions.json'), { schema_version: 1, questions });
}

type QuestionRecordStatus = 'answered' | 'pending' | 'superseded';

/** The newest `session.active` event that answered this execution's questions. */
function questionReply(newestFirst: readonly ParsedEvent[], executionId: string): ParsedEvent | undefined {
  return newestFirst.find((event) =>
    isStopResolutionEvent(event, 'question', executionId) && event.data.from === resolutionFrom('question'));
}

/** One questions.json row per question the execution asked, with its answer when replied. */
function questionRecords(
  execution: FoldExecution,
  context: { reply: ParsedEvent | undefined; status: QuestionRecordStatus; workflow: FoldInputs['workflow'] },
): Record<string, unknown>[] {
  const { reply } = context;
  const answers = Array.isArray(reply?.data.answers) ? reply.data.answers.filter(isRecord) : [];
  const answerFor = (questionId: string): Record<string, unknown> | null =>
    answers.find((answer) => answer.question_id === questionId) ?? null;
  return storedQuestions(execution.outcome).map((question) => ({
    ...question, execution_id: execution.executionId, stage_id: execution.stageId,
    recipient: context.workflow?.stages[execution.stageId]?.ask ?? 'human',
    status: context.status,
    answer: answerFor(question.id),
    ...(reply ? { answered_at: reply.timestamp } : {}),
  }));
}

/** Schema 2 only. Show prints this on stderr and does not rewrite status.json. */
export function statusDriftMessage(workspace: string, sessionId: string): string | null {
  const sessionDirectory = path.join(workspace, '.migent', 'sessions', sessionId);
  const manifest = readSessionManifest(sessionDirectory);
  if (manifest.schemaVersion < MANIFEST_SCHEMA_EVENT_LOG) return null;
  const read = readStatusFileState(path.join(sessionDirectory, 'status.json'));
  if (read.state !== 'ok') return null;
  let folded: Record<string, unknown>;
  try {
    folded = readFoldedStatus(workspace, sessionDirectory);
  } catch {
    return null;
  }
  const fields = differingKeys(overlayTitle(read.status, sessionDirectory), folded);
  if (fields.length === 0) return null;
  return `status.json differs from the event fold: ${fields.join(', ')}.`;
}

function foldV1(inputs: FoldInputs): StatusDraft {
  const draft = new StatusDraft(inputs.previousStatus ? cloneRecord(inputs.previousStatus) : {});
  draft.applyManifestIdentity(inputs.manifest);
  if (inputs.executions.length === 0) draft.set('status', manifestStatusToSession(inputs.manifest.manifestStatus));
  const noted = new Map<string, RunningStage>();
  let updatedAt = textOr(draft.get('updated_at')) ?? inputs.manifest.createdAt;
  for (const event of inputs.events) {
    if (event.v < EVENT_VERSION) continue;
    if (event.event === 'workflow.refreshed') continue;
    if (applySharedEvent(draft, event, noted)) updatedAt = later(updatedAt, event.timestamp);
  }
  updatedAt = publishExecutionStatus(draft, inputs, updatedAt);
  publishRunningStages(draft, noted, inputs.executions);
  if (updatedAt) draft.set('updated_at', updatedAt);
  return draft;
}

interface SeenExecution {
  order: number;
  stageId: string;
  status: string;
  outcome: Record<string, unknown> | null;
}

function foldSchema2(inputs: FoldInputs): StatusDraft {
  const draft = initialStatus(inputs.manifest, inputs.schemaVersion);
  const seen = new Map<string, SeenExecution>();
  const noted = new Map<string, RunningStage>();
  let updatedAt = inputs.manifest.createdAt;
  for (const event of inputs.events) {
    if (event.event === 'workflow.refreshed') continue;
    if (event.executionId && !inputs.presentExecutionIds.has(event.executionId) && isExecutionScoped(event.event)) {
      continue;
    }
    const applied = applySharedEvent(draft, event, noted) || applySchema2Execution(draft, event, seen);
    if (applied) updatedAt = later(updatedAt, event.timestamp);
  }
  // Reconcile appends missing events at the end of the file. Latest is the highest order, not the last line.
  publishLatestExecution(draft, seen);
  updatedAt = publishExecutionStatus(draft, inputs, updatedAt);
  publishRunningStages(draft, noted, inputs.executions);
  publishSkippedStages(draft, inputs.executions);
  if (updatedAt) draft.set('updated_at', updatedAt);
  return draft;
}

/** Stages whose latest execution is a run_when skip. The key is absent when there are none. */
function publishSkippedStages(draft: StatusDraft, executions: readonly FoldExecution[]): void {
  draft.clear('skipped_stages');
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
  if (rows.length > 0) draft.set('skipped_stages', rows);
}

interface RunningStage {
  execution_id: string | null;
  stage_id: string | null;
  client: unknown;
  event: string;
  summary: string | null;
  updated_at: string | null;
}

type SharedEventHandler = (draft: StatusDraft, event: ParsedEvent) => boolean;

function applyBaselineCaptured(draft: StatusDraft, event: ParsedEvent): boolean {
  if (isRecord(draft.get('baseline'))) return true;
  const baseline: Record<string, unknown> = {
    commit: typeof event.data.commit === 'string' ? event.data.commit : null,
    captured_at: event.timestamp,
  };
  const error = textOr(event.data.error);
  if (error) baseline.error = error;
  draft.set('baseline', baseline);
  return true;
}

const SHARED_EVENT_HANDLERS: Readonly<Record<string, SharedEventHandler>> = {
  'workflow.refreshed': () => false,
  'session.created': (draft, event) => {
    if (isRecord(event.data.handoff)) draft.set('handoff', cloneRecord(event.data.handoff));
    if (event.data.prepared !== true) return false;
    draft.set('status', 'prepared');
    return true;
  },
  'handoff.bound': (draft, event) => {
    if (isRecord(event.data.handoff)) draft.set('handoff', cloneRecord(event.data.handoff));
    return true;
  },
  'task.frozen': (draft, event) => {
    const hash = textOr(event.data.sha256);
    if (hash) draft.set('task_sha256', hash);
    return true;
  },
  'baseline.captured': applyBaselineCaptured,
  'revisions.reset': (draft, event) => {
    if (isRecord(event.data.baselines)) draft.set('revision_baselines', cloneRecord(event.data.baselines));
    return true;
  },
  'outputs.published': (draft, event) => {
    draft.mergePublished(event.data.outputs);
    return true;
  },
  'session.activated': (draft) => {
    draft.set('status', 'active');
    return true;
  },
};

function applyProviderEvent(draft: StatusDraft, event: ParsedEvent, noted: Map<string, RunningStage>): boolean {
  if (skipsStatusWrite(event.event)) return false;
  draft.set('latest_provider_event', event.raw);
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

function applySharedEvent(
  draft: StatusDraft,
  event: ParsedEvent,
  noted: Map<string, RunningStage>,
): boolean {
  const handler = Object.hasOwn(SHARED_EVENT_HANDLERS, event.event) ? SHARED_EVENT_HANDLERS[event.event] : undefined;
  if (handler !== undefined) return handler(draft, event);
  if (event.event.startsWith('provider.') || event.event.startsWith('verify.')) {
    return applyProviderEvent(draft, event, noted);
  }
  return false;
}

function applySessionLevelEvent(draft: StatusDraft, event: ParsedEvent): boolean {
  if (!event.event.startsWith('session.') || event.event === 'session.created' || event.event === 'session.activated') {
    return false;
  }
  const sessionStatus = event.event.slice('session.'.length);
  draft.set('status', sessionStatus);
  if (sessionStatus === 'completed' && event.data.manual !== true) {
    draft.set('completion_method', 'agent');
  }
  draft.applyTerminalFields(sessionStatus, { source: null, reason: textOr(event.data.reason) });
  return true;
}

function applyExecutionStarted(event: ParsedEvent, executionId: string, seen: Map<string, SeenExecution>): void {
  const current = seen.get(executionId);
  const order = Math.max(current?.order ?? 0, eventExecutionOrder(event));
  if (current && current.status !== 'running') {
    current.order = order;
    if (event.stageId) current.stageId = event.stageId;
    return;
  }
  seen.set(executionId, {
    order,
    stageId: event.stageId ?? current?.stageId ?? '',
    status: 'running',
    outcome: null,
  });
}

function applyExecutionTransition(event: ParsedEvent, executionId: string, seen: Map<string, SeenExecution>): void {
  const executionStatus = event.event.slice('execution.'.length);
  const current = seen.get(executionId) ?? {
    order: 0,
    stageId: event.stageId ?? '',
    status: executionStatus,
    outcome: null,
  };
  current.status = executionStatus;
  current.outcome = isRecord(event.data.outcome) ? event.data.outcome : null;
  current.order = Math.max(current.order, eventExecutionOrder(event));
  if (event.stageId) current.stageId = event.stageId;
  seen.set(executionId, current);
}

function applySchema2Execution(
  draft: StatusDraft,
  event: ParsedEvent,
  seen: Map<string, SeenExecution>,
): boolean {
  if (event.event === 'workflow.refreshed') return false;
  const { executionId } = event;
  if (!executionId) return applySessionLevelEvent(draft, event);
  if (event.event === 'execution.started') {
    applyExecutionStarted(event, executionId, seen);
    return true;
  }
  if (event.event.startsWith('execution.')) {
    applyExecutionTransition(event, executionId, seen);
    return true;
  }
  if (event.event.startsWith('stage.')) return decisionOf(outcomeRecord(event)) !== null;
  return event.event.startsWith('session.') && event.event !== 'session.created';
}

function publishLatestExecution(draft: StatusDraft, seen: ReadonlyMap<string, SeenExecution>): void {
  const latestId = latestSeenId(seen);
  if (latestId === null) return;
  const latest = seen.get(latestId);
  if (!latest) return;
  draft.noteLatestExecution(latestId, latest.status, latest.stageId);
  draft.recordLatestDecision(
    latestDecision([...seen.values()].map((row) => ({ order: row.order, outcome: row.outcome }))),
  );
}

function publishRunningStages(
  draft: StatusDraft,
  noted: ReadonlyMap<string, RunningStage>,
  executions: readonly FoldExecution[],
): void {
  draft.clear('current_stage');
  draft.clear('running_stages');
  const rows = executions
    .filter((execution) => execution.status === 'running')
    .sort((left, right) => {
      if (left.executionOrder !== right.executionOrder) return left.executionOrder - right.executionOrder;
      if (left.executionId < right.executionId) return -1;
      if (left.executionId > right.executionId) return 1;
      return 0;
    })
    .flatMap((execution) => {
      const stage = noted.get(execution.executionId);
      return stage === undefined ? [] : [{ ...stage, client: execution.client || null }];
    });
  if (rows.length > 0) draft.set('running_stages', rows);
}

/** Session status is the latest execution of each stage, not the highest-order row's stored status. */
function publishExecutionStatus(
  draft: StatusDraft,
  inputs: FoldInputs,
  updatedAt: string | null,
): string | null {
  const latest = latestExecution(inputs.executions);
  if (latest === null) return updatedAt;
  const rows = statusExecutionsFromFolds(inputs.executions);
  const pending = pendingResumesOf(inputs.events);
  const sessionStatus = sessionStatusWithPending(rows, draft.view, { workflow: inputs.workflow, pending });
  draft.set('status', sessionStatus);
  if (sessionStatus === 'completed' && !draft.get('completion_method')) {
    draft.set('completion_method', 'agent');
  }
  if (inputs.schemaVersion < MANIFEST_SCHEMA_EVENT_LOG) {
    draft.noteLatestExecution(latest.executionId, latest.status, latest.stageId);
    draft.recordLatestDecision(decisionOfOutcome(latest.outcome));
  }
  const questions = latestPerStage(rows).filter((row) => row.outcome?.status === 'question' && row.status !== 'running');
  draft.set('questions', questions.flatMap((row) => pendingQuestionRows(row, inputs.workflow)));
  if (questions.length === 0) draft.clear('questions');
  const blocked = blockedExecutions(rows, draft.view, inputs.workflow).map((row) => ({
    executionId: row.executionId,
    stageId: row.stageId,
    blocker: executionBlocker(inputs.executions, row.executionId),
  }));
  draft.applyTerminalFields(sessionStatus, {
    source: {
      executionId: latest.executionId,
      stageId: latest.stageId,
      blocker: textOr(latest.outcome?.blocker),
    },
    reason: null,
    blocked,
  });
  const resumedAt = applyBlockedResume(draft, inputs.events, {
    blockedIds: [...blocked, ...questions].map((row) => row.executionId),
    updatedAt: later(updatedAt, latest.completedAt ?? latest.createdAt),
  });
  const repliedAt = applyCancelledReply(draft, inputs.events, {
    cancelledIds: latestPerStage(rows).filter((row) => row.status === 'cancelled').map((row) => row.executionId),
    updatedAt: resumedAt,
  });
  applyPendingExpiry(draft, inputs, { rows, pending });
  return repliedAt;
}

/** With a pending resume decision, a resume or reply must not hide the stop recorded on the same stage. */
function applyPendingExpiry(
  draft: StatusDraft,
  inputs: FoldInputs,
  held: { rows: readonly StatusExecution[]; pending: readonly PendingResumeStop[] },
): void {
  if (held.pending.length === 0 || draft.get('status') !== 'active') return;
  const adjusted = pendingExpiryStatus({
    rows: held.rows,
    previousStatus: draft.view,
    workflow: inputs.workflow,
    pending: held.pending,
    events: inputs.events,
  });
  if (adjusted === null) return;
  draft.set('status', adjusted.status);
  const latest = latestExecution(inputs.executions);
  const stageOf = new Map(held.rows.map((row) => [row.executionId, row.stageId]));
  const source = latest === null
    ? null
    : { executionId: latest.executionId, stageId: latest.stageId, blocker: textOr(latest.outcome?.blocker) };
  const blocked = adjusted.blockedIds.map((executionId) => ({
    executionId,
    stageId: stageOf.get(executionId) ?? '',
    blocker: executionBlocker(inputs.executions, executionId),
  }));
  draft.applyTerminalFields(adjusted.status, { source, reason: null, blocked });
}

/**
 * A recorded reply to a cancelled stage makes the session runnable until the reply is dispatched.
 * Any cancelled stage with a reply is enough: the reply dispatches first, then the command reopens
 * the other cancelled stages in place.
 */
function applyCancelledReply(
  draft: StatusDraft,
  events: readonly ParsedEvent[],
  stopped: { cancelledIds: readonly string[]; updatedAt: string | null },
): string | null {
  const { cancelledIds, updatedAt } = stopped;
  const current = draft.get('status');
  if (typeof current !== 'string' || !isStopped(current) || cancelledIds.length === 0) return updatedAt;
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
  draft.set('status', 'active');
  draft.applyTerminalFields('active', { source: null, reason: null });
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

/** The last `session.active` event resuming this execution from blocked or question. */
function lastResumeOf(events: readonly ParsedEvent[], executionId: string): ParsedEvent | null {
  let resume: ParsedEvent | null = null;
  for (const event of events) {
    if (isStopResolutionEvent(event, 'blocked', executionId)) resume = event;
  }
  return resume;
}

/**
 * An explicit resume of a blocker or an answered question makes the session runnable.
 * Each stopped execution still requires its own resume event before dispatch.
 */
function applyBlockedResume(
  draft: StatusDraft,
  events: readonly ParsedEvent[],
  stopped: { blockedIds: readonly string[]; updatedAt: string | null },
): string | null {
  const { blockedIds, updatedAt } = stopped;
  const current = draft.get('status');
  if (typeof current !== 'string' || !isStageStop(current) || blockedIds.length === 0) return updatedAt;
  const resumes = blockedIds.flatMap((executionId) => {
    const resume = lastResumeOf(events, executionId);
    return resume === null ? [] : [resume];
  });
  if (resumes.length === 0) return updatedAt;
  draft.set('status', 'active');
  draft.applyTerminalFields('active', { source: null, reason: null });
  let next = updatedAt;
  for (const resume of resumes) next = later(next, resume.timestamp);
  return next;
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

function initialStatus(manifest: SessionManifest, schemaVersion: number): StatusDraft {
  const draft = new StatusDraft({
    session_id: manifest.sessionId,
    status: schemaVersion >= MANIFEST_SCHEMA_EVENT_LOG ? 'active' : manifestStatusToSession(manifest.manifestStatus),
  });
  draft.applyManifestIdentity(manifest);
  if (manifest.createdAt) draft.set('updated_at', manifest.createdAt);
  return draft;
}

export { readExecutions, readSessionManifest } from './session-fold-read.js';
export type { FoldExecution, FoldInputs, SessionManifest } from './session-fold-types.js';

function executionBlocker(executions: readonly FoldExecution[], executionId: string): string | null {
  return textOr(executions.find((execution) => execution.executionId === executionId)?.outcome?.blocker);
}

/** The status.json question rows for one stopped question execution. */
function pendingQuestionRows(row: StatusExecution, workflow: FoldInputs['workflow']): Record<string, unknown>[] {
  return (row.outcome?.questions ?? []).map((question) => ({
    ...question, execution_id: row.executionId, stage_id: row.stageId,
    recipient: workflow?.stages[row.stageId]?.ask ?? 'human',
    file: 'executions/' + row.executionId + '/questions.json',
  }));
}
