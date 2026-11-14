/** Opens or creates the session an execute run works on: lock, repair, reply resolution, workflow preparation. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { ClientRegistry, ExecutionSnapshot } from '@nodeint/migent-kernel';
import { ConfigurationError, endsScheduling, log, NextStage, readyStages, runnableNow, schedulableStageIds, Stop, stopReasonFor, utcNow, writeFileAtomic } from '@nodeint/migent-kernel';
import { activatePreparedSession, appendLifecycleEvent, assertSingleLineTask, bindPriorSessionId, commitFoldedStatus, createWorkflowSession, type HumanInput, loadFrozenWorkflow, type QuestionAnswerRecord, readWorkflowFreeze, repairSessionUnlocked, requireLiveWorkflow, requireTaskBody, resolvePriorSessionId, SessionLock, SessionStore, warnIfFrozenDrift, WORKFLOW_FREEZE_FILE, writeWorkflowFreeze } from '@nodeint/migent-session';
import { isRecord, isWorkflowV2, loadNamedWorkflow, type WorkflowDocument } from '@nodeint/migent-workflow';

import { executeFinal, type ExecuteResult, PendingStageReply, resumeInputs, selectedStage, text } from './dispatch.js';

export function preflightFailed(sessionId: string): ExecuteResult {
  return {
    code: 2,
    status: '',
    stopReason: 'configuration',
    sessionId,
    latestDecision: null,
    latestExecutionId: null,
    outputs: {},
    stages: [],
  };
}

export function requireEligibleStage(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  target: { sessionStatus: string; stageId: string },
): string {
  const { sessionStatus, stageId } = target;
  if (isWorkflowV2(workflow)) {
    const ready = readyStages(workflow, snapshots, { sessionStatus });
    if (ready.includes(stageId)) return stageId;
    const first = runnableNow(workflow, ready, { running: [], concurrency: workflow.concurrency ?? 1, snapshots })[0] ?? ready[0] ?? '';
    throw new ConfigurationError(`Stage ${stageId} is not the eligible stage ${first}.`);
  }
  const selected = selectedStage(workflow, snapshots, { sessionStatus });
  if (selected instanceof Stop) throw new ConfigurationError(`Session is ${selected.reason}.`);
  if (selected.stageId !== stageId) {
    throw new ConfigurationError(`Stage ${stageId} is not the eligible stage ${selected.stageId}.`);
  }
  return selected.stageId;
}

export function verifyOnlyExecution(workspace: string, sessionId: string, executionId: string): boolean {
  const context = new SessionStore(workspace).executionContext(sessionId, executionId);
  if (context === null) return false;
  const metadata = JSON.parse(readFileSync(path.join(context.directory, 'execution.json'), 'utf8')) as unknown;
  return isRecord(metadata) && metadata.kind === 'verify';
}

function bindExecuteRun(
  workspace: string,
  sessionId: string,
  requested: { workflowId: string | null | undefined; priorSessionId: string | null | undefined },
): { workflowId: string; status: Record<string, unknown> } {
  const { workflowId, priorSessionId } = requested;
  const status = new SessionStore(workspace).readSessionStatus(sessionId);
  const storedWorkflow = status.workflow_id;
  if (Object.keys(status).length === 0 || typeof storedWorkflow !== 'string' || storedWorkflow === '') {
    throw new ConfigurationError(`Session not found: ${sessionId}.`);
  }
  if (storedWorkflow === 'agent') {
    throw new ConfigurationError(`Session ${sessionId} is not a named workflow session.`);
  }
  if (workflowId && workflowId !== storedWorkflow) {
    const resolved = loadNamedWorkflow(workspace, workflowId).id;
    if (resolved !== storedWorkflow) {
      throw new ConfigurationError(`Workflow ${resolved} does not match session ${storedWorkflow}.`);
    }
  }
  bindPriorSessionId(workspace, sessionId, priorSessionId);
  return { workflowId: storedWorkflow, status };
}

function refreshSessionWorkflow(
  workspace: string,
  sessionId: string,
  options: { startPrepared: boolean; registry: ClientRegistry },
): void {
  const { startPrepared, registry } = options;
  const sessionDirectory = path.join(workspace, '.migent', 'sessions', sessionId);
  const freeze = readWorkflowFreeze(sessionDirectory);
  const status = new SessionStore(workspace).readSessionStatus(sessionId);
  const sessionStatus = typeof status.status === 'string' ? status.status : '';
  assertRefreshable(sessionId, sessionStatus, { startPrepared, frozen: freeze !== null });
  const workflowPath = typeof status.workflow_path === 'string' ? status.workflow_path : null;
  const workflowId = typeof status.workflow_id === 'string' ? status.workflow_id : null;
  const live = requireLiveWorkflow(workspace, workflowPath, workflowId);
  refreezeWorkflow(workspace, sessionDirectory, { workflow: live, registry });
}

// Rejects a refresh of a finished, frozen-less, or wrongly prepared session.
function assertRefreshable(
  sessionId: string,
  sessionStatus: string,
  state: { startPrepared: boolean; frozen: boolean },
): void {
  if (sessionStatus === 'completed' || sessionStatus === 'cancelled') {
    throw new ConfigurationError(`Session ${sessionId} is ${sessionStatus}.`);
  }
  if (!state.startPrepared && sessionStatus === 'prepared') {
    throw new ConfigurationError(`Session ${sessionId} is prepared. Run: ${preparedRunHint(sessionId)}`);
  }
  if (!state.frozen) throw new ConfigurationError(`Session ${sessionId} has no frozen workflow.`);
  if (state.startPrepared && sessionStatus !== 'prepared') {
    throw new ConfigurationError(notPreparedHint(sessionId, sessionStatus));
  }
}

function notPreparedHint(sessionId: string, sessionStatus: string): string {
  return sessionStatus === 'active'
    ? `Session ${sessionId} is active. Resume with: migent session continue ${sessionId}`
    : `Session ${sessionId} is ${sessionStatus || 'unknown'}. migent session run --session only starts a prepared session.`;
}

// Rewrites the frozen workflow and records the refresh, restoring the previous freeze on failure.
function refreezeWorkflow(
  workspace: string,
  sessionDirectory: string,
  next: { workflow: Parameters<typeof writeWorkflowFreeze>[1]['workflow']; registry: ClientRegistry },
): void {
  const freezePath = path.join(sessionDirectory, WORKFLOW_FREEZE_FILE);
  const previousText = readFileSync(freezePath, 'utf8');
  const previousHash = createHash('sha256').update(previousText).digest('hex');
  const { workflow, registry } = next;
  const written = writeWorkflowFreeze(sessionDirectory, { workspace, workflow, resolveClient: registry });
  try {
    appendLifecycleEvent(sessionDirectory, {
      event: 'workflow.refreshed',
      timestamp: utcNow(),
      data: {
        hash: written.hash,
        previous_hash: previousHash,
        source_sha256: written.sourceSha256,
      },
    });
    commitFoldedStatus(workspace, sessionDirectory);
  } catch (error) {
    writeFileAtomic(freezePath, previousText);
    throw error;
  }
}

function preparedRunHint(sessionId: string): string {
  return `migent session run --session ${sessionId}`;
}

export interface ExecuteRequest {
  workflowId?: string | null;
  task?: string | null;
  sessionId?: string | null;
  stageId?: string | null;
  /** Stage that receives `reply` when `stageId` is not set. It does not limit dispatch to one stage. */
  replyStageId?: string | null;
  priorSessionId?: string | null;
  maxDispatches?: number | null;
  once?: boolean;
  resetRevisions?: boolean;
  /** `session continue` writes `from: failed` before dispatch. A plain run leaves this false. */
  continueFailed?: boolean;
  startPrepared?: boolean;
  refreshWorkflow?: boolean;
  /**
   * Runs once the request is validated and before a new session is created or a prepared one is
   * frozen. Returning false stops the run with a configuration error and leaves nothing behind.
   */
  preflight?: (target: { workflowId: string | null; sessionId: string | null }) => Promise<boolean>;
  /** Reply for one blocked stage or pending question. */
  reply?: string | null;
  /**
   * `session resume`: `stageId` is the target of a recorded resume decision. Only that stage's cancelled executions
   * are judged and reopened; every other cancelled stage stays as it is.
   */
  resumeTarget?: boolean;
}

/**
 * Owns the session lock for one run. The caller releases it in a `finally`, so the lock and the id
 * are recorded the moment they are acquired, before any later opening step can throw.
 */
export class HeldSession {
  private heldLock: SessionLock | null = null;
  private heldSessionId: string | null = null;

  public get lock(): SessionLock | null {
    return this.heldLock;
  }

  public get sessionId(): string | null {
    return this.heldSessionId;
  }

  /** Take the lock of `sessionId`. The id is recorded first so a failed acquire is still cleaned up. */
  public acquire(workspace: string, sessionId: string): void {
    this.heldSessionId = sessionId;
    this.heldLock = SessionLock.acquire(path.join(workspace, '.migent', 'sessions', sessionId));
  }
}

export type SessionOpenResult =
  | { kind: 'final'; result: ExecuteResult }
  | {
      kind: 'ready';
      sessionId: string;
      workflow: WorkflowDocument;
      workflowId: string;
      stageReply: PendingStageReply | null;
      resumeCancelled: boolean;
      reopenLatestCancelled: boolean;
    };

/** What opening an existing session binds: its workflow id, stored status, and session status. */
interface ExistingSession {
  workflowId: string;
  status: Record<string, unknown>;
  sessionStatus: string;
}

/** What the reply step decides before the session starts or resumes. */
interface ResolvedReply {
  stageReply: PendingStageReply | null;
  sessionStatus: string;
  resumeCancelled: boolean;
  reopenLatestCancelled: boolean;
  // A cancelled-stage reply never resumes blocked siblings; they keep their blockers.
  cancelledReplyStage: boolean;
}

/** Opens or creates the session, resolves any reply, and prepares the workflow. Statement order is the run contract. */
export async function openExecuteSession(
  workspace: string,
  request: ExecuteRequest,
  deps: { held: HeldSession; registry: ClientRegistry; store: SessionStore },
): Promise<SessionOpenResult> {
  const { held, registry, store } = deps;
  const stageId = request.stageId ?? null;
  const replyText = typeof request.reply === 'string' ? request.reply : null;
  let opened: OpenedSession;
  if (request.sessionId) {
    const target = { ...deps, sessionId: request.sessionId, replyText };
    const resumed = await resumeExistingSession(workspace, request, target);
    if ('result' in resumed) return { kind: 'final', result: resumed.result };
    opened = resumed;
  } else {
    const created = await createExecuteSession(workspace, request, { held, registry, replyText, stageId });
    if ('code' in created) return { kind: 'final', result: created };
    const { sessionId, workflow } = created;
    opened = { sessionId, workflow, workflowId: workflow.id, ...UNCHANGED_REPLY };
  }
  const { sessionId, workflow, workflowId } = opened;
  const session = { store, sessionId, stageId, opened: workflow, workflowId };
  const prepared = prepareSessionWorkflow(workspace, request, session);
  const { stageReply, resumeCancelled, reopenLatestCancelled } = opened;
  return { kind: 'ready', sessionId, workflow: prepared, workflowId, stageReply, resumeCancelled, reopenLatestCancelled };
}

/** The session a run continues with, before its workflow is prepared. */
interface OpenedSession {
  sessionId: string;
  workflow: WorkflowDocument | null;
  workflowId: string;
  stageReply: PendingStageReply | null;
  resumeCancelled: boolean;
  reopenLatestCancelled: boolean;
}

/** Existing session: open, resolve the reply, start if prepared, resume blockers, stop when terminal. */
async function resumeExistingSession(
  workspace: string,
  request: ExecuteRequest,
  open: {
    held: HeldSession;
    registry: ClientRegistry;
    store: SessionStore;
    sessionId: string;
    replyText: string | null;
  },
): Promise<OpenedSession | { result: ExecuteResult }> {
  const { held, registry, store, sessionId, replyText } = open;
  const stageId = request.stageId ?? null;
  const replyStageId = stageId ?? request.replyStageId ?? null;
  const existing = openExistingSession(workspace, request, { held, registry, sessionId });
  const openedStatus = existing.sessionStatus;
  const resolved = resolveStageReply(workspace, store, { sessionId, replyText, replyStageId, openedStatus });
  const { stageReply, cancelledReplyStage } = resolved;
  const prepared = { registry, sessionId, sessionStatus: resolved.sessionStatus };
  const started = await startOrRejectPrepared(workspace, request, prepared);
  if (started.rejected !== null) return { result: started.rejected };
  const blocked = { sessionStatus: started.sessionStatus, stageReply, cancelledReplyStage };
  const reopened = resumeBlockedStages(store, { sessionId, stageId }, blocked) !== null;
  const sessionStatus = reopened ? 'active' : started.sessionStatus;
  const reopenLatestCancelled = reopened || resolved.reopenLatestCancelled;
  const stops = stopsBeforeRun({ sessionStatus, scoped: request.resumeTarget === true, reopenLatestCancelled });
  if (stops) return { result: executeFinal(existing.status, stopReasonFor(sessionStatus), []) };
  const resumeCancelled = request.resumeTarget === true || reopened || sessionStatus === 'cancelled' || resolved.resumeCancelled;
  const { workflowId } = existing;
  return { sessionId, workflow: null, workflowId, stageReply, resumeCancelled, reopenLatestCancelled };
}

/** A session that ends scheduling stops the run, unless cancelled work will be reopened or a decision is scoped. */
function stopsBeforeRun(state: { sessionStatus: string; scoped: boolean; reopenLatestCancelled: boolean }): boolean {
  const { sessionStatus, scoped, reopenLatestCancelled } = state;
  return !scoped && sessionStatus !== 'cancelled' && !reopenLatestCancelled && endsScheduling(sessionStatus);
}

/** Existing session: existence check, lock, repair, optional refresh, run binding, drift warning, status. */
function openExistingSession(
  workspace: string,
  request: ExecuteRequest,
  open: { held: HeldSession; registry: ClientRegistry; sessionId: string },
): ExistingSession {
  const { held, registry, sessionId } = open;
  if (!existsSync(path.join(workspace, '.migent', 'sessions', sessionId))) {
    throw new ConfigurationError(`Session not found: ${sessionId}.`);
  }
  held.acquire(workspace, sessionId);
  repairSessionUnlocked(workspace, sessionId);
  if (request.refreshWorkflow && !request.startPrepared) refreshSessionWorkflow(
    workspace,
    sessionId,
    { startPrepared: false, registry },
  );
  const bound = bindExecuteRun(
    workspace,
    sessionId,
    { workflowId: request.workflowId, priorSessionId: request.priorSessionId },
  );
  if (!request.refreshWorkflow) {
    const workflowPath = typeof bound.status.workflow_path === 'string' ? bound.status.workflow_path : null;
    const storedWorkflow = typeof bound.status.workflow_id === 'string' ? bound.status.workflow_id : null;
    warnIfFrozenDrift(workspace, sessionId, { workflowPath, workflowId: storedWorkflow, resolveClient: registry });
  }
  return {
    workflowId: bound.workflowId,
    status: bound.status,
    sessionStatus: typeof bound.status.status === 'string' ? bound.status.status : '',
  };
}

/** Empty-reply check, reply target resolution, pending reply recovery, and pending cancelled reopen. */
function resolveStageReply(
  workspace: string,
  store: SessionStore,
  reply: { sessionId: string; replyText: string | null; replyStageId: string | null; openedStatus: string },
): ResolvedReply {
  const { sessionId, replyText, replyStageId, openedStatus } = reply;
  if (replyText !== null && replyText.trim() === '') {
    throw new ConfigurationError('--reply is empty.');
  }
  const applied =
    replyText === null
      ? recoverRecordedReply(store, { sessionId, replyStageId })
      : applyExplicitReply(workspace, store, { sessionId, replyText, replyStageId });
  const resolved: ResolvedReply = { ...UNCHANGED_REPLY, sessionStatus: openedStatus, ...applied };
  if (!resolved.resumeCancelled && pendingCancelledReopen(store, sessionId)) {
    return { ...resolved, resumeCancelled: true, reopenLatestCancelled: true };
  }
  return resolved;
}

const UNCHANGED_REPLY = {
  stageReply: null,
  resumeCancelled: false,
  reopenLatestCancelled: false,
  cancelledReplyStage: false,
} as const;

// A reply that reopens a cancelled stage makes the session active again.
function cancelledReply(stageReply: PendingStageReply): Partial<ResolvedReply> {
  return {
    stageReply,
    sessionStatus: 'active',
    cancelledReplyStage: true,
    resumeCancelled: true,
    reopenLatestCancelled: true,
  };
}

// A saved reply makes the session active while another cancelled stage still waits to be reopened.
function pendingCancelledReopen(store: SessionStore, sessionId: string): boolean {
  if (store.pendingCancelledReply(sessionId) === null) return false;
  const superseded = store.supersededExecutionIds(sessionId);
  return store.cancelledStages(sessionId).some((row) => !superseded.has(row.executionId));
}

// Picks the waiting stage a `--reply` targets, rejecting ambiguous or unknown targets.
function replyTarget(waiting: readonly { stageId: string }[], replyStageId: string | null): string {
  if (waiting.length === 0) throw new ConfigurationError('--reply requires a blocked, cancelled, or question stage.');
  if (waiting.length > 1 && replyStageId === null) {
    const ids = waiting.map((row) => row.stageId).join(', ');
    throw new ConfigurationError(`--reply needs --stage when more than one stage is waiting: ${ids}.`);
  }
  const target = replyStageId ?? waiting[0].stageId;
  if (!waiting.some((row) => row.stageId === target)) {
    throw new ConfigurationError(`Stage ${target} is not waiting for a reply.`);
  }
  return target;
}

// Applies a `--reply` to its blocked, question, or cancelled target stage.
function applyExplicitReply(
  workspace: string,
  store: SessionStore,
  reply: { sessionId: string; replyText: string; replyStageId: string | null },
): Partial<ResolvedReply> {
  const { sessionId, replyText, replyStageId } = reply;
  const cancelled = store.cancelledStages(sessionId);
  const waiting = [...store.blockedStages(sessionId), ...store.questionStages(sessionId), ...cancelled];
  const target = replyTarget(waiting, replyStageId);
  const cancelledTarget = cancelled.find((row) => row.stageId === target);
  if (store.questionStages(sessionId).some((row) => row.stageId === target)) {
    const saved = store.resumeQuestion(sessionId, target, replyText);
    return { stageReply: new PendingStageReply(target, saved.formatted, answersInput(saved)), sessionStatus: 'active' };
  }
  if (cancelledTarget) {
    if (verifyOnlyExecution(workspace, sessionId, cancelledTarget.executionId)) {
      throw new ConfigurationError(
        `Stage ${target} has no agent to reply to. Omit --reply to run its verify list again.`,
      );
    }
    store.supersedeCancelled(sessionId, target, { text: replyText, origin: 'human' });
    const human = replyInput(replyText, cancelledTarget.executionId);
    return cancelledReply(new PendingStageReply(target, replyText, human));
  }
  const blockedTarget = store.blockedStages(sessionId).find((row) => row.stageId === target);
  const human = blockedTarget ? replyInput(replyText, blockedTarget.executionId) : null;
  return { stageReply: new PendingStageReply(target, replyText, human) };
}

// Recovers a question answer or cancelled-stage reply recorded before an interrupted dispatch.
function recoverRecordedReply(
  store: SessionStore,
  reply: { sessionId: string; replyStageId: string | null },
): Partial<ResolvedReply> {
  const { sessionId, replyStageId } = reply;
  // Recover an answer recorded before a dispatch was interrupted or failed preflight.
  const [answered] = store.questionStages(sessionId).flatMap((row) => {
    const saved = store.questionAnswer(sessionId, row.executionId);
    const matches = replyStageId === null || replyStageId === row.stageId;
    return saved !== null && matches ? [{ ...row, saved }] : [];
  });
  if (answered) {
    const { saved } = answered;
    return { stageReply: new PendingStageReply(answered.stageId, saved.formatted, answersInput(saved)) };
  }
  // Recover a reply to a cancelled stage that was recorded before its dispatch.
  const pending = store.pendingCancelledReply(sessionId, replyStageId);
  if (pending) {
    // Only a human reply is human input. Cut-off text and replies saved without an origin are not.
    const human = pending.origin === 'human' ? replyInput(pending.reply, pending.executionId) : null;
    return cancelledReply(new PendingStageReply(pending.stageId, pending.reply, human));
  }
  return {};
}

function replyInput(text: string, respondsToExecutionId: string): HumanInput {
  return { kind: 'reply', sent: text, input: text, respondsToExecutionId };
}

function answersInput(saved: QuestionAnswerRecord): HumanInput {
  return { kind: 'answers', sent: saved.formatted, input: saved.input, answers: saved.answers, respondsToExecutionId: saved.target };
}

/**
 * Prepared start (preflight, activate) or the prepared-session rejection. `rejected` is a final
 * result when preflight fails; otherwise `sessionStatus` is the status the run continues with.
 */
async function startOrRejectPrepared(
  workspace: string,
  request: ExecuteRequest,
  prepared: { registry: ClientRegistry; sessionId: string; sessionStatus: string },
): Promise<{ rejected: ExecuteResult | null; sessionStatus: string }> {
  const { registry, sessionId, sessionStatus } = prepared;
  if (request.startPrepared) {
    if (sessionStatus !== 'prepared') throw new ConfigurationError(notPreparedHint(sessionId, sessionStatus));
    if (request.preflight) {
      requireTaskBody(workspace, sessionId);
      if (!(await request.preflight({ workflowId: null, sessionId }))) {
        return { rejected: preflightFailed(sessionId), sessionStatus };
      }
    }
    activatePreparedSession(workspace, sessionId, registry);
    return { rejected: null, sessionStatus: 'active' };
  }
  if (sessionStatus === 'prepared') {
    throw new ConfigurationError(
      `Session ${sessionId} is prepared. Run: ${preparedRunHint(sessionId)}`,
    );
  }
  return { rejected: null, sessionStatus };
}

/**
 * Blocked resume: a blocked session, or a reply to a blocked stage, reopens its blockers.
 * Returns the stages it resumed, or null when nothing was blocked for this run.
 */
function resumeBlockedStages(
  store: SessionStore,
  target: { sessionId: string; stageId: string | null },
  opened: { sessionStatus: string; stageReply: PendingStageReply | null; cancelledReplyStage: boolean },
): readonly { stageId: string; executionId: string }[] | null {
  const { sessionId, stageId } = target;
  const { stageReply } = opened;
  const blockedReply =
    stageReply !== null && store.blockedStages(sessionId).some((row) => row.stageId === stageReply.stageId);
  if (opened.cancelledReplyStage || (opened.sessionStatus !== 'blocked' && !blockedReply)) return null;
  const resumed = store.resumeBlockedSession(
    sessionId,
    stageReply?.stageId ?? stageId,
    blockedReply ? stageReply.text : null,
  );
  for (const item of resumed) {
    const stageLabel = item.stageId || 'its stage';
    const withReply = stageReply?.stageId === item.stageId ? ' with a reply' : '';
    log(`session ${sessionId} was blocked by ${item.executionId}. Resuming ${stageLabel}${withReply}.`);
  }
  // Decision 8 hides a cancelled sibling. Reopen that stage in place before new work.
  return resumed;
}

/** New session: reply and refresh rejections, workflow load, prior resolve, eligibility, preflight, create, lock. */
async function createExecuteSession(
  workspace: string,
  request: ExecuteRequest,
  creation: { held: HeldSession; registry: ClientRegistry; replyText: string | null; stageId: string | null },
): Promise<ExecuteResult | { sessionId: string; workflow: WorkflowDocument }> {
  const { held, registry, replyText, stageId } = creation;
  if (replyText !== null) throw new ConfigurationError('--reply requires a blocked session.');
  if (request.refreshWorkflow) {
    throw new ConfigurationError('--refresh-workflow requires an existing session.');
  }
  if (!request.workflowId) throw new ConfigurationError('Creating a session requires a workflow.');
  const workflow = loadNamedWorkflow(workspace, request.workflowId);
  resolvePriorSessionId(workspace, workflow, request.priorSessionId);
  if (stageId !== null) requireEligibleStage(workflow, [], { sessionStatus: 'active', stageId });
  if (request.preflight) {
    // Argument errors come before the doctor checks.
    if (request.task) assertSingleLineTask(request.task);
    if (!(await request.preflight({ workflowId: request.workflowId, sessionId: null }))) return preflightFailed('');
  }
  const sessionId = createWorkflowSession(
    workspace,
    workflow.id,
    { task: request.task, priorSessionId: request.priorSessionId, resolveClient: registry },
  );
  held.acquire(workspace, sessionId);
  log(`session_id: ${sessionId}`);
  return { sessionId, workflow };
}

/** Frozen workflow load, then the revision reset and failed-resume marking the request asked for. */
function prepareSessionWorkflow(
  workspace: string,
  request: ExecuteRequest,
  session: {
    store: SessionStore;
    sessionId: string;
    stageId: string | null;
    opened: WorkflowDocument | null;
    workflowId: string;
  },
): WorkflowDocument {
  const { store, sessionId, stageId, opened, workflowId } = session;
  let workflow = opened;
  const frozenDocument = loadFrozenWorkflow(path.join(workspace, '.migent', 'sessions', sessionId));
  if (frozenDocument) workflow = frozenDocument;
  else if (workflow === null) workflow = loadNamedWorkflow(workspace, workflowId);
  if (request.resetRevisions) resetRevisionsIfStartable(workspace, store, { sessionId, workflow });
  if (request.continueFailed) store.markFailedResumes(sessionId, stageId);
  return workflow;
}

// Resets revision counts when the session is cancelled or a stage could start once the cap is lifted.
function resetRevisionsIfStartable(
  workspace: string,
  store: SessionStore,
  session: { sessionId: string; workflow: WorkflowDocument },
): void {
  const { sessionId, workflow } = session;
  store.reapOrphanedExecutions(sessionId, 'raise');
  const snapshots = store.executionSnapshots(sessionId);
  const current = text(store.readSessionStatus(sessionId).status);
  const inputs = (): ReturnType<typeof resumeInputs> => resumeInputs(workspace, sessionId);
  let reset: boolean;
  if (current === 'cancelled') {
    reset = true;
  } else if (isWorkflowV2(workflow)) {
    // The reset is what lifts the cap, so the cap must not hide the stage continue is about to allow.
    const openBaselines: Record<string, number> = {};
    for (const stageId of Object.keys(workflow.stages)) openBaselines[stageId] = Number.MAX_SAFE_INTEGER;
    const startable = schedulableStageIds(workflow, snapshots, {
      sessionStatus: current,
      revisionBaselines: openBaselines,
      ...inputs(),
      verifyTried: new Set(),
    });
    reset = startable.length > 0;
  } else {
    const selected = selectedStage(workflow, snapshots, { sessionStatus: current, ...inputs() });
    reset = selected instanceof NextStage;
  }
  if (reset) store.resetRevisionCounts(sessionId, snapshots);
}
