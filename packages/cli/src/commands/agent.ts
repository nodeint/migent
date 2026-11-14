import { readFileSync } from 'node:fs';
import path from 'node:path';

import { RoleRunResult, RoleRunResults } from '@nodeint/migent-contracts';
import { AgentToolRunner, type RunResult } from '@nodeint/migent-engine';
import { buildStageReplyPrompt, CancellationRequested, ConfigurationError, legacyClientOf, log, resolveRoleTarget, type TurnKind } from '@nodeint/migent-kernel';
import { createAgentSession, type HumanInput, isSessionLockLost, type QuestionAnswerRecord, repairSessionUnlocked, requireAgentSession, SessionLock, SessionStore, stringOptions } from '@nodeint/migent-session';
import { type OptionValues } from 'commander';

import { clientRegistry, parseOptions } from '../client.js';
import { printAgent, printError, printNotice, printReplyCommand,printResumeCommand } from '../display.js';
import { writeJson } from '../emit.js';
import { EXIT_CANCELLED,EXIT_CONFIG, EXIT_QUESTION, EXIT_VERIFY } from '../exits.js';
import { cliHooks } from '../hooks.js';
import { requireCurrentSchema } from '../migrate.js';
import { bindCancellationSignals } from '../signals.js';
import { optionalText, stringList } from '../text.js';
import { findWorkspace, invocationCwdPath, resolvePrompt } from '../workspace.js';
import { answersInput, freshRolePrompt, gateRole, judgeRoleCancelled, newRolePolicy, recordAnswer, replyInput, resumeSource, rolePrompt, roleResumeExpired, runFreshAttempt } from './agent-resume.js';

export const CLIENT_MAPPING = 'claude→claude-code, codex→codex, grok→grok, agy→agy, opencode→opencode';

export type AgentProfile = { client: string; model: string; options: Record<string, string> };

type DispatchArgs = {
  role: string;
  task?: string | null;
  sessionId?: string | null;
  client?: string | null;
  model?: string | null;
  options?: readonly string[];
  prompt?: string | null;
  promptFile?: string | null;
  promptStdin?: boolean;
  asJson?: boolean;
  runner?: AgentToolRunner | null;
};

export async function dispatchAgent(workspace: string, args: DispatchArgs): Promise<number> {
  requireCurrentSchema(workspace);
  const runner = args.runner ?? cliHooks.runner ?? new AgentToolRunner(clientRegistry());
  const parsed = parseOptions(args.options ?? []);
  const override = {
    client: args.client ?? null,
    model: args.model ?? null,
    options: Object.keys(parsed).length > 0 ? parsed : null,
  };
  const target = resolveRoleTarget(workspace, args.role, { override, registry: runner.registry });
  const [sessionId, createdSession] = resolveSession(
    workspace,
    { sessionId: args.sessionId ?? null, role: args.role, task: args.task ?? null },
  );
  if (createdSession) log(`session_id: ${sessionId}`);
  return withSessionLock(workspace, sessionId, (lock) =>
    dispatchLocked({ workspace, sessionId, createdSession, args, target, runner, lock }),
  );
}

async function dispatchLocked(context: {
  workspace: string;
  sessionId: string;
  createdSession: boolean;
  args: DispatchArgs;
  target: AgentProfile;
  runner: AgentToolRunner;
  lock: SessionLock;
}): Promise<number> {
  const { workspace, sessionId, createdSession, args, target, runner, lock } = context;
  const resume = context.createdSession
    ? { cancelled: false, executionId: null }
    : resumeState(workspace, sessionId);
  printProfileNotice(args.role, target);
  const outcome = await guardRoleRun(lock, sessionId, async () => {
    const scope = { role: args.role, runner, profile: target };
    if (resume.cancelled) return continueCancelledExecutions(workspace, sessionId, scope);
    // The answer is recorded before the gate, so an `ask` stop keeps it for the decision.
    const { text: input, human } = dispatchInput(workspace, sessionId, args);
    const gated = gateRole({ workspace, sessionId, role: args.role, runner }, resume.executionId);
    if (gated.verdict === 'ask') return roleResumeExpired(workspace, sessionId);
    const prompt = gated.verdict === 'fresh'
      ? freshRolePrompt({ workspace, sessionId, role: args.role }, input)
      : rolePrompt(workspace, args.role, input);
    const result = await runner.run({
      client: target.client,
      model: target.model,
      options: { ...target.options },
      prompt,
      humanInput: human,
      workspace,
      sessionId,
      resumeExecutionId: gated.verdict === 'fresh' ? null : resume.executionId,
      stageId: args.role,
      resumePolicy: gated.stamp ?? newRolePolicy(workspace, { createdSession, role: args.role, target }),
      resumeSkipped: gated.skipped,
    });
    return [result];
  });
  if (typeof outcome === 'number') return outcome;
  return reportRoleResults({ workspace, sessionId }, outcome, {
    role: args.role,
    profile: target,
    asJson: args.asJson ?? false,
  });
}

function resumeState(
  workspace: string,
  sessionId: string,
): { cancelled: boolean; executionId: string | null } {
  repairSessionUnlocked(workspace, sessionId);
  const store = new SessionStore(workspace);
  if (store.readSessionStatus(sessionId).status === 'cancelled') return { cancelled: true, executionId: null };
  const previous = store.latestExecution(sessionId);
  return { cancelled: false, executionId: previous === null ? null : previous.executionId };
}

function dispatchInput(
  workspace: string,
  sessionId: string,
  args: DispatchArgs,
): { text: string; human: HumanInput | null } {
  const input = resolvePrompt({
    prompt: args.prompt ?? null,
    promptFile: args.promptFile ?? null,
    promptStdin: args.promptStdin ?? false,
  });
  const store = new SessionStore(workspace);
  if (!store.questionStages(sessionId).some((row) => row.stageId === args.role)) return { text: input, human: null };
  const saved = store.resumeQuestion(sessionId, args.role, input);
  return { text: saved.formatted, human: answersInput(saved) };
}

async function withSessionLock(
  workspace: string,
  sessionId: string,
  body: (lock: SessionLock) => Promise<number>,
): Promise<number> {
  let lock: SessionLock;
  try {
    lock = SessionLock.acquire(path.join(workspace, '.migent', 'sessions', sessionId));
  } catch (error) {
    if (error instanceof Error) {
      printError(error.message);
      return EXIT_CONFIG;
    }
    throw error;
  }
  try {
    return await body(lock);
  } catch (error) {
    if (isSessionLockLost(error)) {
      printError(error.message);
      return EXIT_CONFIG;
    }
    throw error;
  } finally {
    lock.release();
  }
}

async function guardRoleRun<T>(
  lock: SessionLock,
  sessionId: string,
  body: () => Promise<T>,
): Promise<T | number> {
  const unbind = bindCancellationSignals(lock);
  try {
    return await body();
  } catch (error) {
    if (error instanceof CancellationRequested) {
      log(error.message);
      return finishRole(sessionId, EXIT_CANCELLED);
    }
    if (error instanceof ConfigurationError) throw error;
    if (error instanceof Error) {
      printError(error.message);
      return EXIT_CONFIG;
    }
    throw error;
  } finally {
    unbind();
  }
}

function printProfileNotice(role: string, profile: AgentProfile): void {
  const optionLabel =
    Object.entries(profile.options)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ') || 'default';
  printNotice(`agent ${role} · ${profile.client}/${profile.model} (${optionLabel}).`);
}

export async function continueAgent(
  workspace: string,
  args: { sessionId: string; reply: string | null; runner?: AgentToolRunner | null },
): Promise<number> {
  requireCurrentSchema(workspace);
  requireAgentSession(workspace, args.sessionId);
  return withSessionLock(workspace, args.sessionId, (lock) => continueLocked(workspace, args, lock));
}

export type ContinueState = {
  role: string;
  sessionStatus: string;
  cancelledReply: { executionId: string; text: string; human: HumanInput | null } | null;
  pending: { executionId: string } | undefined;
  reply: string | null;
  /** The saved answer when the reply answers a question that was answered before this run. */
  savedAnswer: QuestionAnswerRecord | null;
};

async function continueLocked(
  workspace: string,
  args: { sessionId: string; reply: string | null; runner?: AgentToolRunner | null },
  lock: SessionLock,
): Promise<number> {
  repairSessionUnlocked(workspace, args.sessionId);
  const store = new SessionStore(workspace);
  const state = continueState(store, args.sessionId, args.reply);
  if (state.sessionStatus === 'completed' && args.reply === null) {
    printNotice(`Session ${args.sessionId} is completed.`);
    return 0;
  }
  if (state.sessionStatus === 'question' && state.reply === null) {
    printNotice(`Session ${args.sessionId} has a pending question. Continue with --reply.`);
    return EXIT_QUESTION;
  }
  const latest = store.latestExecution(args.sessionId);
  if (latest === null) throw new ConfigurationError(`Session ${args.sessionId} has no execution.`);
  const profile = executionProfile(latest.directory, latest.executionId);
  const { role } = state;
  printProfileNotice(role, profile);
  return guardRoleRun(lock, args.sessionId, async () => {
    const runner = args.runner ?? cliHooks.runner ?? new AgentToolRunner(clientRegistry());
    if (state.sessionStatus === 'cancelled') {
      return await runCancelledRole(workspace, args.sessionId, { role, profile, runner, asJson: false });
    }
    // The answer is recorded before the gate, so an `ask` stop leaves it saved and the decision consumes it once.
    const recordedAnswer = recordAnswer(store, { sessionId: args.sessionId, state, explicitReply: args.reply });
    const gated = gateRole({ workspace, sessionId: args.sessionId, role, runner }, resumeSource(state, latest));
    if (gated.verdict === 'ask') return roleResumeExpired(workspace, args.sessionId);
    const next = continueTurn(
      { workspace, store, sessionId: args.sessionId, explicitReply: args.reply, recordedAnswer },
      state,
      latest,
    );
    const result = await runner.run({
      client: profile.client,
      model: profile.model,
      options: { ...profile.options },
      prompt: gated.verdict === 'fresh' ? freshRolePrompt({ workspace, sessionId: args.sessionId, role }, next.prompt) : next.prompt,
      turn: next.turn,
      humanInput: next.human,
      workspace,
      sessionId: args.sessionId,
      resumeExecutionId: gated.verdict === 'fresh' ? null : next.resumeId,
      stageId: role,
      resumePolicy: gated.stamp,
      resumeSkipped: gated.skipped,
    });
    printAgent({ ...result }, { role: role, client: profile.client, model: profile.model }, workspace);
    return finishRole(args.sessionId, roleExitCode(result.outcome_status));
  });
}

function continueState(store: SessionStore, sessionId: string, explicitReply: string | null): ContinueState {
  const status = store.readSessionStatus(sessionId);
  let sessionStatus = typeof status.status === 'string' ? status.status : '';
  const role = typeof status.role === 'string' ? status.role : '';
  if (role === '') throw new ConfigurationError(`Session ${sessionId} has no role.`);
  // A reply to a stopped turn supersedes it: the cancelled execution stays cancelled
  // and the reply runs as a new turn.
  let cancelledReply: ContinueState['cancelledReply'] = null;
  const pendingCancelled = store.pendingCancelledReply(sessionId, role);
  if (explicitReply !== null && (sessionStatus === 'cancelled' || pendingCancelled !== null)) {
    const target = store.cancelledStages(sessionId).find((row) => row.stageId === role);
    if (!target) throw new ConfigurationError(`Session ${sessionId} has no cancelled execution to reply to.`);
    store.supersedeCancelled(sessionId, role, { text: explicitReply, origin: 'human' });
    cancelledReply = {
      executionId: target.executionId, text: explicitReply, human: replyInput(explicitReply, target.executionId),
    };
  } else if (pendingCancelled !== null) {
    // Cut-off text and replies saved before origin existed are re-sent but are not human input.
    const human = pendingCancelled.origin === 'human' ? replyInput(pendingCancelled.reply, pendingCancelled.executionId) : null;
    cancelledReply = { executionId: pendingCancelled.executionId, text: pendingCancelled.reply, human };
  }
  if (cancelledReply !== null) sessionStatus = 'active';
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

function continueTurn(
  context: {
    workspace: string;
    store: SessionStore;
    sessionId: string;
    explicitReply: string | null;
    /** The saved answer, when `recordAnswer` already saved it. */
    recordedAnswer?: QuestionAnswerRecord | null;
  },
  state: ContinueState,
  latest: { executionId: string; directory: string },
): { prompt: string; turn: TurnKind | null; resumeId: string; human: HumanInput | null } {
  const { workspace, store, sessionId } = context;
  const { role, sessionStatus, cancelledReply, pending, reply } = state;
  if (cancelledReply !== null) {
    log(`session ${sessionId} was stopped during ${cancelledReply.executionId}. Sending your reply to ${role}.`);
    const prompt = rolePrompt(workspace, role, buildStageReplyPrompt(cancelledReply.text, { interrupted: true }));
    return { prompt, turn: 'reply', resumeId: cancelledReply.executionId, human: cancelledReply.human };
  }
  if (reply !== null) {
    if (sessionStatus === 'blocked') resumeBlockedWithReply(context, role, reply);
    const answers = pending !== undefined && context.explicitReply !== null;
    const saved = answers ? (context.recordedAnswer ?? store.resumeQuestion(sessionId, role, reply)) : null;
    // A saved answer recovered with no explicit reply is a reply of the human's too.
    const answered = saved ?? state.savedAnswer;
    const text = saved?.formatted ?? reply;
    const prompt = rolePrompt(workspace, role, buildStageReplyPrompt(text, { answers }));
    const human = answered ? answersInput(answered) : replyInput(reply, latest.executionId);
    return { prompt, turn: answers ? 'answers' : 'reply', resumeId: latest.executionId, human };
  }
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
  latest: { executionId: string; directory: string },
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

/**
 * Gates each cancelled execution before any is reopened (D12), from the `completed_at` it was given when it was
 * cancelled. `resume` reopens in place, `fresh` leaves it cancelled and starts a new attempt with the cut-off turn, and
 * `ask` leaves it untouched: the run ends with exit 10 once the others have finished.
 */
async function continueCancelledExecutions(
  workspace: string,
  sessionId: string,
  scope: { role: string; runner: AgentToolRunner; profile: AgentProfile },
): Promise<RunResult[] | number> {
  const { role, runner, profile } = scope;
  const store = new SessionStore(workspace);
  const verdicts = judgeRoleCancelled({ workspace, sessionId, role, runner }, store.reopenableCancelled(sessionId));
  const reopened = store.reopenCancelledExecutions(sessionId, false, { skip: verdicts.skip });
  for (const item of reopened) {
    log(`session ${sessionId} was cancelled during ${item.executionId}. Resuming that execution.`);
  }
  const fresh = verdicts.fresh.map((item) => runFreshAttempt({ workspace, sessionId, role, runner, profile }, item));
  const settled = await Promise.allSettled([
    ...reopened.map((item) => runner.continueCancelled(workspace, sessionId, item.executionId)),
    ...fresh,
  ]);
  const rejected = settled.find((item) => item.status === 'rejected');
  if (rejected && rejected.status === 'rejected') throw rejected.reason;
  const continued = settled.flatMap((item) => (item.status === 'fulfilled' ? [item.value] : []));
  if (verdicts.asked) return roleResumeExpired(workspace, sessionId);
  if (continued.length === 0) {
    throw new ConfigurationError(`Session ${sessionId} is cancelled without an execution.`);
  }
  return continued;
}

function reportRoleResults(
  session: { workspace: string; sessionId: string },
  finished: RunResult[],
  spec: { role: string; profile: AgentProfile; asJson: boolean },
): number {
  const { workspace, sessionId } = session;
  const { role, profile, asJson } = spec;
  const meta = { role: role, client: profile.client, model: profile.model };
  if (finished.length === 1) {
    const [result] = finished;
    if (result === undefined) throw new Error('Agent run produced no result.');
    if (asJson) writeJson(RoleRunResult, result);
    else printAgent({ ...result }, meta, workspace);
    return finishRole(sessionId, roleExitCode(result.outcome_status));
  }
  if (asJson) writeJson(RoleRunResults, finished);
  else {
    for (const item of finished) printAgent({ ...item }, meta, workspace);
  }
  if (finished.some((item) => item.failure_reason === 'verify_exhausted')) return finishRole(sessionId, EXIT_VERIFY);
  return finishRole(sessionId, finished.every((item) => item.outcome_status === 'complete') ? 0 : 1);
}

async function runCancelledRole(
  workspace: string,
  sessionId: string,
  spec: { role: string; profile: AgentProfile; runner: AgentToolRunner; asJson: boolean },
): Promise<number> {
  const finished = await continueCancelledExecutions(workspace, sessionId, spec);
  return typeof finished === 'number' ? finished : reportRoleResults({ workspace, sessionId }, finished, spec);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finishRole(sessionId: string, code: number): number {
  if (code === EXIT_QUESTION) printReplyCommand(sessionId);
  if (code === 1 || code === EXIT_VERIFY || code === EXIT_CANCELLED) printResumeCommand(sessionId);
  if (code === EXIT_CANCELLED) printReplyCommand(sessionId);
  return code;
}

function executionProfile(directory: string, executionId: string): AgentProfile {
  const raw = JSON.parse(readFileSync(path.join(directory, 'execution.json'), 'utf8')) as unknown;
  let client: string | null = null;
  if (isRecord(raw)) {
    client = typeof raw.client === 'string' && raw.client !== ''
      ? raw.client
      : legacyClientOf(typeof raw.provider === 'string' ? raw.provider : null);
  }
  if (!isRecord(raw) || client === null || typeof raw.model !== 'string' || raw.model === '') {
    throw new ConfigurationError(`Execution ${executionId} has no client.`);
  }
  return { client, model: raw.model, options: stringOptions(raw.options) };
}

function roleExitCode(status: unknown): number {
  if (status === 'complete') return 0;
  return status === 'question' ? EXIT_QUESTION : 1;
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

function resolveSession(
  workspace: string,
  requested: { sessionId: string | null; role: string; task: string | null },
): [string, boolean] {
  const { sessionId, role, task } = requested;
  if (sessionId !== null && typeof task === 'string' && task.trim() !== '') {
    throw new ConfigurationError('--task cannot be combined with a session.');
  }
  if (sessionId !== null) {
    requireAgentSession(workspace, sessionId);
    return [sessionId, false];
  }
  const taskSummary = (task ?? role).trim();
  return [createAgentSession(workspace, role, taskSummary), true];
}

export function isAgentSession(workspace: string, sessionId: string): boolean {
  try {
    requireAgentSession(workspace, sessionId);
    return true;
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    if (error.message === `Session not found: ${sessionId}.`) return false;
    if (error.message === `Session ${sessionId} was not created by agent.`) return false;
    if (error.message.startsWith('Session status file is corrupt:')) return false;
    throw error;
  }
}

export function continueRoleSession(
  session: { workspace: string; sessionId: string },
  options: OptionValues,
  readReply: (options: OptionValues) => string | null | 'invalid',
): number | Promise<number> {
  const { workspace, sessionId } = session;
  const flags: string[] = [];
  if (options.once === true) flags.push('--once');
  if (options.stage !== undefined) flags.push('--stage');
  if (options.prior !== undefined) flags.push('--prior');
  if (options.maxDispatches !== undefined) flags.push('--max-dispatches');
  if (options.unlimitedDispatches === true) flags.push('--unlimited-dispatches');
  if (options.progress === true) flags.push('--progress');
  if (options.verbose === true) flags.push('--verbose');
  if (options.refreshWorkflow === true) flags.push('--refresh-workflow');
  if (flags.length > 0) {
    printError(`Session ${sessionId} is a role session. Omit ${flags.join(', ')}.`);
    return EXIT_CONFIG;
  }
  const reply = readReply(options);
  if (reply === 'invalid') return EXIT_CONFIG;
  return continueAgent(workspace, { sessionId, reply });
}

export async function runAgent(options: OptionValues, sessionId: string | null): Promise<number> {
  const role = optionalText(options.role);
  if (role === null) {
    printError('Pass --role.');
    return EXIT_CONFIG;
  }
  if (options.provider !== undefined) {
    printError(`--provider has been removed; use --client <id> (${CLIENT_MAPPING}).`);
    return EXIT_CONFIG;
  }
  const client = optionalText(options.client);
  const model = optionalText(options.model);
  if ((client === null) !== (model === null)) {
    printError('Pass both --client and --model, or omit both.');
    return EXIT_CONFIG;
  }
  const prompt = optionalText(options.prompt);
  const promptFile = optionalText(options.file);
  const promptStdin = options.stdin === true;
  const selected = Number(prompt !== null) + Number(promptFile !== null) + Number(promptStdin);
  if (selected !== 1) {
    printError('Pass one of --prompt, --file, or --stdin.');
    return EXIT_CONFIG;
  }
  return dispatchAgent(findWorkspace(invocationCwdPath()), {
    role,
    task: optionalText(options.task),
    sessionId,
    client,
    model,
    options: stringList(options.option),
    prompt,
    promptFile,
    promptStdin,
    asJson: options.json === true,
  });
}
