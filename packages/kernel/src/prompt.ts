import { buildStageReplyPrompt, prependRoleInstructions, renderStageContinue, renderStageStart, renderVerifyRepair } from "@nodeint/migent-prompts";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isArtifactSchema, nonemptyArtifact, type ExecutionSnapshot } from "./outputs.js";
import { isRecord } from "@nodeint/migent-workflow";
import { currentCompleteByStage, latestCompleteByStage, relevantRouterSnapshots } from "./selection.js";
import { isRoleStage, isWorkflowV2, routeListsStage, stageArtifactsFor, VERIFY_ARTIFACT, type StageSpec, type WorkflowDocument } from "@nodeint/migent-workflow";

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
    input.sessionDirectory ?? path.join(input.workspace, ".migent", "sessions", "session");
  const taskFile = input.taskFile ?? path.join(sessionDirectory, "task.md");
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
  const sessionDirectory = input.sessionDirectory ?? path.join(input.workspace, ".migent", "sessions", "session");
  const previous = latestCompleteByStage(input.snapshots)[input.stageId];
  const response = previous ? resolvePath(path.join(path.dirname(previous.artifactDirectory), "response.md")) : null;
  return renderStageContinue({
    ...continuationContext(input, stage.dependsOn),
    taskFile: resolvePath(input.taskFile ?? path.join(sessionDirectory, "task.md")),
    previousResponse: response !== null && isFile(response) ? response : null,
  });
}

function continuationContext(
  input: { workflow: WorkflowDocument; stageId: string; snapshots: readonly ExecutionSnapshot[]; workspace: string },
  dependsOn: readonly string[],
) {
  return {
    upstream: upstreamArtifacts(input.workflow, dependsOn, input.snapshots, input.stageId),
    routed: routedResultContext(input.workflow, input.stageId, input.snapshots),
    blocked: previousBlockedAttempt(input.stageId, input.snapshots),
    failed: previousFailedAttempt(input.stageId, input.snapshots),
  };
}

export function buildVerifyRepairPrompt(
  report: string,
  red: number,
  maxVerify: number,
  artifactPath: string | null,
  taskFile?: string | null,
  sessionDirectory?: string | null,
): string {
  return renderVerifyRepair({
    report, red, maxVerify, artifactPath,
    taskFile: taskFile && sessionDirectory ? resolvePath(taskFile) : null,
    sessionDirectory: taskFile && sessionDirectory ? resolvePath(sessionDirectory) : null,
  });
}

function upstreamArtifacts(
  workflow: WorkflowDocument,
  dependsOn: readonly string[],
  snapshots: readonly ExecutionSnapshot[],
  stageId: string,
): UpstreamLine[] {
  const v7 = isArtifactSchema(workflow);
  const complete = v7 ? currentCompleteByStage(workflow, snapshots) : latestCompleteByStage(snapshots);
  const ownOrder = complete[stageId]?.executionOrder ?? 0; // 0: first visit, nothing counts as updated
  const lines: UpstreamLine[] = [];
  for (const depId of dependsOn) {
    const dep = workflow.stages[depId];
    if (dep === undefined) continue;
    const snapshot = complete[depId];
    if (snapshot === undefined) continue;
    for (const artifact of producedArtifacts(dep, snapshot, v7)) {
      const artifactPath = resolvePath(path.join(snapshot.artifactDirectory, artifact.file));
      if (v7 && !nonemptyArtifact(artifactPath)) continue;
      lines.push({ stageId: depId, path: artifactPath, verify: false, description: artifact.description, updated: ownOrder > 0 && snapshot.executionOrder > ownOrder });
    }
    if (dep.verify.length > 0) {
      const reportPath = resolvePath(path.join(snapshot.artifactDirectory, VERIFY_ARTIFACT));
      lines.push({ stageId: depId, path: reportPath, verify: true, description: null, updated: ownOrder > 0 && snapshot.executionOrder > ownOrder });
    }
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

function routedResultContext(workflow: WorkflowDocument, stageId: string, snapshots: readonly ExecutionSnapshot[]) {
  // Schema 7 never reads a completion that a later skip superseded.
  const complete = isArtifactSchema(workflow) ? currentCompleteByStage(workflow, snapshots) : latestCompleteByStage(snapshots);
  const previous = complete[stageId];
  const previousOrder = previous ? previous.executionOrder : 0;
  let routed: readonly ExecutionSnapshot[];
  if (isWorkflowV2(workflow)) {
    routed = relevantRouterSnapshots(workflow, snapshots, stageId) ?? [];
  } else {
    const candidates = snapshots.filter((snapshot) => {
      if (snapshot.status !== "completed" || snapshot.outcomeStatus !== "complete") return false;
      if (snapshot.executionOrder <= previousOrder) return false;
      const source = workflow.stages[snapshot.stageId];
      return source !== undefined && routeListsStage(source.routes[(snapshot.outcomeDecision ?? "").toLowerCase()], stageId);
    });
    routed = candidates.length === 0 ? [] : [candidates.reduce((a, b) => b.executionOrder > a.executionOrder ? b : a)];
  }
  if (routed.length === 0) return null;
  const decisions = routed.map((decision) => {
    const response = resolvePath(path.join(path.dirname(decision.artifactDirectory), "response.md"));
    if (!isFile(response)) throw new Error(`Routed stage response is missing: ${response}`);
    return { stageId: decision.stageId, decision: decision.outcomeDecision, path: response };
  });
  const v7 = isArtifactSchema(workflow);
  const own = workflow.stages[stageId];
  const previousArtifacts = previous && own
    ? own.artifacts
        .map((item) => resolvePath(path.join(previous.artifactDirectory, item.file)))
        .filter((file) => (v7 ? nonemptyArtifact(file) : isFile(file)))
    : [];
  // Schema 7: the routers' artifacts reach the destination under the same rule as dependents.
  const routedArtifacts: { stageId: string; path: string; verify: boolean; description: string | null }[] = [];
  if (v7) {
    const seen = new Set<string>(own?.dependsOn ?? []);
    for (const decision of routed) {
      const router = workflow.stages[decision.stageId];
      if (router === undefined || seen.has(router.id)) continue;
      for (const item of stageArtifactsFor(router, decision.outcomeDecision)) {
        const file = resolvePath(path.join(decision.artifactDirectory, item.file));
        if (nonemptyArtifact(file)) routedArtifacts.push({ stageId: router.id, path: file, verify: false, description: item.description });
      }
      if (router.verify.length > 0) {
        routedArtifacts.push({
          stageId: router.id,
          path: resolvePath(path.join(decision.artifactDirectory, VERIFY_ARTIFACT)),
          verify: true,
          description: null,
        });
      }
    }
  }
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
  if (latest === null || latest.status !== "completed" || latest.outcomeStatus !== "blocked") return null;
  const executionDirectory = path.dirname(latest.artifactDirectory);
  const blocker = readOutcomeBlocker(path.join(executionDirectory, "execution.json"));
  const responsePath = path.join(executionDirectory, "response.md");
  return { executionId: latest.executionId, blocker, response: isFile(responsePath) ? resolvePath(responsePath) : null };
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
  if (latest === null || latest.status !== "failed" || latest.failureReason) return null;
  const responsePath = path.join(path.dirname(latest.artifactDirectory), "response.md");
  return isFile(responsePath) ? { response: resolvePath(responsePath) } : null;
}

function readOutcomeBlocker(filePath: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isRecord(raw.outcome)) return null;
  const blocker = raw.outcome.blocker;
  return typeof blocker === "string" && blocker ? blocker : null;
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
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  return resolvePath(
    path.join(workspace, ".migent", "sessions", priorSessionId, trimmed),
  );
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
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
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
