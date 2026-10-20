import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ExecutionSnapshot } from "./outputs.js";
import { isRecord } from "./record.js";
import { latestCompleteByStage, relevantRouterSnapshots } from "./selection.js";
import { isWorkflowV2, routeListsStage, VERIFY_ARTIFACT, type WorkflowDocument } from "./workflow.js";

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
  const sessionDirectory =
    input.sessionDirectory ?? path.join(input.workspace, ".migent", "sessions", "session");
  const taskFile = input.taskFile ?? path.join(sessionDirectory, "task.md");
  const sections = [taskLocationSection(taskFile, sessionDirectory), `Stage: ${stage.id} (role: ${stage.role})`];
  const roleSection = bulletSection("Role instructions:", input.roleInstructions);
  if (roleSection !== null) sections.push(roleSection);
  if (stage.instructions.length > 0) {
    const lines = ["Instructions:", ...stage.instructions.map((item) => `- ${item}`)];
    sections.push(lines.join("\n"));
  }
  if (input.workflow.constraints.length > 0) {
    const lines = ["Constraints:", ...input.workflow.constraints.map((item) => `- ${item}`)];
    sections.push(lines.join("\n"));
  }
  if (stage.verify.length > 0) {
    const lines = [
      "Verify commands:",
      "These commands must exit 0 before you report `status: complete`.",
      "Run them in the workspace, in order. When a command fails, fix the cause and run it again.",
      "Report `status: complete` only after every command passes.",
      ...stage.verify.map((item) => `- ${item}`),
    ];
    sections.push(lines.join("\n"));
  }
  sections.push(...stageContinuationSections(input, stage.dependsOn));
  const prior = priorResultLines(input.workspace, input.priorSessionId, input.priorOutputs);
  if (prior.length > 0) sections.push(`Required prior workflow result:\n${prior.join("\n")}`);
  if (stage.artifact) {
    sections.push(
      `Write the file artifact as \`${stage.artifact}\` in the execution artifacts directory.`,
    );
  }
  return sections.join("\n\n");
}

/** Later visit of a stage. The provider conversation already has the stage prompt. */
export function buildStageResumePrompt(input: {
  workflow: WorkflowDocument;
  stageId: string;
  snapshots: readonly ExecutionSnapshot[];
  workspace: string;
}): string {
  const stage = input.workflow.stages[input.stageId];
  if (stage === undefined) throw new Error(`Stage is not declared: ${input.stageId}.`);
  return ["Continue this stage.", ...stageContinuationSections(input, stage.dependsOn)].join("\n\n");
}

function stageContinuationSections(
  input: {
    workflow: WorkflowDocument;
    stageId: string;
    snapshots: readonly ExecutionSnapshot[];
    workspace: string;
  },
  dependsOn: readonly string[],
): string[] {
  const sections: string[] = [];
  const upstream = upstreamArtifactLines(input.workflow, dependsOn, input.snapshots);
  if (upstream.length > 0) {
    sections.push(`Upstream artifacts on this session:\n${upstream.join("\n")}`);
  }
  const routed = routedResultLines(input.workflow, input.stageId, input.snapshots);
  if (routed.length > 0) {
    sections.push(`Decision that routed to this stage:\n${routed.join("\n")}`);
  }
  const blocked = previousBlockedAttempt(input.stageId, input.snapshots);
  if (blocked !== null) sections.push(blocked);
  return sections;
}

export function prependRoleInstructions(instructions: readonly string[], prompt: string): string {
  const section = bulletSection("Role instructions:", instructions);
  if (section === null) return prompt;
  if (prompt === "") return section;
  return `${section}\n\n${prompt}`;
}

function bulletSection(heading: string, items: readonly string[] | null | undefined): string | null {
  if (items == null || items.length === 0) return null;
  return [heading, ...items.map((item) => `- ${item}`)].join("\n");
}

export function buildVerifyRepairPrompt(
  report: string,
  red: number,
  maxVerify: number,
  artifactPath: string | null,
  taskFile?: string | null,
  sessionDirectory?: string | null,
): string {
  const lines: string[] = [];
  if (taskFile && sessionDirectory) lines.push(taskLocationSection(taskFile, sessionDirectory));
  lines.push(`Verify failed (${red} of ${maxVerify} red runs). Fix the cause, then report again.`);
  if (artifactPath !== null) {
    lines.push(`The stage artifact is at ${artifactPath}. Update it if your fix changes it.`);
  }
  return `${lines.join("\n")}\n\n${report}`;
}

function taskLocationSection(taskFile: string, sessionDirectory: string): string {
  return [
    `Read the task from \`${resolvePath(taskFile)}\`.`,
    `Session files are in \`${resolvePath(sessionDirectory)}\`.`,
  ].join("\n");
}

function upstreamArtifactLines(
  workflow: WorkflowDocument,
  dependsOn: readonly string[],
  snapshots: readonly ExecutionSnapshot[],
): string[] {
  const complete = latestCompleteByStage(snapshots);
  const lines: string[] = [];
  for (const depId of dependsOn) {
    const dep = workflow.stages[depId];
    if (dep === undefined) continue;
    const snapshot = complete[depId];
    if (snapshot === undefined) continue;
    if (dep.artifact) {
      const artifactPath = resolvePath(path.join(snapshot.artifactDirectory, dep.artifact));
      lines.push(`- ${depId}: ${artifactPath}`);
    }
    if (dep.verify.length > 0) {
      const reportPath = resolvePath(path.join(snapshot.artifactDirectory, VERIFY_ARTIFACT));
      lines.push(`- ${depId} verify: ${reportPath}`);
    }
  }
  return lines;
}

function routedResultLines(
  workflow: WorkflowDocument,
  stageId: string,
  snapshots: readonly ExecutionSnapshot[],
): string[] {
  if (isWorkflowV2(workflow)) return version2RoutedLines(workflow, stageId, snapshots);
  const complete = latestCompleteByStage(snapshots);
  const previous = complete[stageId];
  const previousOrder = previous ? previous.executionOrder : 0;
  const routed = snapshots.filter((snapshot) => {
    if (snapshot.status !== "completed" || snapshot.outcomeStatus !== "complete") return false;
    if (snapshot.executionOrder <= previousOrder) return false;
    const source = workflow.stages[snapshot.stageId];
    if (source === undefined) return false;
    return routeListsStage(source.routes[(snapshot.outcomeDecision ?? "").toLowerCase()], stageId);
  });
  if (routed.length === 0) return [];
  let decision = routed[0]!;
  for (const snapshot of routed.slice(1)) {
    if (snapshot.executionOrder > decision.executionOrder) decision = snapshot;
  }
  const response = resolvePath(path.join(path.dirname(decision.artifactDirectory), "response.md"));
  if (!isFile(response)) throw new Error(`Routed stage response is missing: ${response}`);
  const lines = [
    `- ${decision.stageId} (${decision.outcomeDecision}): ${response}`,
    "Read this response and use its decision and feedback when working on this stage.",
  ];
  const stage = workflow.stages[stageId]!;
  if (previous && stage.artifact) {
    const artifact = resolvePath(path.join(previous.artifactDirectory, stage.artifact));
    if (isFile(artifact)) lines.push(`- Previous ${stageId} artifact: ${artifact}`);
  }
  return lines;
}

function version2RoutedLines(
  workflow: WorkflowDocument,
  stageId: string,
  snapshots: readonly ExecutionSnapshot[],
): string[] {
  const routed = relevantRouterSnapshots(workflow, snapshots, stageId);
  if (routed === null || routed.length === 0) return [];
  const lines: string[] = [];
  for (const decision of routed) {
    const response = resolvePath(path.join(path.dirname(decision.artifactDirectory), "response.md"));
    if (!isFile(response)) throw new Error(`Routed stage response is missing: ${response}`);
    lines.push(`- ${decision.stageId} (${decision.outcomeDecision}): ${response}`);
  }
  lines.push("Read this response and use its decision and feedback when working on this stage.");
  const previous = latestCompleteByStage(snapshots)[stageId];
  const stage = workflow.stages[stageId];
  if (previous && stage?.artifact) {
    const artifact = resolvePath(path.join(previous.artifactDirectory, stage.artifact));
    if (isFile(artifact)) lines.push(`- Previous ${stageId} artifact: ${artifact}`);
  }
  return lines;
}

function previousBlockedAttempt(stageId: string, snapshots: readonly ExecutionSnapshot[]): string | null {
  let latest: ExecutionSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.stageId !== stageId) continue;
    if (latest === null || snapshot.executionOrder > latest.executionOrder) latest = snapshot;
  }
  if (latest === null || latest.status !== "completed" || latest.outcomeStatus !== "blocked") return null;
  const executionDirectory = path.dirname(latest.artifactDirectory);
  const lines = ["Previous attempt of this stage:", `- execution: ${latest.executionId}`];
  const blocker = readOutcomeBlocker(path.join(executionDirectory, "execution.json"));
  if (blocker) lines.push(`- blocker: ${blocker}`);
  const responsePath = path.join(executionDirectory, "response.md");
  if (isFile(responsePath)) lines.push(`- response: ${resolvePath(responsePath)}`);
  lines.push("That attempt ended blocked. The blocker was handled outside this session. Continue this stage.");
  return lines.join("\n");
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

function priorResultLines(
  workspace: string,
  priorSessionId: string | null | undefined,
  priorOutputs: Readonly<Record<string, unknown>> | null | undefined,
): string[] {
  if (!priorSessionId) return [];
  const lines = [`- session: ${priorSessionId}`];
  const paths = priorOutputPaths(workspace, priorSessionId, priorOutputs);
  if (paths.length > 0) lines.push(`- outputs: ${paths.join(", ")}`);
  return lines;
}

function priorOutputPaths(
  workspace: string,
  priorSessionId: string,
  priorOutputs: Readonly<Record<string, unknown>> | null | undefined,
): string[] {
  if (priorOutputs === null || priorOutputs === undefined) return [];
  if (Object.keys(priorOutputs).length === 0) return [];
  const paths: string[] = [];
  for (const entry of Object.values(priorOutputs)) {
    const outputPath = absoluteOutputPath(workspace, priorSessionId, entry);
    if (outputPath !== null) paths.push(outputPath);
  }
  return paths;
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
