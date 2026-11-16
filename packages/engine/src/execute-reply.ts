/** Resolves the reply an execute run sends: its target stage, recorded-reply recovery, and cancelled-stage reopen. */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ConfigurationError } from '@nodeint/migent-kernel';
import { type HumanInput, type QuestionAnswerRecord, SessionStore } from '@nodeint/migent-session';
import { isRecord } from '@nodeint/migent-workflow';

import { PendingStageReply } from './dispatch.js';

export function verifyOnlyExecution(workspace: string, sessionId: string, executionId: string): boolean {
  const context = new SessionStore(workspace).executionContext(sessionId, executionId);
  if (context === null) return false;
  const metadata = JSON.parse(readFileSync(path.join(context.directory, 'execution.json'), 'utf8')) as unknown;
  return isRecord(metadata) && metadata.kind === 'verify';
}

/** What the reply step decides before the session starts or resumes. */
export interface ResolvedReply {
  stageReply: PendingStageReply | null;
  sessionStatus: string;
  resumeCancelled: boolean;
  reopenLatestCancelled: boolean;
  // A cancelled-stage reply never resumes blocked siblings; they keep their blockers.
  cancelledReplyStage: boolean;
}

/** Empty-reply check, reply target resolution, pending reply recovery, and pending cancelled reopen. */
export function resolveStageReply(
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

export const UNCHANGED_REPLY = {
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
