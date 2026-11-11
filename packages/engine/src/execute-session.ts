/** Opens or creates the session an execute run works on: lock, repair, reply resolution, workflow preparation. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { ClientRegistry, ExecutionSnapshot } from '@nodeint/migent-kernel';
import { ConfigurationError, log, NextStage, readyStages, runnableNow, schedulableStageIds, Stop, utcNow, writeFileAtomic } from '@nodeint/migent-kernel';
import { activatePreparedSession, appendLifecycleEvent, assertSingleLineTask, bindPriorSessionId, commitFoldedStatus, createWorkflowSession, loadFrozenWorkflow, readWorkflowFreeze, repairSessionUnlocked, requireLiveWorkflow, requireTaskBody, resolvePriorSessionId, SessionLock, SessionStore, warnIfFrozenDrift, WORKFLOW_FREEZE_FILE, writeWorkflowFreeze } from '@nodeint/migent-session';
import { isRecord, isWorkflowV2, loadNamedWorkflow, type WorkflowDocument } from '@nodeint/migent-workflow';

import { blockResumes, executeFinal, type ExecuteResult, PendingStageReply, selectedStage, TERMINAL_SESSION_STATUSES, text } from './dispatch.js';

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
  sessionStatus: string,
  stageId: string,
): string {
  if (isWorkflowV2(workflow)) {
    const ready = readyStages(workflow, snapshots, sessionStatus);
    if (ready.includes(stageId)) return stageId;
    const first = runnableNow(workflow, ready, [], workflow.concurrency ?? 1, snapshots)[0] ?? ready[0] ?? '';
    throw new ConfigurationError(`Stage ${stageId} is not the eligible stage ${first}.`);
  }
  const selected = selectedStage(workflow, snapshots, sessionStatus);
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
  workflowId: string | null | undefined,
  priorSessionId: string | null | undefined,
): { workflowId: string; status: Record<string, unknown> } {
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
  startPrepared: boolean,
  registry: ClientRegistry,
): void {
  const sessionDirectory = path.join(workspace, '.migent', 'sessions', sessionId);
  const freeze = readWorkflowFreeze(sessionDirectory);
  const status = new SessionStore(workspace).readSessionStatus(sessionId);
  const sessionStatus = typeof status.status === 'string' ? status.status : '';
  if (sessionStatus === 'completed' || sessionStatus === 'cancelled') {
    throw new ConfigurationError(`Session ${sessionId} is ${sessionStatus}.`);
  }
  if (!startPrepared && sessionStatus === 'prepared') {
    throw new ConfigurationError(`Session ${sessionId} is prepared. Run: ${preparedRunHint(sessionId)}`);
  }
  if (freeze === null) throw new ConfigurationError(`Session ${sessionId} has no frozen workflow.`);
  if (startPrepared && sessionStatus !== 'prepared') {
    const hint =
      sessionStatus === 'active'
        ? `Session ${sessionId} is active. Resume with: migent session continue ${sessionId}`
        : `Session ${sessionId} is ${sessionStatus || 'unknown'}. migent session run --session only starts a prepared session.`;
    throw new ConfigurationError(hint);
  }
  const workflowPath = typeof status.workflow_path === 'string' ? status.workflow_path : null;
  const workflowId = typeof status.workflow_id === 'string' ? status.workflow_id : null;
  const live = requireLiveWorkflow(workspace, workflowPath, workflowId);
  const freezePath = path.join(sessionDirectory, WORKFLOW_FREEZE_FILE);
  const previousText = readFileSync(freezePath, 'utf8');
  const previousHash = createHash('sha256').update(previousText).digest('hex');
  const written = writeWorkflowFreeze(sessionDirectory, workspace, live, registry);
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
  held: HeldSession,
  registry: ClientRegistry,
  store: SessionStore,
): Promise<SessionOpenResult> {
  const stageId = request.stageId ?? null;
  const replyStageId = stageId ?? request.replyStageId ?? null;
  const replyText = typeof request.reply === 'string' ? request.reply : null;
  let workflow: WorkflowDocument | null = null;
  let workflowId: string;
  let stageReply: PendingStageReply | null = null;
  let resumeCancelled = false;
  let reopenLatestCancelled = false;
  const requestedId = request.sessionId ?? null;
  let sessionId: string;
  if (requestedId) {
    sessionId = requestedId;
    const existing = openExistingSession(workspace, request, held, registry, sessionId);
    workflowId = existing.workflowId;
    const resolved = resolveStageReply(workspace, store, sessionId, replyText, replyStageId, existing.sessionStatus);
    ({ stageReply, resumeCancelled, reopenLatestCancelled } = resolved);
    const started = await startOrRejectPrepared(workspace, request, registry, sessionId, resolved.sessionStatus);
    if (started.rejected !== null) return { kind: 'final', result: started.rejected };
    let { sessionStatus } = started;
    const resumed = resumeBlockedStages(store, sessionId, stageId, {
      sessionStatus,
      stageReply,
      cancelledReplyStage: resolved.cancelledReplyStage,
    });
    if (resumed !== null) {
      sessionStatus = 'active';
      resumeCancelled = true;
      reopenLatestCancelled = true;
    }
    if (sessionStatus === 'cancelled') {
      resumeCancelled = true;
    } else if (!reopenLatestCancelled && TERMINAL_SESSION_STATUSES.has(sessionStatus)) {
      return { kind: 'final', result: executeFinal(existing.status, sessionStatus, []) };
    }
  } else {
    const created = await createExecuteSession(workspace, request, held, registry, replyText, stageId);
    if ('code' in created) return { kind: 'final', result: created };
    ({ sessionId, workflow } = created);
    workflowId = workflow.id;
  }
  const prepared = prepareSessionWorkflow(workspace, request, store, sessionId, stageId, workflow, workflowId);
  return {
    kind: 'ready',
    sessionId,
    workflow: prepared,
    workflowId,
    stageReply,
    resumeCancelled,
    reopenLatestCancelled,
  };
}

/** Existing session: existence check, lock, repair, optional refresh, run binding, drift warning, status. */
function openExistingSession(
  workspace: string,
  request: ExecuteRequest,
  held: HeldSession,
  registry: ClientRegistry,
  sessionId: string,
): ExistingSession {
  if (!existsSync(path.join(workspace, '.migent', 'sessions', sessionId))) {
    throw new ConfigurationError(`Session not found: ${sessionId}.`);
  }
  held.acquire(workspace, sessionId);
  repairSessionUnlocked(workspace, sessionId);
  if (request.refreshWorkflow && !request.startPrepared) refreshSessionWorkflow(workspace, sessionId, false, registry);
  const bound = bindExecuteRun(workspace, sessionId, request.workflowId, request.priorSessionId);
  if (!request.refreshWorkflow) {
    const workflowPath = typeof bound.status.workflow_path === 'string' ? bound.status.workflow_path : null;
    const storedWorkflow = typeof bound.status.workflow_id === 'string' ? bound.status.workflow_id : null;
    warnIfFrozenDrift(workspace, sessionId, workflowPath, storedWorkflow, registry);
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
  sessionId: string,
  replyText: string | null,
  replyStageId: string | null,
  openedStatus: string,
): ResolvedReply {
  let sessionStatus = openedStatus;
  let resumeCancelled = false;
  let reopenLatestCancelled = false;
  let cancelledReplyStage = false;
  let stageReply: PendingStageReply | null = null;
  if (replyText !== null && replyText.trim() === '') {
    throw new ConfigurationError('--reply is empty.');
  }
  if (replyText !== null) {
    const cancelled = store.cancelledStages(sessionId);
    const waiting = [...store.blockedStages(sessionId), ...store.questionStages(sessionId), ...cancelled];
    if (waiting.length === 0) throw new ConfigurationError('--reply requires a blocked, cancelled, or question stage.');
    if (waiting.length > 1 && replyStageId === null) throw new ConfigurationError(`--reply needs --stage when more than one stage is waiting: ${waiting.map((row) => row.stageId).join(', ')}.`);
    const target = replyStageId ?? waiting[0]!.stageId;
    if (!waiting.some((row) => row.stageId === target)) throw new ConfigurationError(`Stage ${target} is not waiting for a reply.`);
    let text = replyText;
    const cancelledTarget = cancelled.find((row) => row.stageId === target);
    if (store.questionStages(sessionId).some((row) => row.stageId === target)) {
      text = store.resumeQuestion(sessionId, target, replyText);
      sessionStatus = 'active';
    } else if (cancelledTarget) {
      if (verifyOnlyExecution(workspace, sessionId, cancelledTarget.executionId)) {
        throw new ConfigurationError(`Stage ${target} has no agent to reply to. Omit --reply to run its verify list again.`);
      }
      store.supersedeCancelled(sessionId, target, replyText);
      sessionStatus = 'active';
      cancelledReplyStage = true;
      resumeCancelled = true;
      reopenLatestCancelled = true;
    }
    stageReply = new PendingStageReply(target, text);
  } else {
    // Recover an answer recorded before a dispatch was interrupted or failed preflight.
    const answered = store.questionStages(sessionId).map((row) => ({
      ...row, reply: store.questionReply(sessionId, row.executionId),
    })).find((row) => row.reply !== null && (replyStageId === null || replyStageId === row.stageId));
    if (answered) stageReply = new PendingStageReply(answered.stageId, answered.reply!);
    else {
      // Recover a reply to a cancelled stage that was recorded before its dispatch.
      const pending = store.pendingCancelledReply(sessionId, replyStageId);
      if (pending) {
        stageReply = new PendingStageReply(pending.stageId, pending.reply);
        sessionStatus = 'active';
        cancelledReplyStage = true;
        resumeCancelled = true;
        reopenLatestCancelled = true;
      }
    }
  }
  if (!resumeCancelled && store.pendingCancelledReply(sessionId) !== null) {
    // A saved reply makes the session active while another cancelled stage still waits to be reopened.
    const superseded = store.supersededExecutionIds(sessionId);
    if (store.cancelledStages(sessionId).some((row) => !superseded.has(row.executionId))) {
      resumeCancelled = true;
      reopenLatestCancelled = true;
    }
  }
  return { stageReply, sessionStatus, resumeCancelled, reopenLatestCancelled, cancelledReplyStage };
}

/**
 * Prepared start (preflight, activate) or the prepared-session rejection. `rejected` is a final
 * result when preflight fails; otherwise `sessionStatus` is the status the run continues with.
 */
async function startOrRejectPrepared(
  workspace: string,
  request: ExecuteRequest,
  registry: ClientRegistry,
  sessionId: string,
  sessionStatus: string,
): Promise<{ rejected: ExecuteResult | null; sessionStatus: string }> {
  if (request.startPrepared) {
    if (sessionStatus !== 'prepared') {
      const hint =
        sessionStatus === 'active'
          ? `Session ${sessionId} is active. Resume with: migent session continue ${sessionId}`
          : `Session ${sessionId} is ${sessionStatus || 'unknown'}. migent session run --session only starts a prepared session.`;
      throw new ConfigurationError(hint);
    }
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
  sessionId: string,
  stageId: string | null,
  opened: { sessionStatus: string; stageReply: PendingStageReply | null; cancelledReplyStage: boolean },
): readonly { stageId: string; executionId: string }[] | null {
  const { stageReply } = opened;
  const blockedReply = stageReply !== null && store.blockedStages(sessionId).some((row) => row.stageId === stageReply.stageId);
  if (opened.cancelledReplyStage || (opened.sessionStatus !== 'blocked' && !blockedReply)) return null;
  const resumed = store.resumeBlockedSession(
    sessionId,
    stageReply?.stageId ?? stageId,
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
  held: HeldSession,
  registry: ClientRegistry,
  replyText: string | null,
  stageId: string | null,
): Promise<ExecuteResult | { sessionId: string; workflow: WorkflowDocument }> {
  if (replyText !== null) throw new ConfigurationError('--reply requires a blocked session.');
  if (request.refreshWorkflow) {
    throw new ConfigurationError('--refresh-workflow requires an existing session.');
  }
  if (!request.workflowId) throw new ConfigurationError('Creating a session requires a workflow.');
  const workflow = loadNamedWorkflow(workspace, request.workflowId);
  resolvePriorSessionId(workspace, workflow, request.priorSessionId);
  if (stageId !== null) requireEligibleStage(workflow, [], 'active', stageId);
  if (request.preflight) {
    // Argument errors come before the doctor checks.
    if (request.task) assertSingleLineTask(request.task);
    if (!(await request.preflight({ workflowId: request.workflowId, sessionId: null }))) return preflightFailed('');
  }
  const sessionId = createWorkflowSession(workspace, workflow.id, request.task, request.priorSessionId, registry);
  held.acquire(workspace, sessionId);
  log(`session_id: ${sessionId}`);
  return { sessionId, workflow };
}

/** Frozen workflow load, then the revision reset and failed-resume marking the request asked for. */
function prepareSessionWorkflow(
  workspace: string,
  request: ExecuteRequest,
  store: SessionStore,
  sessionId: string,
  stageId: string | null,
  opened: WorkflowDocument | null,
  workflowId: string,
): WorkflowDocument {
  let workflow = opened;
  const frozenDocument = loadFrozenWorkflow(path.join(workspace, '.migent', 'sessions', sessionId));
  if (frozenDocument) workflow = frozenDocument;
  else if (workflow === null) workflow = loadNamedWorkflow(workspace, workflowId);
  if (request.resetRevisions) {
    store.reapOrphanedExecutions(sessionId, 'raise');
    const snapshots = store.executionSnapshots(sessionId);
    const status = store.readSessionStatus(sessionId);
    const current = text(status.status);
    if (current === 'cancelled') {
      store.resetRevisionCounts(sessionId, snapshots);
    } else if (isWorkflowV2(workflow)) {
      // The reset is what lifts the cap, so the cap must not hide the stage continue is about to allow.
      const openBaselines: Record<string, number> = {};
      for (const stageId of Object.keys(workflow.stages)) openBaselines[stageId] = Number.MAX_SAFE_INTEGER;
      const startable = schedulableStageIds(
        workflow,
        snapshots,
        current,
        openBaselines,
        blockResumes(workspace, sessionId),
        new Set(),
      );
      if (startable.length > 0) store.resetRevisionCounts(sessionId, snapshots);
    } else {
      const selected = selectedStage(workflow, snapshots, current, blockResumes(workspace, sessionId));
      if (selected instanceof NextStage) store.resetRevisionCounts(sessionId, snapshots);
    }
  }
  if (request.continueFailed) store.markFailedResumes(sessionId, stageId);
  return workflow;
}
