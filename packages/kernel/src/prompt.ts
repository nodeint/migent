import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { buildStageReplyPrompt, prependRoleInstructions, renderStageContinue, renderStageStart, renderVerifyRepair } from '@nodeint/migent-prompts';
import { isRecord } from '@nodeint/migent-workflow';
import { isRoleStage, isWorkflowV2, routeListsStage, stageArtifactsFor, type StageSpec, VERIFY_ARTIFACT, type WorkflowDocument } from '@nodeint/migent-workflow';

import { type ExecutionSnapshot,isArtifactSchema, nonemptyArtifact } from './outputs.js';
import { currentCompleteByStage, latestCompleteByStage, relevantRouterSnapshots } from './selection-history.js';

export function buildStagePrompt(input: {
  workflow: WorkflowDocument;
  stageId: string;
  snapshots: readonly ExecutionSnapshot[];
  workspace: string;
  taskFile?: string | null;
  sessionDirectory?: string | null;
  priorSessionId?: string | null;
  priorOutputs?: Readonly<Record<string, unknown>> | null;
  roleInstructions?: readonly string[] | null;
}): string {
  const stage = input.workflow.stages[input.stageId];
  if (stage === undefined) throw new Error(`Stage is not declared: ${input.stageId}.`);
  if (!isRoleStage(stage)) throw new Error(`Stage ${stage.id} has no role.`);
  const sessionDirectory =
    input.sessionDirectory ?? path.join(input.workspace, '.migent', 'sessions', 'session');
  const taskFile = input.taskFile ?? path.join(sessionDirectory, 'task.md');
  return renderStageStart({
    taskFile: resolvePath(taskFile),
    sessionDirectory: resolvePath(sessionDirectory),
    stage,
    roleInstructions: input.roleInstructions ?? [],
    constraints: input.workflow.constraints,
    ...continuationContext(input, stage.dependsOn),
    prior: priorResultContext(input.workspace, input.priorSessionId, input.priorOutputs),
  });
}

export { buildStageReplyPrompt, prependRoleInstructions };

/** Later visit of a stage. The provider conversation already has the stage prompt. */
export function buildStageResumePrompt(input: {
  workflow: WorkflowDocument;
  stageId: string;
  snapshots: readonly ExecutionSnapshot[];
  workspace: string;
  taskFile?: string | null;
  sessionDirectory?: string | null;
}): string {
  const stage = input.workflow.stages[input.stageId];
  if (stage === undefined) throw new Error(`Stage is not declared: ${input.stageId}.`);
  const sessionDirectory = input.sessionDirectory ?? path.join(input.workspace, '.migent', 'sessions', 'session');
  const previous = latestCompleteByStage(input.snapshots)[input.stageId];
  const response = previous ? resolvePath(path.join(path.dirname(previous.artifactDirectory), 'response.md')) : null;
  return renderStageContinue({
    ...continuationContext(input, stage.dependsOn),
    taskFile: resolvePath(input.taskFile ?? path.join(sessionDirectory, 'task.md')),
    previousResponse: response !== null && isFile(response) ? response : null,
  });
}

function continuationContext(
  input: { workflow: WorkflowDocument; stageId: string; snapshots: readonly ExecutionSnapshot[]; workspace: string },
  dependsOn: readonly string[],
) {
  return {
    upstream: upstreamArtifacts(input, dependsOn),
    routed: routedResultContext(input.workflow, input.stageId, input.snapshots),
    blocked: previousBlockedAttempt(input.stageId, input.snapshots),
    failed: previousFailedAttempt(input.stageId, input.snapshots),
  };
}

export function buildVerifyRepairPrompt(
  report: string,
  state: { red: number; maxVerify: number; artifactPath: string | null },
  files: { taskFile?: string | null; sessionDirectory?: string | null } = {},
): string {
  const { red, maxVerify, artifactPath } = state;
  const { taskFile, sessionDirectory } = files;
  return renderVerifyRepair({
    report, red, maxVerify, artifactPath,
    taskFile: taskFile && sessionDirectory ? resolvePath(taskFile) : null,
    sessionDirectory: taskFile && sessionDirectory ? resolvePath(sessionDirectory) : null,
  });
}

/** Artifact lines one completed dependency contributes, plus its verify report when it verifies. */
function dependencyLines(
  dep: StageSpec,
  snapshot: ExecutionSnapshot,
  flags: { v7: boolean; updated: boolean },
): UpstreamLine[] {
  const { v7, updated } = flags;
  const lines: UpstreamLine[] = [];
  for (const artifact of producedArtifacts(dep, snapshot, v7)) {
    const artifactPath = resolvePath(path.join(snapshot.artifactDirectory, artifact.file));
    if (v7 && !nonemptyArtifact(artifactPath)) continue;
    lines.push({ stageId: dep.id, path: artifactPath, verify: false, description: artifact.description, updated });
  }
  if (dep.verify.length > 0) {
    const reportPath = resolvePath(path.join(snapshot.artifactDirectory, VERIFY_ARTIFACT));
    lines.push({ stageId: dep.id, path: reportPath, verify: true, description: null, updated });
  }
  return lines;
}

function upstreamArtifacts(
  input: { workflow: WorkflowDocument; snapshots: readonly ExecutionSnapshot[]; stageId: string },
  dependsOn: readonly string[],
): UpstreamLine[] {
  const { workflow, snapshots, stageId } = input;
  const v7 = isArtifactSchema(workflow);
  const complete = v7 ? currentCompleteByStage(workflow, snapshots) : latestCompleteByStage(snapshots);
  const ownOrder = complete[stageId]?.executionOrder ?? 0; // 0: first visit, nothing counts as updated
  const lines: UpstreamLine[] = [];
  for (const depId of dependsOn) {
    const dep = workflow.stages[depId];
    const snapshot = complete[depId];
    if (dep === undefined || snapshot === undefined) continue;
    lines.push(...dependencyLines(dep, snapshot, { v7, updated: ownOrder > 0 && snapshot.executionOrder > ownOrder }));
  }
  return lines;
}

interface UpstreamLine {
  stageId: string;
  path: string;
  verify: boolean;
  description: string | null;
  updated: boolean;
}

/** Stage-level files plus those of the decision the execution chose (schema 7 only adds decision files). */
function producedArtifacts(stage: StageSpec, snapshot: ExecutionSnapshot, v7: boolean) {
  return v7 ? stageArtifactsFor(stage, snapshot.outcomeDecision) : stage.artifacts;
}

interface RoutingInput {
  workflow: WorkflowDocument;
  snapshots: readonly ExecutionSnapshot[];
  stageId: string;
}

type RoutedArtifact = { stageId: string; path: string; verify: boolean; description: string | null };

/** Schema 1 routing: the latest completion after the previous visit whose decision routes here. */
function legacyRoutedSnapshots(input: RoutingInput, previousOrder: number): readonly ExecutionSnapshot[] {
  const { workflow, snapshots, stageId } = input;
  const candidates = snapshots.filter((snapshot) => {
    if (snapshot.status !== 'completed' || snapshot.outcomeStatus !== 'complete') return false;
    if (snapshot.executionOrder <= previousOrder) return false;
    const source = workflow.stages[snapshot.stageId];
    return source !== undefined && routeListsStage(source.routes[(snapshot.outcomeDecision ?? '').toLowerCase()], stageId);
  });
  return candidates.length === 0 ? [] : [candidates.reduce((a, b) => b.executionOrder > a.executionOrder ? b : a)];
}

function routedSnapshots(input: RoutingInput, previousOrder: number): readonly ExecutionSnapshot[] {
  const { workflow, snapshots, stageId } = input;
  if (isWorkflowV2(workflow)) return relevantRouterSnapshots(workflow, snapshots, stageId) ?? [];
  return legacyRoutedSnapshots(input, previousOrder);
}

function routedDecision(decision: ExecutionSnapshot) {
  const response = resolvePath(path.join(path.dirname(decision.artifactDirectory), 'response.md'));
  if (!isFile(response)) throw new Error(`Routed stage response is missing: ${response}`);
  return { stageId: decision.stageId, decision: decision.outcomeDecision, path: response };
}

function previousStageArtifacts(
  own: StageSpec | undefined,
  previous: ExecutionSnapshot | undefined,
  v7: boolean,
): string[] {
  if (!previous || !own) return [];
  return own.artifacts
    .map((item) => resolvePath(path.join(previous.artifactDirectory, item.file)))
    .filter((file) => (v7 ? nonemptyArtifact(file) : isFile(file)));
}

function routerArtifacts(router: StageSpec, decision: ExecutionSnapshot): RoutedArtifact[] {
  const lines: RoutedArtifact[] = [];
  for (const item of stageArtifactsFor(router, decision.outcomeDecision)) {
    const file = resolvePath(path.join(decision.artifactDirectory, item.file));
    if (nonemptyArtifact(file)) {
      lines.push({ stageId: router.id, path: file, verify: false, description: item.description });
    }
  }
  if (router.verify.length > 0) {
    lines.push({
      stageId: router.id,
      path: resolvePath(path.join(decision.artifactDirectory, VERIFY_ARTIFACT)),
      verify: true,
      description: null,
    });
  }
  return lines;
}

/** Schema 7: the routers' artifacts reach the destination under the same rule as dependents. */
function routedArtifactLines(
  workflow: WorkflowDocument,
  own: StageSpec | undefined,
  routed: readonly ExecutionSnapshot[],
): RoutedArtifact[] {
  const seen = new Set<string>(own?.dependsOn ?? []);
  const lines: RoutedArtifact[] = [];
  for (const decision of routed) {
    const router = workflow.stages[decision.stageId];
    if (router === undefined || seen.has(router.id)) continue;
    lines.push(...routerArtifacts(router, decision));
  }
  return lines;
}

function routedResultContext(workflow: WorkflowDocument, stageId: string, snapshots: readonly ExecutionSnapshot[]) {
  const v7 = isArtifactSchema(workflow);
  // Schema 7 never reads a completion that a later skip superseded.
  const complete = v7
    ? currentCompleteByStage(workflow, snapshots)
    : latestCompleteByStage(snapshots);
  const previous = complete[stageId];
  const routed = routedSnapshots({ workflow, snapshots, stageId }, previous ? previous.executionOrder : 0);
  if (routed.length === 0) return null;
  const decisions = routed.map(routedDecision);
  const own = workflow.stages[stageId];
  const previousArtifacts = previousStageArtifacts(own, previous, v7);
  const routedArtifacts = v7 ? routedArtifactLines(workflow, own, routed) : [];
  return {
    decisions,
    stageId,
    previousArtifact: previousArtifacts[0] ?? null,
    previousArtifacts,
    routedArtifacts,
  };
}

function previousBlockedAttempt(stageId: string, snapshots: readonly ExecutionSnapshot[]) {
  let latest: ExecutionSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.stageId !== stageId) continue;
    if (latest === null || snapshot.executionOrder > latest.executionOrder) latest = snapshot;
  }
  if (latest === null || latest.status !== 'completed' || latest.outcomeStatus !== 'blocked') return null;
  const executionDirectory = path.dirname(latest.artifactDirectory);
  const blocker = readOutcomeBlocker(path.join(executionDirectory, 'execution.json'));
  const responsePath = path.join(executionDirectory, 'response.md');
  return {
    executionId: latest.executionId,
    blocker,
    response: isFile(responsePath) ? resolvePath(responsePath) : null,
  };
}

/**
 * The latest attempt of the stage failed without a named failure reason and still left a reply. Its
 * work may be partly done, so the next prompt points at the reply and asks for the state to be re-checked.
 */
function previousFailedAttempt(stageId: string, snapshots: readonly ExecutionSnapshot[]) {
  let latest: ExecutionSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.stageId !== stageId) continue;
    if (latest === null || snapshot.executionOrder > latest.executionOrder) latest = snapshot;
  }
  if (latest === null || latest.status !== 'failed' || latest.failureReason) return null;
  const responsePath = path.join(path.dirname(latest.artifactDirectory), 'response.md');
  return isFile(responsePath) ? { response: resolvePath(responsePath) } : null;
}

function readOutcomeBlocker(filePath: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isRecord(raw.outcome)) return null;
  const {blocker} = raw.outcome;
  return typeof blocker === 'string' && blocker ? blocker : null;
}

function priorResultContext(
  workspace: string,
  priorSessionId: string | null | undefined,
  priorOutputs: Readonly<Record<string, unknown>> | null | undefined,
) {
  if (!priorSessionId) return null;
  const outputs: { name: string; path: string }[] = [];
  for (const [name, value] of Object.entries(priorOutputs ?? {})) {
    const outputPath = absoluteOutputPath(workspace, priorSessionId, value);
    if (outputPath) outputs.push({ name, path: outputPath });
  }
  return { sessionId: priorSessionId, outputs };
}

function absoluteOutputPath(
  workspace: string,
  priorSessionId: string,
  entry: unknown,
): string | null {
  if (!isRecord(entry)) return null;
  const raw = entry.path;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const trimmed = raw.trim();
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  return resolvePath(
    path.join(workspace, '.migent', 'sessions', priorSessionId, trimmed),
  );
}

function isMissingPathError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function resolvePath(target: string): string {
  const absolute = path.resolve(target);
  let cursor = absolute;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cursor);
      return suffix.length === 0 ? real : path.join(real, ...suffix);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return absolute;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}
