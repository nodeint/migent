import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { writeFileAtomic } from "./atomic-file.js";
import {
  loadRoleInstructions,
  loadYamlMapping,
  resolveStageSpec,
  type ModelOverride,
  type StageTarget,
} from "./config.js";
import { ConfigurationError } from "./errors.js";
import { isRecord } from "./record.js";
import { log } from "./runtime.js";
import {
  loadNamedWorkflow,
  loadWorkflowDocument,
  parseWorkflowMapping,
  type StageSpec,
  type WorkflowCompletion,
  type WorkflowDocument,
} from "./workflow.js";
import { parseYamlDocument } from "./yaml.js";

export const WORKFLOW_FREEZE_FILE = "workflow.frozen.yaml";

export interface WorkflowFreeze {
  sourceSha256: string | null;
  workflow: WorkflowDocument;
  roles: Record<string, string[]>;
  targets: Record<string, StageTarget>;
}

export interface WrittenFreeze {
  hash: string;
  sourceSha256: string | null;
}

export function writeWorkflowFreeze(
  sessionDirectory: string,
  workspace: string,
  workflow: WorkflowDocument,
): WrittenFreeze {
  const config = loadYamlMapping(path.join(workspace, ".migent", "config.yaml"));
  const roles: Record<string, string[]> = {};
  for (const role of roleNames(workflow)) roles[role] = loadRoleInstructions(config, role);
  const targets: Record<string, StageTarget> = {};
  for (const stage of Object.values(workflow.stages)) {
    const target = resolveStageSpec(config, stage);
    targets[stage.id] = { provider: target.provider, model: target.model, options: { ...target.options } };
  }
  const sourceSha256 = sourceFileHash(workflow.source);
  const filePath = path.join(sessionDirectory, WORKFLOW_FREEZE_FILE);
  const workflowBody = workflowMapping(workflow);
  parseWorkflowMapping(workflowBody, filePath);
  const text = stringify(
    { source_sha256: sourceSha256, workflow: workflowBody, roles, targets },
    { lineWidth: 0 },
  );
  writeFileAtomic(filePath, text);
  return { hash: sha256(text), sourceSha256 };
}

/** Null when the file is missing. A broken file throws and names the path. */
export function readWorkflowFreeze(sessionDirectory: string): WorkflowFreeze | null {
  const filePath = path.join(sessionDirectory, WORKFLOW_FREEZE_FILE);
  let text: string;
  try {
    if (!statSync(filePath).isFile()) return null;
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw corrupt(filePath, error instanceof Error ? error.message : String(error));
  }
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(text);
  } catch (error) {
    throw corrupt(filePath, error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(parsed)) throw corrupt(filePath, "expected a mapping");
  if (!Object.hasOwn(parsed, "source_sha256")) throw corrupt(filePath, "missing source_sha256");
  const sourceSha256 = parsed.source_sha256;
  if (sourceSha256 !== null && typeof sourceSha256 !== "string") {
    throw corrupt(filePath, "source_sha256 must be a string or null");
  }
  if (!isRecord(parsed.workflow)) throw corrupt(filePath, "workflow must be a mapping");
  let workflow: WorkflowDocument;
  try {
    workflow = parseWorkflowMapping(parsed.workflow, filePath);
  } catch (error) {
    throw corrupt(filePath, error instanceof Error ? error.message : String(error));
  }
  return {
    sourceSha256,
    workflow,
    roles: readRoles(parsed.roles, filePath),
    targets: readTargets(parsed.targets, filePath),
  };
}

export function loadFrozenWorkflow(sessionDirectory: string): WorkflowDocument | null {
  return readWorkflowFreeze(sessionDirectory)?.workflow ?? null;
}

export function frozenStageTarget(
  freeze: WorkflowFreeze,
  stageId: string,
  override?: ModelOverride,
): StageTarget {
  const provider = override?.provider ?? null;
  const model = override?.model ?? null;
  const options = override?.options ?? null;
  if ((provider === null) !== (model === null)) {
    throw new ConfigurationError(
      "Pass both --provider and --model to override the resolved stage model, or omit both.",
    );
  }
  if (provider !== null && model !== null) {
    return { provider, model, options: { ...(options ?? {}) } };
  }
  const target = freeze.targets[stageId];
  if (target === undefined) throw new ConfigurationError(`Stage not found: ${stageId}`);
  if (options === null) return { provider: target.provider, model: target.model, options: { ...target.options } };
  return { provider: target.provider, model: target.model, options: { ...target.options, ...options } };
}

export function frozenRoleInstructions(freeze: WorkflowFreeze, role: string): string[] {
  if (!Object.hasOwn(freeze.roles, role)) throw new ConfigurationError(`Missing or invalid roles.${role}.`);
  return [...freeze.roles[role]!];
}

/** The live workflow named by the session. A missing or invalid file throws. */
export function requireLiveWorkflow(
  workspace: string,
  workflowPath: string | null,
  workflowId: string | null,
): WorkflowDocument {
  if (workflowPath) {
    const filePath = workflowFile(workspace, workflowPath);
    const document = loadWorkflowDocument(filePath);
    if (Object.keys(document.stages).length === 0) {
      throw new ConfigurationError(`${document.id}: declares no stages.`);
    }
    return document;
  }
  if (workflowId) return loadNamedWorkflow(workspace, workflowId);
  throw new ConfigurationError("Workflow not found.");
}

/** Stderr only. A missing freeze file warns nothing. */
export function warnIfFrozenDrift(
  workspace: string,
  sessionId: string,
  workflowPath: string | null,
  workflowId: string | null,
): void {
  const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
  const freeze = readWorkflowFreeze(sessionDirectory);
  if (freeze === null) return;
  const filePath = workflowPath ? workflowFile(workspace, workflowPath) : null;
  let readable = false;
  if (filePath === null || !isFile(filePath)) {
    note(sessionId, "The workflow file is missing.");
  } else {
    const digest = sourceFileHash(filePath);
    if (digest === null) note(sessionId, "The workflow file cannot be loaded.");
    else {
      readable = true;
      if (digest !== freeze.sourceSha256) note(sessionId, "The workflow file differs.");
    }
  }
  let live: WorkflowDocument | null = null;
  if (readable && filePath !== null) {
    try {
      live = loadWorkflowDocument(filePath);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      note(sessionId, "The workflow file cannot be loaded.");
    }
  } else if (filePath === null && workflowId) {
    try {
      live = loadNamedWorkflow(workspace, workflowId);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
    }
  }
  let config: Record<string, unknown> | null = null;
  try {
    config = loadYamlMapping(path.join(workspace, ".migent", "config.yaml"));
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
  }
  if (live !== null && config !== null) {
    for (const [stageId, target] of Object.entries(freeze.targets)) {
      const stage = live.stages[stageId];
      if (stage === undefined || !sameTarget(target, liveTarget(config, stage))) {
        note(sessionId, `Stage ${stageId} model differs.`);
      }
    }
  }
  if (config !== null) {
    for (const [role, instructions] of Object.entries(freeze.roles)) {
      let current: string[] | null = null;
      try {
        current = loadRoleInstructions(config, role);
      } catch (error) {
        if (!(error instanceof ConfigurationError)) throw error;
      }
      if (current === null || !sameList(current, instructions)) {
        note(sessionId, `Role ${role} instructions differ.`);
      }
    }
  }
}

function liveTarget(config: Record<string, unknown>, stage: StageSpec): StageTarget | null {
  try {
    return resolveStageSpec(config, stage);
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

function note(sessionId: string, detail: string): void {
  log(`session ${sessionId} is using its frozen workflow. ${detail}`);
}

function sameTarget(frozen: StageTarget, live: StageTarget | null): boolean {
  if (live === null) return false;
  return frozen.provider === live.provider && frozen.model === live.model && sameMap(frozen.options, live.options);
}

function sameMap(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.every((key) => left[key] === right[key]);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function workflowMapping(workflow: WorkflowDocument): Record<string, unknown> {
  return {
    schema_version: 1,
    id: workflow.id,
    constraints: workflow.constraints,
    stages: Object.values(workflow.stages).map(stageMapping),
    completion: workflow.completion === null ? null : completionMapping(workflow.completion),
    requires:
      workflow.requires === null
        ? null
        : { workflow: workflow.requires.workflow, decision: workflow.requires.decision },
  };
}

function stageMapping(stage: StageSpec): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    id: stage.id,
    role: stage.role,
    depends_on: stage.dependsOn,
  };
  if (stage.instructions.length > 0) mapped.instructions = stage.instructions;
  if (stage.artifact !== null) mapped.produces = { artifact: stage.artifact };
  if (stage.decisionValues.length > 0) mapped.decision = { values: stage.decisionValues, routes: stage.routes };
  if (stage.modelName !== null) mapped.model = stage.modelName;
  if (Object.keys(stage.options).length > 0) mapped.options = stage.options;
  if (stage.maxRevisions !== null) mapped.max_revisions = stage.maxRevisions;
  if (stage.resumeFrom !== null) mapped.session = { resume_from: stage.resumeFrom };
  if (stage.verify.length > 0) {
    mapped.verify = stage.verify;
    if (stage.maxVerify !== 3) mapped.max_verify = stage.maxVerify;
    if (stage.verifyTimeoutSec !== null) mapped.verify_timeout = stage.verifyTimeoutSec;
  }
  return mapped;
}

function completionMapping(completion: WorkflowCompletion): Record<string, unknown> {
  return {
    stage: completion.stage,
    decision: completion.decision,
    outputs: completion.outputs.map((output) => ({
      name: output.name,
      from_stage: output.fromStage,
      artifact: output.artifact,
    })),
  };
}

function roleNames(workflow: WorkflowDocument): string[] {
  const names: string[] = [];
  for (const stage of Object.values(workflow.stages)) {
    if (!names.includes(stage.role)) names.push(stage.role);
  }
  return names;
}

function readRoles(value: unknown, filePath: string): Record<string, string[]> {
  if (!isRecord(value)) throw corrupt(filePath, "roles must be a mapping");
  const roles: Record<string, string[]> = {};
  for (const [role, raw] of Object.entries(value)) {
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
      throw corrupt(filePath, `roles.${role} must be a list of strings`);
    }
    roles[role] = [...raw];
  }
  return roles;
}

function readTargets(value: unknown, filePath: string): Record<string, StageTarget> {
  if (!isRecord(value)) throw corrupt(filePath, "targets must be a mapping");
  const targets: Record<string, StageTarget> = {};
  for (const [stageId, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.provider !== "string" || typeof raw.model !== "string") {
      throw corrupt(filePath, `targets.${stageId} must name a provider and model`);
    }
    if (raw.provider.trim() === "" || raw.model.trim() === "") {
      throw corrupt(filePath, `targets.${stageId} must name a provider and model`);
    }
    targets[stageId] = {
      provider: raw.provider,
      model: raw.model,
      options: readOptionStrings(raw.options, filePath, stageId),
    };
  }
  return targets;
}

function readOptionStrings(value: unknown, filePath: string, stageId: string): Record<string, string> {
  if (value == null) return {};
  if (!isRecord(value)) throw corrupt(filePath, `targets.${stageId}.options must be a mapping`);
  const options: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw corrupt(filePath, `targets.${stageId}.options.${key} must be a string`);
    options[key] = item;
  }
  return options;
}

function workflowFile(workspace: string, workflowPath: string): string {
  return path.isAbsolute(workflowPath) ? workflowPath : path.join(workspace, workflowPath);
}

function sourceFileHash(source: string | null): string | null {
  if (!source) return null;
  try {
    return sha256(readFileSync(source));
  } catch {
    return null;
  }
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function corrupt(filePath: string, message: string): never {
  throw new ConfigurationError(`Workflow freeze is corrupt: ${filePath} (${message}).`);
}
