import { readFileSync } from 'node:fs';
import path from 'node:path';

import { RoleRunResult, RoleRunResults } from '@nodeint/migent-contracts';
import { AgentToolRunner, ensureRoleSessionFreeze, type RunResult, withRolePluginScope } from '@nodeint/migent-engine';
import { CancellationRequested, ConfigurationError, legacyClientOf, log, resolveRoleTarget, type StageTarget } from '@nodeint/migent-kernel';
import { createAgentSession, type HumanInput, isSessionLockLost, repairSessionUnlocked, requireAgentSession, SessionLock, SessionStore, stringOptions } from '@nodeint/migent-session';
import { type OptionValues } from 'commander';

import { clientRegistry, parseOptions, withPlugins } from '../client.js';
import { printAgent, printError, printNotice, printReplyCommand,printResumeCommand } from '../display.js';
import { writeJson } from '../emit.js';
import { EXIT_CANCELLED,EXIT_CONFIG, EXIT_QUESTION, EXIT_VERIFY } from '../exits.js';
import { cliHooks } from '../hooks.js';
import { requireCurrentSchema } from '../migrate.js';
import { bindCancellationSignals } from '../signals.js';
import { optionalText, stringList } from '../text.js';
import { findWorkspace, invocationCwdPath, resolvePrompt } from '../workspace.js';
import { continueState, continueTurn } from './agent-continue.js';
import { answersInput, freshRolePrompt, gateRole, judgeRoleCancelled, recordAnswer, resumeSource, rolePrompt, roleResumeExpired, runFreshAttempt } from './agent-resume.js';

const CLIENT_MAPPING = 'claude→claude-code, codex→codex, grok→grok, agy→agy, opencode→opencode';

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
  const runner = args.runner ?? cliHooks.runner ?? withPlugins(new AgentToolRunner(clientRegistry()));
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
  target: StageTarget;
  runner: AgentToolRunner;
  lock: SessionLock;
}): Promise<number> {
  const { workspace, sessionId, createdSession, args, target, runner, lock } = context;
  const resume = context.createdSession
    ? { cancelled: false, executionId: null }
    : resumeState(workspace, sessionId);
  // The role freeze exists before the first execution, whichever entry point starts it.
  ensureRoleSessionFreeze({ workspace, sessionId }, runner, target);
  printProfileNotice(args.role, target);
  const outcome = await runScoped({ lock, workspace, sessionId, runner, started: createdSession }, async () => {
    const scope = { role: args.role, runner, profile: target };
    if (resume.cancelled) return continueCancelledExecutions(workspace, sessionId, scope);
    // The answer is recorded before the gate, so an `ask` stop keeps it for the decision.
    const { text: input, human } = dispatchInput(workspace, sessionId, args);
    const gateScope = { workspace, sessionId, role: args.role, runner, profile: target };
    const gated = await gateRole(gateScope, resume.executionId);
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

/** Runs a role body under the cancellation guard and the plugin scope of its session. */
function runScoped<T>(
  session: { lock: SessionLock; workspace: string; sessionId: string; runner: AgentToolRunner; started?: boolean },
  body: () => Promise<T>,
): Promise<T | number> {
  const { lock, workspace, sessionId, runner, started = false } = session;
  return guardRoleRun(lock, sessionId, () => withRolePluginScope({ workspace, sessionId, started }, runner, body));
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
  if (latest === null) {
    // A role session that crashed before its freeze records it here, then reports the missing execution.
    const runner = args.runner ?? cliHooks.runner ?? withPlugins(new AgentToolRunner(clientRegistry()));
    ensureRoleSessionFreeze(
      { workspace, sessionId: args.sessionId },
      runner,
      resolveRoleTarget(workspace, state.role, { registry: runner.registry }),
    );
    throw new ConfigurationError(`Session ${args.sessionId} has no execution.`);
  }
  const profile = executionProfile(latest.directory, latest.executionId);
  const { role } = state;
  printProfileNotice(role, profile);
  const runner = args.runner ?? cliHooks.runner ?? withPlugins(new AgentToolRunner(clientRegistry()));
  return runScoped({ lock, workspace, sessionId: args.sessionId, runner }, async () => {
    if (state.sessionStatus === 'cancelled') {
      return await runCancelledRole(workspace, args.sessionId, { role, profile, runner, asJson: false });
    }
    // The answer is recorded before the gate, so an `ask` stop leaves it saved and the decision consumes it once.
    const recordedAnswer = recordAnswer(store, { sessionId: args.sessionId, state, explicitReply: args.reply });
    const gateScope = { workspace, sessionId: args.sessionId, role, runner, profile };
    const gated = await gateRole(gateScope, resumeSource(state, latest));
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
      resumeSkipped: gated.skipped,
    });
    printAgent({ ...result }, { role: role, client: profile.client, model: profile.model }, workspace);
    return finishRole(args.sessionId, roleExitCode(result.outcome_status));
  });
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
  const gateScope = { workspace, sessionId, role, runner, profile };
  const verdicts = await judgeRoleCancelled(gateScope, store.reopenableCancelled(sessionId));
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
