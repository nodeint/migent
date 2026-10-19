import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fsyncPath, renameWithRetry } from "./atomic-file.js";
import { StageOutcome } from "./stage-outcome.js";
import type { WorkflowDocument } from "./workflow.js";

const asciiSpace = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

export interface ExecutionSnapshot {
  executionId: string;
  stageId: string;
  executionOrder: number;
  status: string;
  outcomeStatus: string | null;
  artifactDirectory: string;
  outcomeDecision: string | null;
  failureReason?: string | null;
  verifyReport?: string | null;
}

export interface PublishedOutput {
  path: string;
  sourceExecutionId: string;
  publishedByExecutionId: string;
}

export function sessionStatusAfterExecution(
  executionStatus: string,
  outcome: StageOutcome | null,
  previousStatus: Readonly<Record<string, unknown>>,
  workflow: WorkflowDocument | null,
  stageId: string,
): string {
  if (outcome && outcome.status === "blocked") return "blocked";
  if (executionStatus === "cancelled") return "cancelled";
  if (previousStatus.workflow_id === "agent") {
    if (executionStatus === "completed" && outcome !== null && outcome.status === "complete") {
      return "completed";
    }
    return "active";
  }
  const workflowId = previousStatus.workflow_id;
  if (
    isCompletionDecision({
      workflowId: typeof workflowId === "string" ? workflowId : null,
      executionStatus,
      outcome,
      workflow,
      stageId,
    })
  ) {
    return "completed";
  }
  return "active";
}

export function runnableViolation(
  sessionId: string,
  status: Readonly<Record<string, unknown>>,
): string | null {
  const sessionStatus = Object.hasOwn(status, "status") ? status.status : undefined;
  if (sessionStatus === "active") return null;
  if (sessionStatus === "completed" && status.workflow_id === "agent") return null;
  const terminalBy = Object.hasOwn(status, "blocked_by_execution_id")
    ? status.blocked_by_execution_id
    : Object.hasOwn(status, "terminal_execution_id")
      ? status.terminal_execution_id
      : "an earlier execution";
  return (
    `Session ${sessionId} is ${pyNone(sessionStatus)} at ${pyNone(terminalBy)}; ` +
    "start a new session to continue."
  );
}

export function isCompletionDecision(input: {
  workflowId: string | null;
  executionStatus: string;
  outcome: StageOutcome | null;
  workflow: WorkflowDocument | null;
  stageId: string;
}): boolean {
  if (input.workflowId === "agent") return false;
  if (input.executionStatus !== "completed") return false;
  if (input.outcome === null || input.outcome.status !== "complete") return false;
  if (input.workflow === null || input.workflow.completion === null) return false;
  const completion = input.workflow.completion;
  if (completion.stage !== input.stageId) return false;
  if (completion.decision !== null) {
    const expected = completion.decision.toLowerCase();
    const actual = input.outcome.decision ? input.outcome.decision.toLowerCase() : null;
    if (actual !== expected) return false;
  }
  return true;
}

export function shouldPublishOutputs(input: {
  workflowId: string | null;
  executionStatus: string;
  outcome: StageOutcome | null;
  workflow: WorkflowDocument;
  stageId: string;
}): boolean {
  if (
    !isCompletionDecision({
      workflowId: input.workflowId,
      executionStatus: input.executionStatus,
      outcome: input.outcome,
      workflow: input.workflow,
      stageId: input.stageId,
    })
  ) {
    return false;
  }
  const completion = input.workflow.completion;
  return completion !== null && completion.outputs.length > 0;
}

export function selectSourceExecution(
  snapshots: readonly ExecutionSnapshot[],
  fromStage: string,
  beforeOrder: number,
): ExecutionSnapshot | null {
  let selected: ExecutionSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.stageId !== fromStage) continue;
    if (snapshot.executionOrder >= beforeOrder) continue;
    if (snapshot.status !== "completed" || snapshot.outcomeStatus !== "complete") continue;
    if (selected === null || snapshot.executionOrder > selected.executionOrder) {
      selected = snapshot;
    }
  }
  return selected;
}

export function missingCompletionOutputNames(input: {
  workflow: WorkflowDocument;
  snapshots: readonly ExecutionSnapshot[];
  beforeOrder: number;
}): string[] {
  const completion = input.workflow.completion;
  if (completion === null || completion.outputs.length === 0) return [];
  const missing: string[] = [];
  for (const output of completion.outputs) {
    const source = selectSourceExecution(input.snapshots, output.fromStage, input.beforeOrder);
    if (source === null || !nonemptyArtifact(path.join(source.artifactDirectory, output.artifact))) {
      missing.push(output.name);
    }
  }
  return missing;
}

export function nonemptyArtifact(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
  } catch {
    return false;
  }
  const data = readFileSync(filePath);
  let start = 0;
  let end = data.length;
  while (start < end && asciiSpace.has(data[start]!)) start += 1;
  while (end > start && asciiSpace.has(data[end - 1]!)) end -= 1;
  return end > start;
}

export function publishOutputFiles(
  sessionDirectory: string,
  sources: Readonly<Record<string, readonly [string, string]>>,
  publishedByExecutionId: string,
): Record<string, PublishedOutput> {
  const recorded: Record<string, PublishedOutput> = {};
  for (const [name, [sourcePath, sourceExecutionId]] of Object.entries(sources)) {
    if (!nonemptyArtifact(sourcePath)) continue;
    const destination = path.join(sessionDirectory, "outputs", name);
    atomicCopy(sourcePath, destination);
    recorded[name] = {
      path: `outputs/${name}`,
      sourceExecutionId,
      publishedByExecutionId,
    };
  }
  return recorded;
}

export function atomicCopy(source: string, destination: string): void {
  mkdirSync(path.dirname(destination), { recursive: true });
  const tmp = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    copyFileSync(source, tmp);
    fsyncPath(tmp);
    renameWithRetry(tmp, destination);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Python ignores OSError while removing the temp file.
    }
    throw error;
  }
}

function pyNone(value: unknown): string {
  if (value === null || value === undefined) return "None";
  return String(value);
}
