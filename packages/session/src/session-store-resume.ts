import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { } from '@nodeint/migent-kernel';
import type { } from '@nodeint/migent-kernel';
import { type PendingResumeStop, writeJsonAtomic } from '@nodeint/migent-kernel';
import { ConfigurationError } from '@nodeint/migent-kernel';
import { type ExecutionSnapshot } from '@nodeint/migent-kernel';
import { EXECUTIONS_DIRNAME, utcNow } from '@nodeint/migent-kernel';
import { acceptsBlockedResume, answerQuestions, BLOCKED_RESUME_FROM, formatQuestionAnswers, type Question, resolutionFrom, storedQuestions } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';

import { readPendingResumes } from './resume-pending.js';
import { appendLifecycleEvent, CANCELLED_REPLY, readParsedEvents } from './session-events.js';
import { commitFoldedStatus } from './session-fold.js';
import { blockedExecutions, statusExecutionsFromSnapshots } from './session-ledger.js';
import { assertSessionLockHeld } from './session-lock.js';
import { SessionStoreCore } from './session-store-core.js';
import { AgentSessionRecord, type ExecutionContext } from './session-store-types.js';
import { asInt, compareSortKey, latestExecutionPerStage } from './session-store-util.js';
import { readJsonObject, textField } from './session-store-util.js';
/** The record of a guarded resume. `policy` and `estimate` are free-form facts for the log and the metrics. */
export interface ResumeExpiredRecord {
  stageId: string;
  sourceExecutionId: string;
  action: 'ask' | 'fresh' | 'resume';
  origin: 'human' | 'stage' | 'policy' | 'default';
  policy: string | null;
  estimate: Record<string, unknown>;
}

export interface ResumeDecisionRecord {
  stageId: string;
  sourceExecutionId: string;
  /** `superseded` is internal: `session complete` closes the decision without choosing. */
  choice: 'resume' | 'fresh' | 'superseded';
  origin: 'human';
}

/** Who wrote a cancelled reply: a human, or Migent's own cut-off text. Events from Migent 0.7 and earlier have none. */
export type CancelledReplyOrigin = 'human' | 'cut_off';

/** A saved answer: the text sent, its structured records, and the execution that asked. */
export interface QuestionAnswerRecord {
  formatted: string;
  /** The raw text the human typed. */
  input: string;
  answers: Record<string, unknown>[];
  target: string;
}

interface CancelledRow {
  context: ExecutionContext;
  metadata: Record<string, unknown>;
  order: number;
}

export class SessionStoreResume extends SessionStoreCore {
  /** Latest blocked execution of each stage, in resume order. */
  public blockedStages(sessionId: string): { executionId: string; stageId: string }[] {
    return this.blockedStageRows(sessionId).map((row) => ({
      executionId: row.executionId,
      stageId: row.stageId,
    }));
  }

  /** Latest cancelled execution of each stage, in execution order. */
  public cancelledStages(sessionId: string): { executionId: string; stageId: string }[] {
    const latest = new Map<string, ExecutionSnapshot>();
    for (const row of this.executionSnapshots(sessionId)) {
      if (row.status === 'skipped') continue;
      const prev = latest.get(row.stageId);
      if (prev === undefined || row.executionOrder > prev.executionOrder) latest.set(row.stageId, row);
    }
    return [...latest.values()]
      .filter((row) => row.status === 'cancelled')
      .sort((left, right) => left.executionOrder - right.executionOrder)
      .map((row) => ({ executionId: row.executionId, stageId: row.stageId }));
  }

  /** Cancelled executions that a reply replaced. They are never reopened in place. */
  public supersededExecutionIds(sessionId: string): Set<string> {
    const ids = new Set<string>();
    for (const event of readParsedEvents(path.join(this.sessionsDirectory, sessionId, 'events.jsonl'))) {
      if (event.event === 'session.active' && event.data.from === CANCELLED_REPLY && event.executionId) ids.add(event.executionId);
    }
    return ids;
  }

  /**
   * Record a reply that supersedes a cancelled stage execution. The execution stays cancelled;
   * the reply is dispatched as a new execution that continues its conversation.
   */
  public supersedeCancelled(
    sessionId: string,
    stageId: string,
    reply: { text: string; origin: CancelledReplyOrigin },
  ): void {
    const directory = path.join(this.sessionsDirectory, sessionId);
    assertSessionLockHeld(directory);
    const target = this.cancelledStages(sessionId).find((row) => row.stageId === stageId);
    if (!target) throw new ConfigurationError(`Stage ${stageId} has no cancelled execution.`);
    if (!reply.text.trim()) throw new ConfigurationError('--reply is empty.');
    // Persist the reply before dispatch so an interrupted dispatch can be recovered.
    appendLifecycleEvent(directory, {
      event: 'session.active', timestamp: utcNow(), executionId: target.executionId, stageId: stageId || null,
      data: { from: CANCELLED_REPLY, reply: reply.text, origin: reply.origin },
    });
    this.rewriteManifestStatus(directory, 'running');
    commitFoldedStatus(this.workspace, directory);
  }

  /** A recorded reply whose superseded execution is still the latest of its stage, so it was not dispatched yet. */
  public pendingCancelledReply(
    sessionId: string,
    stageId: string | null = null,
  ): { executionId: string; stageId: string; reply: string; origin: CancelledReplyOrigin | 'unknown' } | null {
    const events = readParsedEvents(path.join(this.sessionsDirectory, sessionId, 'events.jsonl'));
    for (const row of this.cancelledStages(sessionId)) {
      if (stageId !== null && row.stageId !== stageId) continue;
      const event = [...events].reverse().find((item) =>
        item.event === 'session.active' && item.executionId === row.executionId && item.data.from === CANCELLED_REPLY,
      );
      if (typeof event?.data.reply === 'string') {
        const { origin } = event.data;
        return { ...row, reply: event.data.reply, origin: origin === 'human' || origin === 'cut_off' ? origin : 'unknown' };
      }
    }
    return null;
  }

  /** Questions are execution outcomes; the recipient is configured by the stage. */
  public questionStages(
    sessionId: string,
  ): { executionId: string; stageId: string; question: string; questions: Question[] }[] {
    const latest = new Map<string, ExecutionSnapshot>();
    for (const row of this.executionSnapshots(sessionId)) {
      const prev = latest.get(row.stageId);
      if (prev === undefined || row.executionOrder > prev.executionOrder) latest.set(row.stageId, row);
    }
    return [...latest.values()]
      .filter((row) => row.outcomeStatus === 'question' && row.status !== 'running')
      .map((row) => {
        const metadata = readJsonObject(path.join(
          this.sessionsDirectory, sessionId, EXECUTIONS_DIRNAME, row.executionId, 'execution.json',
        ));
        const outcome = isRecord(metadata.outcome) ? metadata.outcome : {};
        return { executionId: row.executionId, stageId: row.stageId, question: String(outcome.question ?? ''), questions: storedQuestions(outcome) };
      });
  }

  /** A reply unlocks only its selected question. No automatic resume without a reply. */
  public resumeQuestion(sessionId: string, stageId: string, reply: string): QuestionAnswerRecord {
    const directory = path.join(this.sessionsDirectory, sessionId);
    assertSessionLockHeld(directory);
    const target = this.questionStages(sessionId).find((row) => row.stageId === stageId);
    if (!target) throw new ConfigurationError(`Stage ${stageId} has no pending question.`);
    if (!reply.trim()) throw new ConfigurationError('--reply is empty.');
    const answers = answerQuestions(target.questions, reply);
    const formatted = formatQuestionAnswers(target.questions, answers);
    // Persist the answer before unlocking dispatch, including if dispatch fails before creating an execution.
    appendLifecycleEvent(directory, {
      event: 'session.active', timestamp: utcNow(), executionId: target.executionId, stageId,
      data: { from: resolutionFrom('question'), reply: formatted, answers, input: reply },
    });
    commitFoldedStatus(this.workspace, directory);
    const records = answers as unknown as Record<string, unknown>[];
    return { formatted, input: reply, answers: records, target: target.executionId };
  }

  /**
   * Record that a resume was guarded: the prompt cache may have expired. With `ask` the session stops for a decision
   * on the target stage; the caller holds the session lock. The status is re-folded.
   */
  public recordResumeExpired(sessionId: string, record: ResumeExpiredRecord): void {
    const directory = path.join(this.sessionsDirectory, sessionId);
    assertSessionLockHeld(directory);
    appendLifecycleEvent(directory, {
      event: 'resume.expired',
      timestamp: utcNow(),
      stageId: record.stageId,
      data: {
        stage_id: record.stageId,
        source_execution_id: record.sourceExecutionId,
        action: record.action,
        origin: record.origin,
        policy: record.policy,
        estimate: record.estimate,
      },
    });
    commitFoldedStatus(this.workspace, directory);
  }

  /** Record a decision for a pending resume, then re-fold. Idempotent for a pair with no pending stop. */
  public recordResumeDecision(sessionId: string, record: ResumeDecisionRecord): void {
    const directory = path.join(this.sessionsDirectory, sessionId);
    assertSessionLockHeld(directory);
    appendLifecycleEvent(directory, {
      event: 'resume.decided',
      timestamp: utcNow(),
      stageId: record.stageId,
      data: {
        stage_id: record.stageId,
        source_execution_id: record.sourceExecutionId,
        choice: record.choice,
        origin: record.origin,
      },
    });
    commitFoldedStatus(this.workspace, directory);
  }

  /** The resume decisions the session waits for, from its events. */
  public pendingResumes(sessionId: string): PendingResumeStop[] {
    return readPendingResumes(path.join(this.sessionsDirectory, sessionId));
  }

  /** The saved answer to this execution's questions, as `resumeQuestion` returned it. */
  public questionAnswer(sessionId: string, executionId: string): QuestionAnswerRecord | null {
    const events = readParsedEvents(path.join(this.sessionsDirectory, sessionId, 'events.jsonl'));
    const event = events.reverse().find((row) =>
      row.event === 'session.active' && row.executionId === executionId && row.data.from === resolutionFrom('question'),
    );
    if (typeof event?.data.reply !== 'string') return null;
    const answers = Array.isArray(event.data.answers) ? event.data.answers.filter(isRecord) : [];
    const input = typeof event.data.input === 'string' ? event.data.input : event.data.reply;
    return { formatted: event.data.reply, input, answers, target: executionId };
  }

  private blockedResumeTargets(
    sessionId: string,
    stageId: string | null,
  ): { executionId: string; stageId: string; blocker: string | null }[] {
    const blocked = this.blockedStageRows(sessionId);
    if (blocked.length === 0) {
      throw new ConfigurationError(`Session ${sessionId} is blocked without an execution.`);
    }
    if (stageId === null) return blocked;
    const targets = blocked.filter((row) => row.stageId === stageId);
    if (targets.length === 0) {
      const names = blocked.map((row) => row.stageId).join(', ');
      throw new ConfigurationError(`Stage ${stageId} is not blocked. Blocked stages: ${names}.`);
    }
    return targets;
  }

  /** Rewrite the legacy manifest and commit the fold; the session must come out active. */
  private commitResumed(sessionId: string, sessionDirectory: string): void {
    this.rewriteManifestStatus(sessionDirectory, 'running');
    const folded = commitFoldedStatus(this.workspace, sessionDirectory);
    if (folded.status !== 'active') {
      throw new ConfigurationError(`Session ${sessionId} stayed ${String(folded.status)} after resume.`);
    }
  }

  /**
   * Record that continue is running blocked stages again. The caller holds the session lock.
   * `stageId` resumes that stage only. Other blocked stages stay blocked.
   */
  public resumeBlockedSession(
    sessionId: string,
    stageId: string | null = null,
    reply: string | null = null,
  ): { executionId: string; stageId: string }[] {
    const sessionDirectory = path.join(this.sessionsDirectory, sessionId);
    assertSessionLockHeld(sessionDirectory);
    const status = this.readSessionStatus(sessionId);
    if (!acceptsBlockedResume(String(status.status))) {
      throw new ConfigurationError(`Session ${sessionId} is ${String(status.status)}, not blocked.`);
    }
    const targets = this.blockedResumeTargets(sessionId, stageId);
    const timestamp = utcNow();
    for (const target of targets) {
      const data: Record<string, unknown> = { from: BLOCKED_RESUME_FROM };
      const blocker = target.blocker ?? (targets.length === 1 ? textField(status.blocker) : null);
      if (blocker) data.blocker = blocker;
      if (reply !== null && stageId !== null && target.stageId === stageId) data.reply = reply;
      appendLifecycleEvent(sessionDirectory, {
        event: 'session.active',
        timestamp,
        executionId: target.executionId,
        stageId: target.stageId || null,
        data,
      });
    }
    this.commitResumed(sessionId, sessionDirectory);
    return targets.map((target) => ({ executionId: target.executionId, stageId: target.stageId }));
  }

  /**
   * Append `session.active` with `data.from: failed` for each failed non-verify stage.
   * Does not rewrite the manifest or commit the fold. The session need not be active.
   */
  public markFailedResumes(sessionId: string, stageId: string | null = null): void {
    const sessionDirectory = path.join(this.sessionsDirectory, sessionId);
    assertSessionLockHeld(sessionDirectory);
    const latest = new Map<string, ExecutionSnapshot>();
    for (const snapshot of this.executionSnapshots(sessionId)) {
      const current = latest.get(snapshot.stageId);
      if (current === undefined || snapshot.executionOrder > current.executionOrder) {
        latest.set(snapshot.stageId, snapshot);
      }
    }
    const timestamp = utcNow();
    for (const snapshot of latest.values()) {
      if (stageId !== null && snapshot.stageId !== stageId) continue;
      if (snapshot.status !== 'failed') continue;
      if (snapshot.failureReason === 'verify_exhausted' || snapshot.failureReason === 'verify_failed') continue;
      appendLifecycleEvent(sessionDirectory, {
        event: 'session.active',
        timestamp,
        executionId: snapshot.executionId,
        stageId: snapshot.stageId || null,
        data: { from: 'failed' },
      });
    }
  }

  protected blockedStageRows(
    sessionId: string,
  ): { executionId: string; stageId: string; blocker: string | null }[] {
    const status = this.readSessionStatus(sessionId);
    const workflow = this.loadWorkflow(status);
    return blockedExecutions(
      statusExecutionsFromSnapshots(this.snapshotList(sessionId)),
      status,
      workflow,
    ).map((row) => ({
      executionId: row.executionId,
      stageId: row.stageId,
      blocker: this.executionBlocker(sessionId, row.executionId),
    }));
  }

  /** Cancelled, not superseded executions to reopen, in execution order. */
  private cancelledRows(sessionId: string, latestPerStage: boolean): CancelledRow[] {
    const rows = this.executionContexts(sessionId).map((context) => {
      const metadata = readJsonObject(path.join(context.directory, 'execution.json'));
      return { context, metadata, order: asInt(metadata.execution_order) };
    });
    const selected = latestPerStage ? latestExecutionPerStage(rows) : rows;
    const superseded = this.supersededExecutionIds(sessionId);
    return selected
      .filter((item) => item.metadata.status === 'cancelled' && !superseded.has(item.context.executionId))
      .sort((left, right) =>
        compareSortKey([left.order, left.context.executionId], [right.order, right.context.executionId]),
      );
  }

  /** Every agent conversation is loaded before any execution is reopened, so a missing one changes nothing. */
  private resumableRecords(sessionId: string, cancelled: readonly CancelledRow[]): Map<string, AgentSessionRecord> {
    const records = new Map<string, AgentSessionRecord>();
    for (const item of cancelled) {
      if (item.metadata.kind === 'verify') continue;
      if (!existsSync(item.context.conversationReadPath)) {
        throw new ConfigurationError(`Execution ${item.context.executionId} has no conversation to resume.`);
      }
      const client = this.executionClient(sessionId, item.context.executionId);
      const raw: unknown = JSON.parse(readFileSync(item.context.conversationReadPath, 'utf8'));
      const model = typeof item.metadata.model === 'string' ? item.metadata.model : '';
      const record = AgentSessionRecord.fromJson(raw, { client, model, workspace: this.workspace });
      record.client = client;
      records.set(item.context.executionId, record);
    }
    return records;
  }

  private reopenCancelledRow(
    item: CancelledRow,
    reopen: { sessionDirectory: string; records: ReadonlyMap<string, AgentSessionRecord>; timestamp: string },
  ): { executionId: string; stageId: string } {
    const { sessionDirectory, records, timestamp } = reopen;
    const {metadata, context} = item;
    metadata.status = 'running';
    metadata.completed_at = null;
    writeJsonAtomic(path.join(context.directory, 'execution.json'), metadata);
    if (metadata.kind !== 'verify') {
      const record = records.get(context.executionId);
      if (record === undefined) throw new Error(`No agent session record for execution ${context.executionId}`);
      record.status = 'running';
      this.save(record, context);
    }
    const stageId = typeof metadata.stage_id === 'string' ? metadata.stage_id : '';
    appendLifecycleEvent(sessionDirectory, {
      event: 'execution.running',
      timestamp,
      executionId: context.executionId,
      stageId: stageId || null,
      data: {
        outcome: null,
        failure_reason: null,
        error: null,
        session_status: 'active',
      },
    });
    appendLifecycleEvent(sessionDirectory, {
      event: 'session.active',
      timestamp,
      executionId: context.executionId,
      stageId: stageId || null,
      data: { from: 'cancelled' },
    });
    return { executionId: context.executionId, stageId };
  }

  /**
   * Reopen every cancelled execution in place. The caller holds the session lock.
   * Execution ids and stage attempts stay the same.
   */
  public reopenCancelledExecutions(
    sessionId: string,
    latestPerStage = false,
    scope: { skip?: ReadonlySet<string>; onlyStage?: string | null } = {},
  ): { executionId: string; stageId: string }[] {
    const skip = scope.skip ?? new Set<string>();
    const onlyStage = scope.onlyStage ?? null;
    const sessionDirectory = path.join(this.sessionsDirectory, sessionId);
    assertSessionLockHeld(sessionDirectory);
    const status = this.readSessionStatus(sessionId);
    // A blocked session is not cancelled. Continue still reopens each stage's latest cancelled execution.
    // With a skip set the resume gate has already judged the batch, and what it recorded moved the status on.
    if (!latestPerStage && skip.size === 0 && onlyStage === null && status.status !== 'cancelled') {
      throw new ConfigurationError(`Session ${sessionId} is ${String(status.status)}, not cancelled.`);
    }
    const found = this.cancelledRows(sessionId, latestPerStage)
      .filter((item) => onlyStage === null || item.metadata.stage_id === onlyStage);
    if (found.length === 0) {
      // The gate may have judged every cancelled execution already; a fresh verdict supersedes its row.
      if (latestPerStage || skip.size > 0 || onlyStage !== null) return [];
      throw new ConfigurationError(`Session ${sessionId} is cancelled without an execution.`);
    }
    // An execution the resume gate held back stays cancelled and untouched; the rest are validated together.
    const cancelled = found.filter((item) => !skip.has(item.context.executionId));
    const records = this.resumableRecords(sessionId, cancelled);
    const timestamp = utcNow();
    const reopened = cancelled.map((item) => this.reopenCancelledRow(item, { sessionDirectory, records, timestamp }));
    if (reopened.length > 0) this.commitResumed(sessionId, sessionDirectory);
    return reopened;
  }

  /** The cancelled executions a reopen would act on: the same selection as `reopenCancelledExecutions`. */
  public reopenableCancelled(
    sessionId: string,
    latestPerStage = false,
    onlyStage: string | null = null,
  ): { executionId: string; stageId: string }[] {
    return this.cancelledRows(sessionId, latestPerStage)
      .filter((item) => onlyStage === null || item.metadata.stage_id === onlyStage)
      .map((item) => ({
      executionId: item.context.executionId,
      stageId: typeof item.metadata.stage_id === 'string' ? item.metadata.stage_id : '',
    }));
  }

  public resetRevisionCounts(sessionId: string, snapshots: readonly ExecutionSnapshot[]): void {
    const sessionDirectory = path.join(this.sessionsDirectory, sessionId);
    assertSessionLockHeld(sessionDirectory);
    const counts: Record<string, number> = {};
    for (const snapshot of snapshots) {
      if (snapshot.status === 'completed' && snapshot.outcomeStatus === 'complete') {
        counts[snapshot.stageId] = (counts[snapshot.stageId] ?? 0) + 1;
      }
    }
    appendLifecycleEvent(sessionDirectory, {
      event: 'revisions.reset',
      timestamp: utcNow(),
      data: { baselines: counts },
    });
    commitFoldedStatus(this.workspace, sessionDirectory);
  }
}
