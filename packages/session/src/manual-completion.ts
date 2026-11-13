import path from 'node:path';

import type { ClientRegistry } from '@nodeint/migent-kernel';
import {
  type ExecutionSnapshot,
  isArtifactSchema,
  missingCompletionOutputNames,
  missingWorkflowOutputNames,
  publishOutputFiles,
  resolveArtifactSources,
  selectSourceExecution,
} from '@nodeint/migent-kernel';
import { currentCompleteByStage } from '@nodeint/migent-kernel';
import { ConfigurationError, isManuallyCompletable, utcNow } from '@nodeint/migent-kernel';
import { isRecord, isWorkflowV2, type WorkflowDocument } from '@nodeint/migent-workflow';

import { sealSessionMetrics } from './metrics.js';
import { publishNextSuggestions } from './next-handoff.js';
import { readStatusFileState } from './query.js';
import { readPendingResumes } from './resume-pending.js';
import { appendLifecycleEvent } from './session-events.js';
import { commitFoldedStatus } from './session-fold.js';
import { readSessionManifest } from './session-fold-read.js';
import type { LedgerOutput } from './session-ledger.js';
import type { ManualCompletionResult } from './session-store-types.js';
import { existingNext } from './session-store-util.js';

/** `published_by_execution_id` for outputs published by `migent session complete`. */
export const MANUAL_PUBLISHER = 'manual';

export interface ManualCompletionPlan {
  outputs: LedgerOutput[];
  /** Required outputs that cannot be resolved or are empty. */
  missing: string[];
}

type ManualSources = { sources: Record<string, readonly [string, string]>; missing: string[] };

function legacyOutputSources(
  outputs: readonly { name: string; fromStage: string; artifact: string }[],
  snapshots: readonly ExecutionSnapshot[],
): Record<string, readonly [string, string]> {
  const sources: Record<string, readonly [string, string]> = {};
  for (const output of outputs) {
    const source = selectSourceExecution(snapshots, output.fromStage, Number.POSITIVE_INFINITY);
    if (source === null) continue;
    sources[output.name] = [path.join(source.artifactDirectory, output.artifact), source.executionId];
  }
  return sources;
}

function collectManualSources(workflow: WorkflowDocument, snapshots: readonly ExecutionSnapshot[]): ManualSources {
  if (!isWorkflowV2(workflow)) {
    return {
      sources: legacyOutputSources(workflow.completion?.outputs ?? [], snapshots),
      missing: missingCompletionOutputNames({ workflow, snapshots, beforeOrder: Number.POSITIVE_INFINITY }),
    };
  }
  if (!isArtifactSchema(workflow)) {
    return {
      sources: legacyOutputSources(workflow.outputs ?? [], snapshots),
      missing: missingWorkflowOutputNames(workflow, snapshots),
    };
  }
  const sources: Record<string, readonly [string, string]> = {};
  const current = currentCompleteByStage(workflow, snapshots);
  for (const item of resolveArtifactSources(workflow, current)) {
    if (item.source === null) continue;
    sources[item.name] = [path.join(item.source.artifactDirectory, item.file), item.source.executionId];
  }
  return { sources, missing: missingWorkflowOutputNames(workflow, snapshots, current) };
}

/**
 * Publish what a normal completion would publish, from the current completions.
 * Schema 7 resolves the artifact registry (skip-aware); schema 2-6 use top-level `outputs`;
 * version 1 uses `completion.outputs`. Empty or unresolvable sources are not published.
 * Returns empty plan with no missing artifacts when workflow is null (caller validates).
 */
export function publishManualCompletion(
  sessionDirectory: string,
  workflow: WorkflowDocument | null,
  snapshots: readonly ExecutionSnapshot[],
): ManualCompletionPlan {
  if (workflow === null) return { outputs: [], missing: [] };
  const { sources, missing } = collectManualSources(workflow, snapshots);
  const published = publishOutputFiles(sessionDirectory, sources, MANUAL_PUBLISHER);
  const outputs = Object.entries(published).map(([name, output]) => ({
    name,
    path: output.path,
    source_execution_id: output.sourceExecutionId,
    published_by_execution_id: output.publishedByExecutionId,
  }));
  return { outputs, missing };
}

/** The store operations the locked manual completion needs. */
export interface ManualCompletionOps {
  readonly workspace: string;
  readonly metricsClients: ClientRegistry | null;
  loadWorkflow(previousStatus: Record<string, unknown>): WorkflowDocument | null;
  snapshotList(sessionId: string): ExecutionSnapshot[];
  rewriteManifestStatus(sessionDirectory: string, status: string): void;
}

function readCompletableStatus(sessionId: string, sessionDirectory: string): Record<string, unknown> {
  const read = readStatusFileState(path.join(sessionDirectory, 'status.json'));
  if (read.state !== 'ok') {
    const reason = read.state === 'corrupt' ? 'has an unreadable status.json' : 'has no status.json';
    throw new ConfigurationError(`Session ${sessionId} ${reason}. Run: migent session repair ${sessionId}`);
  }
  const previous = read.status;
  const manifest = readSessionManifest(sessionDirectory);
  if (previous.workflow_id === 'agent' || manifest.workflowId === 'agent') {
    throw new ConfigurationError(`Session ${sessionId} is a role session. Only workflow sessions can be completed manually.`);
  }
  return previous;
}

function assertCompletableStatus(sessionId: string, from: string): void {
  if (from === 'prepared') {
    throw new ConfigurationError(
      `Session ${sessionId} is prepared and has not run. Start it with: migent session run --session ${sessionId}`,
    );
  }
  if (!isManuallyCompletable(from)) {
    throw new ConfigurationError(`Session ${sessionId} has status ${from || 'unknown'} and cannot be completed.`);
  }
}

/** A manual completion closes every pending resume decision without choosing one. */
function supersedePendingResumes(sessionDirectory: string): void {
  for (const stop of readPendingResumes(sessionDirectory)) {
    appendLifecycleEvent(sessionDirectory, {
      event: 'resume.decided',
      timestamp: utcNow(),
      stageId: stop.stageId,
      data: { stage_id: stop.stageId, source_execution_id: stop.sourceExecutionId, choice: 'superseded', origin: 'human' },
    });
  }
}

function appendManualCompletionEvents(sessionDirectory: string, from: string, plan: ManualCompletionPlan): void {
  const timestamp = utcNow();
  if (plan.outputs.length > 0) {
    appendLifecycleEvent(sessionDirectory, { event: 'outputs.published', timestamp, data: { outputs: plan.outputs } });
  }
  const data: Record<string, unknown> = {
    manual: true,
    from,
    reason: plan.missing.length > 0
      ? `Marked completed manually; missing required outputs: ${plan.missing.join(', ')}`
      : 'Marked completed manually',
  };
  if (plan.missing.length > 0) data.missing_outputs = plan.missing;
  appendLifecycleEvent(sessionDirectory, { event: 'session.completed', timestamp, data });
}

/** The locked part of `completeManually`: validates the status, publishes outputs, seals, and writes next.json. */
export function completeManuallyLocked(
  ops: ManualCompletionOps,
  sessionId: string,
  sessionDirectory: string,
): ManualCompletionResult {
    const previous = readCompletableStatus(sessionId, sessionDirectory);
    const from = typeof previous.status === 'string' ? previous.status : '';
    if (from === 'completed') {
      const outputs = isRecord(previous.outputs) ? previous.outputs : {};
      return { alreadyCompleted: true, from, outputs, missingOutputs: [], next: existingNext(sessionDirectory) };
    }
    assertCompletableStatus(sessionId, from);
    const workflow = ops.loadWorkflow(previous);
    if (workflow === null && previous.workflow_id !== 'agent') {
      throw new ConfigurationError(
        `Session ${sessionId} has no readable workflow. Check the frozen workflow or the live definition. Run: migent doctor --session ${sessionId}`,
      );
    }
    const plan = publishManualCompletion(sessionDirectory, workflow, ops.snapshotList(sessionId));
    supersedePendingResumes(sessionDirectory);
    appendManualCompletionEvents(sessionDirectory, from, plan);
    ops.rewriteManifestStatus(sessionDirectory, 'completed');
    const folded = commitFoldedStatus(ops.workspace, sessionDirectory);
    if (ops.metricsClients !== null) sealSessionMetrics(ops.workspace, sessionId, ops.metricsClients);
    const next = publishNextSuggestions(ops.workspace, sessionId);
    return {
      alreadyCompleted: false,
      from,
      outputs: isRecord(folded.outputs) ? folded.outputs : {},
      missingOutputs: plan.missing,
      next,
    };
}
