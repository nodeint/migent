import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { AgentToolRunner, DEFAULT_MAX_DISPATCHES, executeNamedWorkflow, type ExecuteResult } from '@nodeint/migent-engine';
import { ConfigurationError, CORRECTION_FAILURE_REASONS,formatDuration, isSessionStop, log } from '@nodeint/migent-kernel';
import { FAILURE_FILENAME, formatNextCommand,publishNextSuggestions, SessionStore, watchSnapshot } from '@nodeint/migent-session';
import { type OptionValues } from 'commander';

import { clientRegistry } from '../client.js';
import { formatQuestion, formatResumeDecision, printError, printReplyCommand, printResumeCommand } from '../display.js';
import { EXIT_BLOCKED, EXIT_CANCELLED, EXIT_CONFIG, EXIT_QUOTA, EXIT_STAGE_FAILED, EXIT_VERIFY, EXIT_VERIFY_FAILED } from '../exits.js';
import { cliHooks } from '../hooks.js';
import { requireCurrentSchema } from '../migrate.js';
import { runPreflight } from '../preflight.js';
import { optionalText, text } from '../text.js';
import { findWorkspace, invocationCwdPath } from '../workspace.js';

export interface ExecuteWorkflowOptions {
  action: string;
  workflowId?: string | null;
  task?: string | null;
  sessionId?: string | null;
  priorSessionId?: string | null;
  maxDispatches?: number | null;
  continueFailed?: boolean;
  stageId?: string | null;
  runner?: AgentToolRunner | null;
  itemProgress?: boolean;
  startPrepared?: boolean;
  refreshWorkflow?: boolean;
  skipPreflight?: boolean;
  reply?: string | null;
  replyStageId?: string | null;
  /** `session resume`: `stageId` is the target of a recorded resume decision; no other cancelled stage is touched. */
  resumeTarget?: boolean;
}

export async function executeWorkflow(workspace: string, options: ExecuteWorkflowOptions): Promise<number> {
  requireCurrentSchema(workspace);
  const once = options.action === 'stage';
  const startPrepared = options.startPrepared === true;
  const sessionId = text(options.sessionId);
  const creating = !startPrepared && (options.action === 'start' || (once && sessionId === null));
  const runner = options.runner ?? cliHooks.runner ?? new AgentToolRunner(clientRegistry());
  runner.itemProgress = options.itemProgress === true;
  const result = await executeNamedWorkflow(
    workspace,
    {
      ...targetRequest(options, { creating, startPrepared, sessionId }),
      ...runRequest(options, once),
      preflight: creating || startPrepared ? preflightHook(workspace, options, runner) : undefined,
    },
    runner,
  );
  printResult(workspace, result);
  printResumeHint(workspace, result);
  return result.code;
}

function targetRequest(
  options: ExecuteWorkflowOptions,
  state: { creating: boolean; startPrepared: boolean; sessionId: string | null },
): {
  workflowId: string | null;
  task: string | null;
  sessionId: string | null;
  priorSessionId: string | null;
  startPrepared: boolean;
} {
  const { creating, startPrepared, sessionId } = state;
  return {
    workflowId: creating || startPrepared ? (options.workflowId ?? null) : null,
    task: creating ? (options.task ?? null) : null,
    sessionId: creating ? null : sessionId,
    priorSessionId: options.priorSessionId ?? null,
    startPrepared,
  };
}

function runRequest(options: ExecuteWorkflowOptions, once: boolean): {
  maxDispatches: number | null;
  continueFailed: boolean;
  stageId: string | null;
  once: boolean;
  resetRevisions: boolean;
  refreshWorkflow: boolean;
  reply: string | null;
  replyStageId: string | null;
  resumeTarget: boolean;
} {
  const maxDispatches = options.maxDispatches === undefined ? DEFAULT_MAX_DISPATCHES : options.maxDispatches;
  return {
    maxDispatches: once ? null : maxDispatches,
    continueFailed: options.continueFailed === true,
    stageId: options.stageId ?? null,
    once,
    resetRevisions: options.action === 'continue',
    refreshWorkflow: options.refreshWorkflow === true,
    reply: options.reply ?? null,
    replyStageId: options.replyStageId ?? null,
    resumeTarget: options.resumeTarget === true,
  };
}

function preflightHook(
  workspace: string,
  options: ExecuteWorkflowOptions,
  runner: AgentToolRunner,
): (target: Parameters<typeof runPreflight>[1]) => Promise<boolean> {
  return async (target) => {
    if (options.skipPreflight === true) {
      process.stderr.write('preflight skipped (--skip-preflight)\n');
      return true;
    }
    return runPreflight(workspace, target, { clients: runner.registry });
  };
}

function printResumeHint(workspace: string, result: ExecuteResult): void {
  if (result.sessionId === '' || result.status === 'completed' || result.stopReason === 'completed') return;
  if (result.stopReason === 'configuration') return;
  const store = new SessionStore(workspace);
  for (const decision of watchSnapshot(path.join(workspace, '.migent', 'sessions', result.sessionId)).resume_decisions as Record<string, unknown>[] | undefined ?? []) {
    log(formatResumeDecision(decision, result.sessionId));
  }
  const questions = store.questionStages(result.sessionId);
  if (questions.length > 0) {
    for (const question of questions) printReplyCommand(result.sessionId, question.stageId);
    if (result.status !== 'blocked') return;
  }
  printResumeCommand(result.sessionId);
  if (isSessionStop(result.status) || result.code === EXIT_CANCELLED) {
    const cancelled = new SessionStore(workspace).cancelledStages(result.sessionId);
    printReplyCommand(result.sessionId, cancelled.length === 1 ? cancelled[0].stageId : undefined);
  }
}

const INSPECT_EXIT_CODES = new Set([EXIT_BLOCKED, EXIT_STAGE_FAILED, EXIT_VERIFY, EXIT_QUOTA]);

function printResult(workspace: string, result: ExecuteResult): void {
  // Printed before the completed branch: a retried attempt can fail and still end in a completed session.
  printFailures(workspace, result);
  if (result.status === 'completed' || result.stopReason === 'completed') printCompleted(workspace, result);
  else printStopped(workspace, result);
}

function printFailures(workspace: string, result: ExecuteResult): void {
  for (const executionId of failedExecutionIds(result)) {
    const failure = `executions/${executionId}/${FAILURE_FILENAME}`;
    if (executionFileExists({ workspace, sessionId: result.sessionId }, executionId, FAILURE_FILENAME)) {
      log(`failure: ${failure}`);
    }
  }
}

function printCompleted(workspace: string, result: ExecuteResult): void {
  const duration = sessionDurationLabel(workspace, result.sessionId);
  log(duration === null ? 'completed' : `completed · ${duration}`);
  for (const filePath of artifactPaths(workspace, result.sessionId, result.outputs)) {
    log(`artifact: ${filePath}`);
  }
  const suggestions = publishNextSuggestions(workspace, result.sessionId);
  if (suggestions.path) log(`next: ${suggestions.path}`);
  for (const next of suggestions.next) log(formatNextCommand(next.argv));
}

function printStopped(workspace: string, result: ExecuteResult): void {
  const questions = result.sessionId === '' ? [] : new SessionStore(workspace).questionStages(result.sessionId);
  if (questions.length > 0) log(`questions: .migent/sessions/${result.sessionId}/questions.json`);
  for (const stage of questions) {
    for (const question of stage.questions) log(formatQuestion({ ...question, stage_id: stage.stageId }));
  }
  if (
    result.latestExecutionId &&
    INSPECT_EXIT_CODES.has(result.code) &&
    executionFileExists({ workspace, sessionId: result.sessionId }, result.latestExecutionId, 'response.md')
  ) {
    log(`response: executions/${result.latestExecutionId}/response.md`);
  }
  if (result.sessionId !== '') for (const line of questionFileFailures(workspace, result.sessionId)) log(line);
  if (result.code === EXIT_VERIFY_FAILED && result.latestExecutionId) {
    log(`verify: executions/${result.latestExecutionId}/turns/01/verify.md`);
  }
}

/**
 * Every execution that ended failed in this run. `latestExecutionId` alone can
 * point at a later sibling when concurrent stages finish in another order.
 */
function failedExecutionIds(result: ExecuteResult): string[] {
  const ids = new Set<string>();
  for (const stage of result.stages) {
    if (stage.execution_status !== 'failed') continue;
    const executionId = stage.execution_id;
    if (typeof executionId === 'string' && executionId !== '') ids.add(executionId);
  }
  if (ids.size === 0 && result.latestExecutionId) ids.add(result.latestExecutionId);
  return [...ids];
}

function executionFileExists(
  session: { workspace: string; sessionId: string },
  executionId: string,
  name: string,
): boolean {
  const { workspace, sessionId } = session;
  if (sessionId === '') return false;
  return existsSync(
    path.join(workspace, '.migent', 'sessions', sessionId, 'executions', executionId, name),
  );
}

/**
 * Diagnostics for stages whose latest execution failed on an unusable question request file.
 * Every stage is checked, so a newer successful sibling does not hide the failure.
 */
function questionFileFailures(workspace: string, sessionId: string): string[] {
  const directory = path.join(workspace, '.migent', 'sessions', sessionId, 'executions');
  let names: string[];
  try {
    names = readdirSync(directory).sort();
  } catch {
    return [];
  }
  const latest = new Map<string, Record<string, unknown>>();
  for (const name of names) {
    try {
      const metadata: unknown = JSON.parse(readFileSync(path.join(directory, name, 'execution.json'), 'utf8'));
      if (isRecord(metadata) && typeof metadata.stage_id === 'string') latest.set(metadata.stage_id, metadata);
    } catch {
      continue;
    }
  }
  const lines: string[] = [];
  for (const [stageId, metadata] of latest) {
    if (typeof metadata.failure_reason === 'string' && CORRECTION_FAILURE_REASONS.includes(metadata.failure_reason) && typeof metadata.error === 'string') {
      lines.push(`stage ${stageId}: ${metadata.error}`);
    }
  }
  return lines;
}

function artifactPaths(workspace: string, sessionId: string, outputs: Record<string, unknown>): string[] {
  if (sessionId === '') return [];
  const sessionDir = path.resolve(workspace, '.migent', 'sessions', sessionId);
  const paths: string[] = [];
  for (const [name, value] of Object.entries(outputs)) {
    const record = isRecord(value) ? value : {};
    const relative = typeof record.path === 'string' && record.path !== '' ? record.path : path.join('outputs', name);
    paths.push(absoluteFromRoot(path.resolve(sessionDir, relative)));
  }
  return paths;
}

function absoluteFromRoot(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function sessionDurationLabel(workspace: string, sessionId: string): string | null {
  if (sessionId === '') return null;
  const executions = path.join(workspace, '.migent', 'sessions', sessionId, 'executions');
  let names: string[];
  try {
    names = readdirSync(executions);
  } catch {
    return null;
  }
  let total = 0;
  let counted = false;
  for (const name of names) {
    const elapsed = executionElapsedMs(path.join(executions, name, 'execution.json'));
    if (elapsed === null) continue;
    total += elapsed;
    counted = true;
  }
  return counted ? formatDuration(total) : null;
}

function executionElapsedMs(filePath: string): number | null {
  try {
    const metadata = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!isRecord(metadata)) return null;
    const started = parsedTime(metadata.created_at);
    if (started === null) return null;
    return (parsedTime(metadata.completed_at) ?? Date.now()) - started;
  } catch {
    return null;
  }
}

function parsedTime(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function runWorkflowCommand(args: {
  workflowId: string | null;
  task: string | null;
  sessionId: string | null;
  prepared: boolean;
  once: boolean;
  options: OptionValues;
  output: { itemProgress: boolean };
}): number | Promise<number> {
  if (rejectOnce(args.options)) return EXIT_CONFIG;
  const {workflowId} = args;
  const task = args.prepared ? null : args.task;
  const sessionId = args.prepared ? args.sessionId : null;
  const stageId = optionalText(args.options.stage);
  if (!args.once && stageId === null) {
    const ceiling = dispatchCeiling(args.options);
    if (typeof ceiling === 'string') return EXIT_CONFIG;
    return executeWorkflow(findWorkspace(invocationCwdPath()), {
      action: 'start',
      workflowId,
      task,
      sessionId,
      startPrepared: args.prepared,
      priorSessionId: optionalText(args.options.prior),
      maxDispatches: ceiling,
      refreshWorkflow: args.options.refreshWorkflow === true,
      skipPreflight: args.options.skipPreflight === true,
      ...args.output,
    });
  }
  return executeWorkflow(findWorkspace(invocationCwdPath()), {
    action: 'stage',
    workflowId,
    task,
    sessionId,
    stageId,
    startPrepared: args.prepared,
    priorSessionId: optionalText(args.options.prior),
    maxDispatches: null,
    refreshWorkflow: args.options.refreshWorkflow === true,
    skipPreflight: args.options.skipPreflight === true,
    ...args.output,
  });
}

export function rejectOnce(options: OptionValues): boolean {
  if (options.once !== true && options.stage === undefined) return false;
  const flag = options.once === true ? '--once' : '--stage';
  if (options.maxDispatches !== undefined) {
    printError(`${flag} cannot be combined with --max-dispatches.`);
    return true;
  }
  if (options.unlimitedDispatches === true) {
    printError(`${flag} cannot be combined with --unlimited-dispatches.`);
    return true;
  }
  return false;
}

export function dispatchCeiling(options: OptionValues): number | null | 'error' {
  const maxDispatches = optionalText(options.maxDispatches);
  const unlimited = options.unlimitedDispatches === true;
  if (unlimited && maxDispatches !== null) {
    printError('--max-dispatches cannot be combined with --unlimited-dispatches.');
    return 'error';
  }
  if (unlimited) return null;
  if (maxDispatches === null) return DEFAULT_MAX_DISPATCHES;
  return integerFlag(maxDispatches, '--max-dispatches');
}

function integerFlag(raw: string, flag: string): number {
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) {
    throw new ConfigurationError(`${flag} must be at least 1.`);
  }
  return Number(raw);
}
