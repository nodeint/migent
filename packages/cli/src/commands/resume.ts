import path from 'node:path';

import { SessionResumeOutput } from '@nodeint/migent-contracts';
import { ConfigurationError, log } from '@nodeint/migent-kernel';
import { isSessionLockLost, SessionLock, SessionLockHeldError, SessionStore } from '@nodeint/migent-session';
import type { OptionValues } from 'commander';

import { printError } from '../display.js';
import { writeJson } from '../emit.js';
import { EXIT_CONFIG } from '../exits.js';
import { requireCurrentSchema } from '../migrate.js';
import { optionalText } from '../text.js';
import { findWorkspace, invocationCwdPath } from '../workspace.js';
import { isAgentSession } from './agent.js';
import { continueSession } from './session-run.js';

const CHOICES = ['resume', 'fresh'] as const;
type Choice = (typeof CHOICES)[number];

const isChoice = (value: string): value is Choice => (CHOICES as readonly string[]).includes(value);

interface Decision {
  stageId: string;
  sourceExecutionId: string;
  choice: Choice;
}

/**
 * Checks everything before anything is recorded: the choice, the session state, the stage, and that exactly one
 * decision is meant. Every failure is a configuration error (exit 2).
 */
function pickDecision(
  store: SessionStore,
  sessionId: string,
  input: { choice: string; stage: string | null },
): Decision {
  if (!isChoice(input.choice)) throw new ConfigurationError(`The choice must be one of: ${CHOICES.join(', ')}.`);
  const status = store.readSessionStatus(sessionId);
  if (Object.keys(status).length === 0) throw new ConfigurationError(`Session not found: ${sessionId}.`);
  const state = typeof status.status === 'string' ? status.status : '';
  if (state === 'completed' || state === 'prepared') {
    throw new ConfigurationError(`Session ${sessionId} is ${state}; it has no resume decision to make.`);
  }
  const pending = store.pendingResumes(sessionId);
  const known = pending.map((stop) => stop.stageId);
  if (input.stage !== null && !known.includes(input.stage)) {
    const hint = known.length > 0 ? ` Waiting stages: ${known.join(', ')}.` : '';
    throw new ConfigurationError(`Stage ${input.stage} has no pending resume decision in session ${sessionId}.${hint}`);
  }
  const wanted = pending.filter((stop) => input.stage === null || stop.stageId === input.stage);
  if (wanted.length === 0) throw new ConfigurationError(`Session ${sessionId} has no pending resume decision.`);
  if (wanted.length > 1) {
    throw new ConfigurationError(`Several resume decisions wait: ${known.join(', ')}. Pass --stage <stage>.`);
  }
  return { stageId: wanted[0].stageId, sourceExecutionId: wanted[0].sourceExecutionId, choice: input.choice };
}

/** Records the decision under the session lock and re-folds the status. */
function recordDecision(workspace: string, sessionId: string, decision: Decision): string {
  const directory = path.join(workspace, '.migent', 'sessions', sessionId);
  const lock = SessionLock.acquire(directory);
  try {
    const store = new SessionStore(workspace);
    store.recordResumeDecision(sessionId, { ...decision, origin: 'human' });
    const {status} = store.readSessionStatus(sessionId);
    return typeof status === 'string' ? status : '';
  } finally {
    lock.release();
  }
}

function printDecisionJson(
  store: SessionStore,
  recorded: { sessionId: string; decision: Decision; status: string; continued: boolean; exitCode: number },
): void {
  const { sessionId, decision, status, continued, exitCode } = recorded;
  const remaining = store.pendingResumes(sessionId).map((stop) => ({
    stage_id: stop.stageId,
    source_execution_id: stop.sourceExecutionId,
  }));
  writeJson(SessionResumeOutput, {
    session_id: sessionId,
    stage_id: decision.stageId,
    source_execution_id: decision.sourceExecutionId,
    choice: decision.choice,
    continued,
    status,
    exit_code: exitCode,
    remaining,
  });
}

/**
 * `session resume <session> resume|fresh`: decide a resume that stopped because the prompt cache expired, then
 * continue the session. Only the named stage is decided; every other stop stays as it is.
 */
export async function resumeSession(
  sessionId: string,
  choice: string,
  options: OptionValues,
): Promise<number> {
  const workspace = findWorkspace(invocationCwdPath());
  requireCurrentSchema(workspace);
  const recorded = decide(workspace, sessionId, { choice, stage: optionalText(options.stage) });
  if (typeof recorded === 'number') return recorded;
  const after = { recorded, json: options.json === true, continued: options.continue !== false };
  return continueDecision(workspace, sessionId, after);
}

/** Records the decision, or returns the exit code of the configuration error that stopped it. */
function decide(
  workspace: string,
  sessionId: string,
  input: { choice: string; stage: string | null },
): { decision: Decision; status: string } | number {
  try {
    const decision = pickDecision(new SessionStore(workspace), sessionId, input);
    return { decision, status: recordDecision(workspace, sessionId, decision) };
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof SessionLockHeldError || isSessionLockLost(error)) {
      printError(error.message);
      return EXIT_CONFIG;
    }
    throw error;
  }
}

/** After the decision: stop (`--no-continue`) or run the decided stage, printing the JSON document when asked. */
async function continueDecision(
  workspace: string,
  sessionId: string,
  after: { recorded: { decision: Decision; status: string }; json: boolean; continued: boolean },
): Promise<number> {
  const { recorded, json, continued } = after;
  const { decision } = recorded;
  if (!continued) {
    if (json) {
      const result = { sessionId, decision, status: recorded.status, continued, exitCode: 0 };
      printDecisionJson(new SessionStore(workspace), result);
    }
    return 0;
  }
  const how = decision.choice === 'fresh' ? 'start a fresh conversation' : 'resume its conversation';
  log(`Recorded: ${decision.stageId} will ${how}.`);
  const run = (): number | Promise<number> => isAgentSession(workspace, sessionId)
    ? continueSession(sessionId, {})
    : continueSession(sessionId, { stage: decision.stageId, resumeTarget: true });
  if (!json) return run();
  const exitCode = await quietly(run);
  const store = new SessionStore(workspace);
  const {status} = store.readSessionStatus(sessionId);
  printDecisionJson(store, {
    sessionId, decision, status: typeof status === 'string' ? status : recorded.status, continued, exitCode,
  });
  return exitCode;
}

/** Runs the continuation with its human-readable output on stderr, so stdout carries only the JSON document. */
async function quietly(run: () => number | Promise<number>): Promise<number> {
  const write = process.stdout.write.bind(process.stdout);
  const toStderr = (chunk: string | Uint8Array): boolean => process.stderr.write(chunk);
  process.stdout.write = toStderr as typeof write;
  try {
    return await run();
  } finally {
    process.stdout.write = write;
  }
}
