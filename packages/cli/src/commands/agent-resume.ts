import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { type AgentToolRunner, gateRoleResume, type RolePolicy, type RunResult, selectRolePolicy, storedRolePolicy } from '@nodeint/migent-engine';
import { buildStageReplyPrompt, loadRoleResponsibilities, loadWorkspaceConfig, prependRoleInstructions } from '@nodeint/migent-kernel';
import { type HumanInput, type QuestionAnswerRecord, SessionStore, watchSnapshot } from '@nodeint/migent-session';

import { formatResumeDecision, printNotice } from '../display.js';
import { EXIT_RESUME_EXPIRED } from '../exits.js';
import type { AgentProfile, ContinueState } from './agent.js';

export type RoleGate = { verdict: 'resume' | 'fresh' | 'ask'; stamp: RolePolicy | null; skipped: { source_execution_id: string; reason: 'expired' } | null };

/** The resume gate for a role session, before `runner.run`. A session created without a policy is never gated. */
export function gateRole(
  scope: { workspace: string; sessionId: string; role: string; runner: AgentToolRunner },
  sourceExecutionId: string | null,
): RoleGate {
  if (sourceExecutionId === null) return { verdict: 'resume', stamp: null, skipped: null };
  const { workspace, sessionId, role, runner } = scope;
  const gated = gateRoleResume({
    store: new SessionStore(workspace), workspace, sessionId, role, sourceExecutionId, clients: runner.registry,
  });
  const skipped = gated.verdict === 'fresh' ? { source_execution_id: sourceExecutionId, reason: 'expired' as const } : null;
  return { ...gated, skipped };
}

/** A role resume that stopped for a decision: nothing ran, so print where the decision is made and exit 10. */
export function roleResumeExpired(workspace: string, sessionId: string): number {
  const decisions = watchSnapshot(path.join(workspace, '.migent', 'sessions', sessionId)).resume_decisions;
  const pending = Array.isArray(decisions) ? (decisions as Record<string, unknown>[]) : [];
  if (pending.length === 0) {
    printNotice(`Session ${sessionId} waits for a resume decision. Decide with: migent session resume ${sessionId} resume|fresh`);
  }
  for (const decision of pending) printNotice(formatResumeDecision(decision, sessionId));
  return EXIT_RESUME_EXPIRED;
}

/** A new role session selects its policy once, from the config and the resolved client and model. */
export function newRolePolicy(
  workspace: string,
  session: { createdSession: boolean; role: string; target: AgentProfile },
): ReturnType<typeof selectRolePolicy> {
  if (!session.createdSession) return null;
  const { client, model } = session.target;
  return selectRolePolicy(workspace, { role: session.role, client, model });
}

/** A free-text reply the human typed, which the agent receives unchanged. */
export function replyInput(text: string, respondsToExecutionId: string): HumanInput {
  return { kind: 'reply', sent: text, input: text, respondsToExecutionId };
}

/** An answer to a question: the text the agent receives, the human's own text, and the structured records. */
export function answersInput(saved: QuestionAnswerRecord): HumanInput {
  return { kind: 'answers', sent: saved.formatted, input: saved.input, answers: saved.answers, respondsToExecutionId: saved.target };
}

/** Saves the human's answer to a pending question once, and returns its formatted text; null when there is none. */
export function recordAnswer(
  store: SessionStore,
  turn: { sessionId: string; state: ContinueState; explicitReply: string | null },
): QuestionAnswerRecord | null {
  const { sessionId, state, explicitReply } = turn;
  if (explicitReply === null || state.pending === undefined || state.cancelledReply !== null) return null;
  return store.resumeQuestion(sessionId, state.role, explicitReply);
}

/** The execution a continue would resume: a replied cancelled turn's own, else the latest. */
export function resumeSource(state: ContinueState, latest: { executionId: string }): string {
  return state.cancelledReply?.executionId ?? latest.executionId;
}

export interface RoleCancelledVerdicts {
  readonly skip: ReadonlySet<string>;
  readonly fresh: readonly { executionId: string; text: string }[];
  /** At least one execution waits for a decision. */
  readonly asked: boolean;
}

const CUT_OFF = 'The previous turn was cut off before it finished. Continue.';

/** The turn that was cut off, as the new conversation's carried input; the original task is added separately. */
function cutOffText(scope: { workspace: string; sessionId: string }, executionId: string): string {
  const store = new SessionStore(scope.workspace);
  if (store.firstExecution(scope.sessionId)?.executionId === executionId) return CUT_OFF;
  const context = store.executionContext(scope.sessionId, executionId);
  const text = context === null ? '' : sentInput(context.conversationReadPath, 'last');
  return text === '' ? CUT_OFF : `${CUT_OFF}\n\nThe cut-off turn was:\n\n${text}`;
}

/** One verdict per cancelled execution, decided before any of them is reopened. */
export function judgeRoleCancelled(
  scope: { workspace: string; sessionId: string; role: string; runner: AgentToolRunner },
  cancelled: readonly { executionId: string }[],
): RoleCancelledVerdicts {
  const skip = new Set<string>();
  const fresh: { executionId: string; text: string }[] = [];
  let asked = false;
  for (const item of cancelled) {
    const { verdict } = gateRole(scope, item.executionId);
    if (verdict === 'resume') continue;
    skip.add(item.executionId);
    if (verdict === 'ask') asked = true;
    else fresh.push({ executionId: item.executionId, text: cutOffText(scope, item.executionId) });
  }
  return { skip, fresh, asked };
}

/** `fresh` for a cancelled role turn: the source stays cancelled and a new execution runs the role again. */
export async function runFreshAttempt(
  scope: { workspace: string; sessionId: string; role: string; runner: AgentToolRunner; profile: AgentProfile },
  item: { executionId: string; text: string },
): Promise<RunResult> {
  const { workspace, sessionId, role, runner, profile } = scope;
  const store = new SessionStore(workspace);
  store.supersedeCancelled(sessionId, role, { text: item.text, origin: 'cut_off' });
  const stamp = sourceStamp(workspace, sessionId, item.executionId);
  return runner.run({
    client: profile.client,
    model: profile.model,
    options: { ...profile.options },
    prompt: freshRolePrompt({ workspace, sessionId, role }, buildStageReplyPrompt(item.text, { interrupted: true })),
    turn: 'reply',
    workspace,
    sessionId,
    resumeExecutionId: null,
    stageId: role,
    resumePolicy: stamp,
    resumeSkipped: { source_execution_id: item.executionId, reason: 'expired' },
  });
}

export function rolePrompt(workspace: string, role: string, text: string): string {
  return prependRoleInstructions(
    loadRoleResponsibilities(loadWorkspaceConfig(workspace), role),
    text,
  );
}


/**
 * The prompt of a fresh role conversation: the original turn (role instructions and task, as the session's first
 * execution was sent) followed by the carried input, so a new conversation loses nothing the old one knew.
 */
export function freshRolePrompt(
  scope: { workspace: string; sessionId: string; role: string },
  carried: string,
): string {
  const { workspace, sessionId, role } = scope;
  const store = new SessionStore(workspace);
  const first = store.firstExecution(sessionId);
  const original = first === null ? '' : sentInput(first.conversationReadPath, 'first');
  const task = original === '' ? taskOf(store, sessionId) : original;
  const body = task === '' ? carried : `${task}\n\n---\n\nContinuing this task in a new conversation. Input since the first turn:\n\n${carried}`;
  return original === '' ? rolePrompt(workspace, role, body) : body;
}

/**
 * The first (the task) or last (the turn just sent) user message of an execution's conversation, as the role
 * sent it. Unlike `prompt.md` it carries no provider envelope (response contract, handoff file), so only the
 * current execution gives those instructions.
 */
function sentInput(conversationFile: string, which: 'first' | 'last'): string {
  if (!existsSync(conversationFile)) return '';
  const raw = JSON.parse(readFileSync(conversationFile, 'utf8')) as unknown;
  const history = Array.isArray(raw) ? raw : ((raw as { history?: unknown }).history ?? []);
  if (!Array.isArray(history)) return '';
  const users = history.filter((entry: { role?: unknown }) => entry?.role === 'user') as { content?: unknown }[];
  const entry = which === 'first' ? users[0] : users.at(-1);
  return typeof entry?.content === 'string' ? entry.content.trim() : '';
}

function taskOf(store: SessionStore, sessionId: string): string {
  const {task} = store.readSessionStatus(sessionId);
  return typeof task === 'string' ? task : '';
}

/** The policy stamped on a source execution, so a fresh attempt inherits it. */
function sourceStamp(workspace: string, sessionId: string, executionId: string): RolePolicy | null {
  const context = new SessionStore(workspace).executionContext(sessionId, executionId);
  return context === null ? null : (storedRolePolicy(context.directory)?.stamp ?? null);
}
