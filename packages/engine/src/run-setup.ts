import { statSync } from 'node:fs';
import path from 'node:path';

import type { CliClient, FailureClassification } from '@nodeint/migent-kernel';
import {
  classifyFailure, ConfigurationError, isShellSignalExitCode, platformHome, VERIFY_EXHAUSTED,
} from '@nodeint/migent-kernel';
import type { TurnKind } from '@nodeint/migent-prompts';
import { type ExecutionContext, loadFrozenWorkflow, type SessionStore } from '@nodeint/migent-session';
import { allStageArtifacts, loadNamedWorkflow, loadStage, type StageSpec } from '@nodeint/migent-workflow';

export function classifyFinishedProcess(
  client: CliClient,
  run: { stdout: string; exitCode: number | null; executorError: string | null },
): FailureClassification | null {
  const { stdout, exitCode, executorError } = run;
  if (exitCode === null) return { kind: 'provider', origin: 'start', message: executorError === null ? '' : executorError };
  const classified = classifyFailure(client, stdout, exitCode);
  // Signal death (negative, or the shell's 128 + signal) is not a normal exit: its reply never counts.
  const signalled = exitCode < 0 || (isShellSignalExitCode(exitCode));
  return classified !== null && signalled ? { ...classified, origin: 'start' } : classified;
}

export interface StageFacts {
  decisionValues: string[];
  ask: NonNullable<StageSpec['ask']> | 'human' | null;
  artifactFiles: ReturnType<typeof allStageArtifacts>;
  artifactName: string | null;
  verifyCommands: string[];
}

export interface RunRequest {
  /** CLI client id, resolved through the runner's registry. */
  client: string;
  model: string;
  prompt: string;
  /** What the prompt is; it picks the closing instruction and is kept for resume. */
  turn?: TurnKind | null;
  workspace: string;
  sessionId?: string | null;
  resumeExecutionId?: string | null;
  stageId?: string;
  stageAttempt?: number | null;
  executionOrder?: number | null;
  options?: Record<string, string> | null;
  /** Called as soon as the execution id exists, before the first await. */
  onExecution?: (executionId: string) => void;
}

export function carryExhaustedArtifact(
  store: SessionStore,
  context: ExecutionContext,
  carry: { resumeExecutionId: string; artifactName: string },
): void {
  const { resumeExecutionId, artifactName } = carry;
  const previous = store
    .executionSnapshots(context.sessionId)
    .find((snapshot) => snapshot.executionId === resumeExecutionId);
  if (previous === undefined || previous.failureReason !== VERIFY_EXHAUSTED) return;
  store.carryVerifyArtifact(previous.artifactDirectory, context, artifactName);
}

/** What a stage says about its decisions, questions, artifacts, and verify list. */
export function stageFacts(stage: StageSpec | null): StageFacts {
  const decisionValues = stage?.decisionValues ?? [];
  const ask = stage?.ask ?? (stage === null ? 'human' : null);
  const artifactFiles = stage === null ? [] : allStageArtifacts(stage);
  const artifactName = artifactFiles[0]?.artifact.file ?? null;
  const verifyCommands = stage?.verify ?? [];
  return { decisionValues, ask, artifactFiles, artifactName, verifyCommands };
}

export function loadRunStage(store: SessionStore, sessionId: string, stageId: string): StageSpec | null {
  const sessionStatus = store.readSessionStatus(sessionId);
  if (sessionStatus.workflow_id === 'agent') return null;
  const frozen = loadFrozenWorkflow(path.join(store.sessionsDirectory, sessionId));
  if (frozen) return frozen.stages[stageId] ?? null;
  const workflowPath = sessionStatus.workflow_path;
  if (typeof workflowPath === 'string') {
    const stage = loadStage(store.workspace, workflowPath, stageId);
    if (stage !== null) return stage;
  }
  const workflowId = sessionStatus.workflow_id;
  if (typeof workflowId !== 'string') return null;
  try {
    return loadNamedWorkflow(store.workspace, workflowId).stages[stageId] ?? null;
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

/** The client, model and options a conversation runs under. */
export interface SessionProfile {
  readonly client: string;
  readonly model: string;
  readonly options: Record<string, string>;
}

export function validateSessionProfile(previous: SessionProfile, requested: SessionProfile): void {
  const { client: previousClient, model: previousModel, options: previousOptions } = previous;
  const { client, model, options } = requested;
  if (
    previousClient !== client ||
    previousModel !== model ||
    !sameOptions(previousOptions, options)
  ) {
    throw new ConfigurationError(
      'Cannot resume an agent session with a different client, model, or options: ' +
        `recorded ${previousClient}/${previousModel}, requested ${client}/${model}. Start a new attempt.`,
    );
  }
}

function sameOptions(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

export function resolveWorkspace(workspace: string): string {
  const expanded = expandHome(workspace);
  const resolved = path.resolve(expanded);
  try {
    if (!statSync(resolved).isDirectory()) throw new Error('missing');
    return resolved;
  } catch (error) {
    if (error instanceof Error && error.message === 'missing') {
      throw new Error(`Workspace does not exist: ${workspace}`, { cause: error });
    }
    if (isMissingPath(error)) throw new Error(`Workspace does not exist: ${workspace}`, { cause: error });
    throw error;
  }
}

/** Leading `~/` of a home-relative path. */
const HOME_PREFIX = '~/';

function expandHome(target: string): string {
  if (target === '~') return platformHome() || target;
  if (target.startsWith(HOME_PREFIX)) return path.join(platformHome() || '', target.slice(HOME_PREFIX.length));
  return target;
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
