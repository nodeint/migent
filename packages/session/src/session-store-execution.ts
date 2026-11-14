/** Pure helpers for execution directories, metadata, and lifecycle events used by SessionStore. */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import type { ExecutionStatus } from '@nodeint/migent-contracts';
import type { StageOutcome } from '@nodeint/migent-kernel';
import {
  EXECUTION_SCHEMA_VERSION,
  EXECUTIONS_DIRNAME,
  ownerMetadataPayload,
  safeComponent,
  utcNow,
  writeFileAtomic,
  writeJsonAtomic,
} from '@nodeint/migent-kernel';

import { ORDER_PAD_WIDTH, TURN_PAD_WIDTH } from './constants.js';
import { appendLifecycleEvent } from './session-events.js';
import { quotedSessionId } from './session-id.js';
import type { PlannedExecutionSave } from './session-ledger.js';
import { ExecutionContext, type SkipDetails } from './session-store-types.js';

/** Inputs for the events, fold, and sealing that follow a final execution file. */
export interface FinishExecutionSaveInput {
  context: ExecutionContext;
  sessionDirectory: string;
  status: ExecutionStatus;
  outcome: StageOutcome | null;
  plan: PlannedExecutionSave;
  previousStatus: Record<string, unknown>;
  timestamp: string;
  stageId: string;
  failureReason: string | null;
  storedError: string | null;
  extraData: Record<string, unknown> | null;
}

export function executionIdFor(order: number, stageId: string, attempt: number): string {
  const orderText = String(order).padStart(ORDER_PAD_WIDTH, '0');
  const attemptText = String(attempt).padStart(TURN_PAD_WIDTH, '0');
  return `${orderText}-${safeComponent(stageId)}--attempt-${attemptText}`;
}

/** Create a fresh execution directory; an existing one is an error. */
export function makeExecutionDirectory(directory: string): void {
  mkdirSync(path.dirname(directory), { recursive: true });
  try {
    mkdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Execution already exists: ${directory}`, { cause: error });
    }
    throw error;
  }
}

export function copyTaskFile(sessionDirectory: string, directory: string): void {
  const taskSource = path.join(sessionDirectory, 'task.md');
  if (existsSync(taskSource)) copyFileSync(taskSource, path.join(directory, 'task.md'));
}

export function isEndedExecutionStatus(status: unknown): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'skipped';
}

export function skippedExecutionMetadata(input: {
  sessionId: string;
  executionId: string;
  order: number;
  stageId: string;
  attempt: number;
  timestamp: string;
  skipRecord: Record<string, unknown>;
}): Record<string, unknown> {
  const { sessionId, executionId, order, stageId, attempt, timestamp, skipRecord } = input;
  return {
    session_id: sessionId,
    execution_id: executionId,
    execution_order: order,
    stage_id: stageId,
    stage_attempt: attempt,
    kind: 'skip',
    client: null,
    model: null,
    options: {},
    agent_id: null,
    resumes_execution_id: null,
    status: 'skipped',
    schema_version: EXECUTION_SCHEMA_VERSION,
    created_at: timestamp,
    completed_at: timestamp,
    artifact_directory: 'artifacts',
    skip: skipRecord,
  };
}

export function runningExecutionMetadata(input: {
  sessionId: string;
  executionId: string;
  order: number;
  stageId: string;
  attempt: number;
  verifyOnly: boolean;
  client: string;
  model: string;
  options: Record<string, string> | null | undefined;
  resumesExecutionId: string | null;
  createdAt: string;
}): Record<string, unknown> {
  const { sessionId, executionId, order, stageId, attempt, verifyOnly, client, model, options } = input;
  return {
    session_id: sessionId,
    execution_id: executionId,
    execution_order: order,
    stage_id: stageId,
    stage_attempt: attempt,
    ...(verifyOnly ? { kind: 'verify' } : {}),
    client: verifyOnly ? null : client,
    model: verifyOnly ? null : model,
    options: { ...(options ?? {}) },
    agent_id: null,
    resumes_execution_id: input.resumesExecutionId,
    status: 'running',
    ...ownerMetadataPayload(),
    schema_version: EXECUTION_SCHEMA_VERSION,
    created_at: input.createdAt,
    artifact_directory: 'artifacts',
  };
}

/** Lifecycle events for a final execution: execution, stage outcome, outputs, and session status. */
export function appendExecutionSaveEvents(input: FinishExecutionSaveInput): void {
  const { context, sessionDirectory, status, outcome, plan, timestamp, stageId } = input;
  const { failureReason, storedError } = input;
  appendLifecycleEvent(sessionDirectory, {
    event: `execution.${status}`,
    timestamp,
    executionId: context.executionId,
    stageId,
    data: {
      outcome: outcome ? outcome.toJson() : null,
      failure_reason: failureReason,
      error: storedError,
      session_status: plan.sessionStatus,
      ...(input.extraData ?? {}),
    },
  });
  if (outcome !== null) {
    const outcomeJson = outcome.toJson();
    appendLifecycleEvent(sessionDirectory, {
      event: `stage.${outcome.status}`,
      timestamp,
      executionId: context.executionId,
      stageId,
      outcomeTopLevel: outcomeJson,
      data: { outcome: outcomeJson },
    });
  }
  if (plan.outputs.length > 0) {
    appendLifecycleEvent(sessionDirectory, {
      event: 'outputs.published',
      timestamp,
      executionId: context.executionId,
      stageId,
      data: { outputs: plan.outputs },
    });
  }
  if (plan.sessionEvent !== null) {
    appendLifecycleEvent(sessionDirectory, {
      event: `session.${plan.sessionStatus}`,
      timestamp,
      executionId: context.executionId,
      stageId,
      outcomeTopLevel: plan.sessionEvent.outcomeTopLevel,
      data: plan.sessionEvent.data,
    });
  }
}

export function appendExecutionStarted(
  sessionDirectory: string,
  event: { timestamp: string; executionId: string; stageId: string },
  data: Record<string, unknown>,
): void {
  appendLifecycleEvent(sessionDirectory, { event: 'execution.started', ...event, data });
}

export function skipRecordOf(skip: SkipDetails): Record<string, unknown> {
  return {
    reason: skip.reason,
    baseline: skip.baseline,
    patterns: [...skip.patterns],
    changed_paths: skip.changedPaths,
  };
}

/** Write the session manifest and its created event the first time a session gets an execution. */
export function createSessionFiles(context: ExecutionContext): void {
  const sessionDirectory = path.dirname(path.dirname(context.directory));
  const manifestPath = path.join(sessionDirectory, 'manifest.yaml');
  if (existsSync(manifestPath)) return;
  const createdAt = utcNow();
  writeFileAtomic(
    manifestPath,
    `${[`session_id: ${quotedSessionId(context.sessionId)}`, `created_at: ${createdAt}`, 'status: running'].join('\n')}\n`);
  appendLifecycleEvent(sessionDirectory, {
    event: 'session.created',
    timestamp: createdAt,
    data: {},
  });
}


/** Create `executions/<id>` with its task copy and artifact directory, and return its context. */
export function openExecutionDirectory(
  sessionDirectory: string,
  sessionId: string,
  executionId: string,
): ExecutionContext {
  const directory = path.join(sessionDirectory, EXECUTIONS_DIRNAME, executionId);
  makeExecutionDirectory(directory);
  copyTaskFile(sessionDirectory, directory);
  const context = new ExecutionContext(sessionId, executionId, directory);
  mkdirSync(context.artifactDirectory);
  return context;
}

/** Write the running execution.json and its `execution.started` event. */
export function writeStartedExecution(
  context: ExecutionContext,
  start: {
    order: number;
    stageId: string;
    attempt: number;
    verifyOnly: boolean;
    client: string;
    model: string;
    options: Record<string, string> | null | undefined;
    resumesExecutionId: string | null;
  },
): void {
  const { order, stageId, attempt, client, model, resumesExecutionId } = start;
  const { directory, executionId } = context;
  const createdAt = utcNow();
  const sessionDirectory = path.dirname(path.dirname(directory));
  writeJsonAtomic(
    path.join(directory, 'execution.json'),
    runningExecutionMetadata({ ...start, sessionId: context.sessionId, executionId, createdAt }),
  );
  appendExecutionStarted(sessionDirectory, { timestamp: createdAt, executionId, stageId }, {
    execution_order: order,
    stage_attempt: attempt,
    client,
    model,
    resumes_execution_id: resumesExecutionId,
  });
}
