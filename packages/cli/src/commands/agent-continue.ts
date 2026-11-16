import { readFileSync } from 'node:fs';
import path from 'node:path';

import { buildStageReplyPrompt, ConfigurationError, log, type TurnKind } from '@nodeint/migent-kernel';
import { type HumanInput, type QuestionAnswerRecord, SessionStore } from '@nodeint/migent-session';

import { answersInput, replyInput, rolePrompt } from './agent-resume.js';

export type ContinueState = {
  role: string;
  sessionStatus: string;
  cancelledReply: CancelledReply | null;
  pending: { executionId: string } | undefined;
  reply: string | null;
  /** The saved answer when the reply answers a question that was answered before this run. */
  savedAnswer: QuestionAnswerRecord | null;
};

type CancelledReply = { executionId: string; text: string; human: HumanInput | null };

export type ContinueTurnContext = {
  workspace: string;
  store: SessionStore;
  sessionId: string;
  explicitReply: string | null;
  /** The saved answer, when `recordAnswer` already saved it. */
  recordedAnswer?: QuestionAnswerRecord | null;
};

type LatestExecution = { executionId: string; directory: string };

type ContinueTurn = { prompt: string; turn: TurnKind | null; resumeId: string; human: HumanInput | null };

export function continueState(store: SessionStore, sessionId: string, explicitReply: string | null): ContinueState {
  const status = store.readSessionStatus(sessionId);
  const role = typeof status.role === 'string' ? status.role : '';
  if (role === '') throw new ConfigurationError(`Session ${sessionId} has no role.`);
  const recordedStatus = typeof status.status === 'string' ? status.status : '';
  const cancelledReply = resolveCancelledReply(store, { sessionId, role, explicitReply, recordedStatus });
  const sessionStatus = cancelledReply === null ? recordedStatus : 'active';
  if (sessionStatus === 'completed' && explicitReply === null) {
    return { role, sessionStatus, cancelledReply, pending: undefined, reply: null, savedAnswer: null };
  }
  const pending = cancelledReply === null
    ? store.questionStages(sessionId).find((row) => row.stageId === role)
    : undefined;
  const savedAnswer = explicitReply === null && pending ? store.questionAnswer(sessionId, pending.executionId) : null;
  const reply = explicitReply ?? savedAnswer?.formatted ?? null;
  return { role, sessionStatus, cancelledReply, pending, reply, savedAnswer };
}

/**
 * A reply to a stopped turn supersedes it: the cancelled execution stays cancelled and the reply runs as a new turn.
 */
function resolveCancelledReply(
  store: SessionStore,
  turn: { sessionId: string; role: string; explicitReply: string | null; recordedStatus: string },
): CancelledReply | null {
  const { sessionId, role, explicitReply } = turn;
  const pendingCancelled = store.pendingCancelledReply(sessionId, role);
  if (explicitReply !== null && (turn.recordedStatus === 'cancelled' || pendingCancelled !== null)) {
    const target = store.cancelledStages(sessionId).find((row) => row.stageId === role);
    if (!target) throw new ConfigurationError(`Session ${sessionId} has no cancelled execution to reply to.`);
    store.supersedeCancelled(sessionId, role, { text: explicitReply, origin: 'human' });
    const human = replyInput(explicitReply, target.executionId);
    return { executionId: target.executionId, text: explicitReply, human };
  }
  if (pendingCancelled === null) return null;
  // Cut-off text and replies saved before origin existed are re-sent but are not human input.
  const human = pendingCancelled.origin === 'human'
    ? replyInput(pendingCancelled.reply, pendingCancelled.executionId)
    : null;
  return { executionId: pendingCancelled.executionId, text: pendingCancelled.reply, human };
}

export function continueTurn(
  context: ContinueTurnContext,
  state: ContinueState,
  latest: LatestExecution,
): ContinueTurn {
  const { workspace, sessionId } = context;
  const { role, sessionStatus, cancelledReply, reply } = state;
  if (cancelledReply !== null) {
    log(`session ${sessionId} was stopped during ${cancelledReply.executionId}. Sending your reply to ${role}.`);
    const prompt = rolePrompt(workspace, role, buildStageReplyPrompt(cancelledReply.text, { interrupted: true }));
    return { prompt, turn: 'reply', resumeId: cancelledReply.executionId, human: cancelledReply.human };
  }
  if (reply !== null) return replyTurn(context, state, { reply, executionId: latest.executionId });
  if (sessionStatus === 'blocked') {
    return { prompt: blockedPrompt(context, role, latest), turn: 'continue', resumeId: latest.executionId, human: null };
  }
  if (sessionStatus === 'active') {
    log(`session ${sessionId} is active. Resuming ${role} with its last prompt.`);
    const prompt = lastUserPrompt(workspace, sessionId, latest.executionId);
    return { prompt, turn: null, resumeId: latest.executionId, human: null };
  }
  throw new ConfigurationError(`Session ${sessionId} is ${sessionStatus || 'unknown'}.`);
}

function replyTurn(
  context: ContinueTurnContext,
  state: ContinueState,
  turn: { reply: string; executionId: string },
): ContinueTurn {
  const { workspace, store, sessionId } = context;
  const { role } = state;
  const { reply } = turn;
  if (state.sessionStatus === 'blocked') resumeBlockedWithReply(context, role, reply);
  const answers = state.pending !== undefined && context.explicitReply !== null;
  const saved = answers ? (context.recordedAnswer ?? store.resumeQuestion(sessionId, role, reply)) : null;
  // A saved answer recovered with no explicit reply is a reply of the human's too.
  const answered = saved ?? state.savedAnswer;
  const text = saved?.formatted ?? reply;
  const prompt = rolePrompt(workspace, role, buildStageReplyPrompt(text, { answers }));
  const human = answered ? answersInput(answered) : replyInput(reply, turn.executionId);
  return { prompt, turn: answers ? 'answers' : 'reply', resumeId: turn.executionId, human };
}

/** A reply to a blocked turn reactivates the session first, so the reply turn can be created and recorded. */
function resumeBlockedWithReply(
  context: { store: SessionStore; sessionId: string },
  role: string,
  reply: string,
): void {
  for (const item of context.store.resumeBlockedSession(context.sessionId, role, reply)) {
    log(`session ${context.sessionId} was blocked by ${item.executionId}. Sending your reply to ${role}.`);
  }
}

function blockedPrompt(
  context: { workspace: string; store: SessionStore; sessionId: string },
  role: string,
  latest: LatestExecution,
): string {
  const { workspace, store, sessionId } = context;
  const blocker = executionBlocker(latest.directory);
  const resumed = store.resumeBlockedSession(sessionId);
  for (const item of resumed) {
    log(`session ${sessionId} was blocked by ${item.executionId}. Resuming ${role}.`);
  }
  const lines = ['Previous attempt:', `- execution: ${latest.executionId}`];
  if (blocker) lines.push(`- blocker: ${blocker}`);
  lines.push('That attempt ended blocked. The blocker was handled outside this session. Continue.');
  return rolePrompt(workspace, role, lines.join('\n'));
}

function lastUserPrompt(workspace: string, sessionId: string, executionId: string): string {
  const context = new SessionStore(workspace).executionContext(sessionId, executionId);
  if (context === null) throw new ConfigurationError(`Execution ${executionId} was not found.`);
  const raw = JSON.parse(readFileSync(context.conversationReadPath, 'utf8')) as unknown;
  let history: unknown[] = [];
  if (Array.isArray(raw)) history = raw;
  else if (isRecord(raw) && Array.isArray(raw.history)) history = raw.history;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (isRecord(entry) && entry.role === 'user' && typeof entry.content === 'string' && entry.content !== '') {
      return entry.content;
    }
  }
  throw new ConfigurationError(`Execution ${executionId} has no prompt to resume.`);
}

function executionBlocker(directory: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(directory, 'execution.json'), 'utf8')) as unknown;
    if (!isRecord(raw) || !isRecord(raw.outcome)) return null;
    return typeof raw.outcome.blocker === 'string' && raw.outcome.blocker !== '' ? raw.outcome.blocker : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
