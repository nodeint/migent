import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { loadRoleInstructions, loadWorkspaceConfig, resolveStageSpec, type StageTarget } from "./config.js";
import { whichSync, type Check, type DiagnoseOptions } from "./doctor.js";
import { placeholderWhenWarnings } from "./authoring-diagnostics.js";
import { ConfigurationError } from "./errors.js";
import type { ProviderInfo } from "./provider-contract.js";
import { createProviderResolver } from "./provider-contract.js";
import { isRecord } from "./record.js";
import { readStatusFileState } from "./query.js";
import { readSessionManifest } from "./session-fold.js";
import {
  WORKFLOW_FREEZE_FILE,
  collectFrozenDrift,
  readWorkflowFreeze,
  type WorkflowFreeze,
} from "./session-freeze.js";
import {
  isRoleStage,
  loadNamedWorkflow,
  parseWorkflowMapping,
  type RoleStageSpec,
  type WorkflowDocument,
} from "./workflow.js";
import { parseYamlDocument } from "./yaml.js";

export type SessionWorkflowKind = "draft" | "live" | "frozen";

export interface SessionSource {
  sessionId: string;
  workflowId: string | null;
  kind: SessionWorkflowKind;
  /** Workspace-relative with forward slashes, or absolute when the file lives outside the workspace. */
  path: string;
}

/** Which workflow a session runs, read without writing anything. */
export interface SessionSelection {
  sessionId: string;
  /** Null when no workflow source could be determined. */
  source: SessionSource | null;
  document: WorkflowDocument | null;
  freeze: WorkflowFreeze | null;
  /** Manifest fields the live-drift comparison needs. */
  workflowPath: string | null;
  manifestWorkflowId: string | null;
  problems: string[];
  warnings: string[];
}

export interface SessionDiagnosis {
  ok: boolean;
  source: SessionSource | null;
  checks: Check[];
}

/** `modelEffortChecks` only matter for live sources; `sessionEffortKeys` names the aliases to check. */
export type DiagnoseSessionOptions = DiagnoseOptions;

const SESSION_ID_ERROR = (sessionId: string): string => `Invalid session id: ${sessionId}.`;

/** Rejects ids that could leave `.migent/sessions`. The rule matches the one used for `--prior`. */
export function assertSessionId(sessionId: string): void {
  if (!sessionId || sessionId === "." || sessionId === ".." || /[\\/]/.test(sessionId) || path.isAbsolute(sessionId)) {
    throw new ConfigurationError(SESSION_ID_ERROR(sessionId));
  }
}

/**
 * Pick the workflow the runtime would use: a freeze when the file exists (a corrupt one is a
 * problem, never a reason to fall back), otherwise the recorded live source. Throws only for an
 * invalid id; every other failure is returned as a problem.
 */
export function selectSessionWorkflow(workspace: string, sessionId: string): SessionSelection {
  assertSessionId(sessionId);
  const selection: SessionSelection = {
    sessionId,
    source: null,
    document: null,
    freeze: null,
    workflowPath: null,
    manifestWorkflowId: null,
    problems: [],
    warnings: [],
  };
  const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionId);
  if (!isDirectory(sessionDirectory)) {
    selection.problems.push(`Session not found: ${sessionId}.`);
    return selection;
  }
  const manifestPath = path.join(sessionDirectory, "manifest.yaml");
  if (!isFile(manifestPath)) {
    selection.problems.push(`Session manifest is missing: ${display(workspace, manifestPath)}.`);
    return selection;
  }
  let manifest;
  try {
    manifest = readSessionManifest(sessionDirectory);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    selection.problems.push(error.message);
    return selection;
  }
  selection.workflowPath = manifest.workflowPath;
  selection.manifestWorkflowId = manifest.workflowId;
  if (manifest.workflowId === "agent" || manifest.role !== null) {
    selection.problems.push(`Session ${sessionId} is a role session; it has no workflow to validate.`);
    return selection;
  }

  // Activation writes the freeze before it records the start, so an interrupted one leaves a stale
  // freeze on a session that is still prepared. Activation would re-read the draft, so check that.
  const status = readStatusFileState(path.join(sessionDirectory, "status.json"));
  const prepared = status.state === "ok" && status.status.status === "prepared";
  const freezePath = path.join(sessionDirectory, WORKFLOW_FREEZE_FILE);
  if (existsSync(freezePath) && prepared) {
    selection.warnings.push(`${display(workspace, freezePath)} is left from an interrupted start and is ignored while the session is prepared.`);
  } else if (existsSync(freezePath)) {
    const source: SessionSource = {
      sessionId,
      workflowId: manifest.workflowId,
      kind: "frozen",
      path: display(workspace, freezePath),
    };
    selection.source = source;
    try {
      const freeze = readWorkflowFreeze(sessionDirectory);
      if (freeze === null) {
        selection.problems.push(`Workflow freeze is not a file: ${source.path}.`);
        return selection;
      }
      selection.freeze = freeze;
      selection.document = freeze.workflow;
      source.workflowId = freeze.workflow.id;
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      selection.problems.push(error.message);
    }
    return selection;
  }

  const draftPath = `.migent/sessions/${sessionId}/workflow.yaml`;
  const recorded = manifest.workflowPath;
  if (!recorded && !manifest.workflowId) {
    selection.problems.push(
      `Session manifest names no workflow: ${display(workspace, manifestPath)} has no workflow_id or workflow_path.`,
    );
    return selection;
  }
  const kind: SessionWorkflowKind = recorded === draftPath ? "draft" : "live";
  const filePath = recorded ? (path.isAbsolute(recorded) ? recorded : path.join(workspace, recorded)) : null;
  if (filePath !== null && (kind === "draft" || isFile(filePath))) {
    selection.source = { sessionId, workflowId: manifest.workflowId, kind, path: display(workspace, filePath) };
    try {
      selection.document = loadSessionFile(filePath);
    } catch (error) {
      selection.problems.push(authoringMessage(error));
      return selection;
    }
  } else {
    // The recorded file is gone or unrecorded: the runtime then looks the workflow up by id.
    if (!manifest.workflowId) {
      selection.problems.push(`Workflow file is missing: ${recorded ?? ""}.`);
      return selection;
    }
    if (recorded) selection.warnings.push(`Recorded workflow file ${recorded} is missing; using workflow ${manifest.workflowId} by id.`);
    selection.source = { sessionId, workflowId: manifest.workflowId, kind: "live", path: `.migent/workflows (${manifest.workflowId})` };
    try {
      selection.document = loadNamedWorkflow(workspace, manifest.workflowId, { quiet: true });
    } catch (error) {
      selection.problems.push(authoringMessage(error));
      return selection;
    }
    if (selection.document.source !== null) selection.source.path = display(workspace, selection.document.source);
  }
  const document = selection.document;
  if (document === null) return selection;
  selection.source!.workflowId = document.id;
  if (kind === "draft" && manifest.workflowId && document.id !== manifest.workflowId) {
    selection.problems.push(
      `Session workflow id is ${document.id}, not ${manifest.workflowId}. Do not change id in workflow.yaml.`,
    );
  }
  return selection;
}

/** Model aliases and inline-model fields the session's role stages resolve against live config. */
export function sessionEffortKeys(workspace: string, selection: SessionSelection): Set<string> {
  const keys = new Set<string>();
  if (selection.document === null || selection.freeze !== null) return keys;
  let config: Record<string, unknown>;
  try {
    config = loadWorkspaceConfig(workspace);
  } catch {
    return keys;
  }
  for (const stage of Object.values(selection.document.stages)) {
    if (!isRoleStage(stage)) continue;
    const key = modelKey(config, stage);
    if (key !== null) keys.add(key);
  }
  return keys;
}

export function diagnoseSession(
  workspace: string,
  selection: SessionSelection,
  options: DiagnoseSessionOptions,
): SessionDiagnosis {
  const which = options.which ?? whichSync;
  const source = selection.source;
  const sessionCheck = makeCheck("session", [], [...selection.problems], [...selection.warnings]);
  sessionCheck.items.push(`session  ${selection.sessionId}`);
  if (source !== null) {
    if (source.workflowId !== null) sessionCheck.items.push(`workflow  ${source.workflowId}`);
    sessionCheck.items.push(`source  ${source.kind}  ${source.path}`);
  }
  const document = selection.document;
  if (document === null) return finish(source, [sessionCheck]); // Nothing further can be checked.

  const label = source === null ? document.id : source.path;
  const workflowProblems: string[] = [];
  if (Object.keys(document.stages).length === 0) workflowProblems.push(`${document.id}: declares no stages.`);
  const workflowWarnings = authoringWarnings(document, label);
  let drift: string[] = [];
  if (selection.freeze !== null) {
    drift = collectFrozenDrift(
      workspace,
      selection.freeze,
      selection.workflowPath,
      selection.manifestWorkflowId,
      createProviderResolver(options.providers),
      true,
    ).map((detail) => `Frozen workflow differs from the live files: ${detail}`);
  }
  const stages = Object.values(document.stages).filter(isRoleStage);
  const workflowCheck = makeCheck("workflow", [document.id], workflowProblems, [...workflowWarnings, ...drift]);
  if (workflowProblems.length > 0) return finish(source, [sessionCheck, workflowCheck]);

  const bindingItems: string[] = [];
  const bindingProblems: string[] = [];
  const bindingWarnings: string[] = [];
  const executables = new Map<string, { labels: Set<string>; stages: string[] }>();
  const record = (target: StageTarget, effective: ProviderInfo, stageId: string): void => {
    const name = target.client === undefined ? target.provider : `${target.provider} (${target.client})`;
    const entry = executables.get(effective.command) ?? { labels: new Set<string>(), stages: [] };
    entry.labels.add(name);
    entry.stages.push(stageId);
    executables.set(effective.command, entry);
    bindingItems.push(`${stageId}  ${name}  ${target.model}`);
  };

  if (selection.freeze !== null) {
    checkFrozenBindings(selection.freeze, stages, document.id, options, bindingProblems, record);
  } else {
    checkLiveBindings(workspace, stages, document.id, options, bindingProblems, bindingWarnings, record);
  }
  const bindingsCheck = makeCheck("bindings", bindingItems, bindingProblems, bindingWarnings);
  const providersCheck = checkExecutables(executables, which);
  return finish(source, [sessionCheck, workflowCheck, bindingsCheck, providersCheck]);
}

function checkFrozenBindings(
  freeze: WorkflowFreeze,
  stages: readonly RoleStageSpec[],
  workflowId: string,
  options: DiagnoseSessionOptions,
  problems: string[],
  record: (target: StageTarget, effective: ProviderInfo, stageId: string) => void,
): void {
  for (const stage of stages) {
    const where = `${workflowId}.${stage.id}`;
    if (!Object.hasOwn(freeze.roles, stage.role)) {
      add(problems, `${where}: workflow.frozen.yaml pins no instructions for role ${stage.role}.`);
    }
    const target = Object.hasOwn(freeze.targets, stage.id) ? freeze.targets[stage.id] : undefined;
    if (target === undefined) {
      add(problems, `${where}: workflow.frozen.yaml pins no target for stage ${stage.id}.`);
      continue;
    }
    const effective = effectiveProvider(options.providers, target, `targets.${stage.id}`, where, problems);
    if (effective !== null) record(target, effective, stage.id);
  }
}

function checkLiveBindings(
  workspace: string,
  stages: readonly RoleStageSpec[],
  workflowId: string,
  options: DiagnoseSessionOptions,
  problems: string[],
  warnings: string[],
  record: (target: StageTarget, effective: ProviderInfo, stageId: string) => void,
): void {
  let config: Record<string, unknown>;
  try {
    config = loadWorkspaceConfig(workspace);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    add(problems, error.message);
    return;
  }
  const efforts = options.modelEffortChecks ?? {};
  const reportedRoles = new Set<string>();
  for (const stage of stages) {
    const where = `${workflowId}.${stage.id}`;
    if (!reportedRoles.has(stage.role)) {
      reportedRoles.add(stage.role);
      try {
        loadRoleInstructions(config, stage.role);
      } catch (error) {
        if (!(error instanceof ConfigurationError)) throw error;
        add(problems, `${where}: ${error.message}`);
      }
    }
    const key = modelKey(config, stage);
    const effort = key === null ? undefined : efforts[key];
    if (effort?.warning) add(warnings, effort.warning);
    if (effort?.problem) {
      add(problems, `${where}: ${effort.problem}`);
      continue;
    }
    if (key !== null && isRecord(config.models) && isRecord(config.models[key]) && Object.keys(config.models[key]).length === 0) {
      add(problems, `${where}: models.${key} has no provider and model on this machine. Map it in .migent/config.local.yaml.`);
      continue;
    }
    let target: StageTarget;
    try {
      target = resolveStageSpec(config, stage, undefined, createProviderResolver(options.providers));
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      add(problems, `${where}: ${error.message}`);
      continue;
    }
    const field = stage.modelName !== null ? `stages.${stage.id}.model` : `roles.${stage.role}.default_model`;
    const effective = effectiveProvider(options.providers, target, field, where, problems);
    if (effective !== null) record(target, effective, stage.id);
  }
}

/** Resolve the provider with its client bound, then validate the target's merged options. */
function effectiveProvider(
  providers: Readonly<Record<string, ProviderInfo>>,
  target: StageTarget,
  field: string,
  where: string,
  problems: string[],
): ProviderInfo | null {
  const provider = Object.hasOwn(providers, target.provider) ? providers[target.provider] : undefined;
  if (provider === undefined) {
    add(problems, `${where}: ${field}.provider is not supported: ${target.provider}`);
    return null;
  }
  if (provider.requiresClient === true && target.client === undefined) {
    add(problems, `${where}: ${field}.client is required: ${target.provider} has no default CLI client.`);
    return null;
  }
  let effective = provider;
  if (target.client !== undefined) {
    try {
      if (provider.withClient === undefined) throw new Error(`${target.provider} cannot switch CLI client.`);
      effective = provider.withClient(target.client);
    } catch (error) {
      add(problems, `${where}: ${field}.client is not supported: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
  try {
    effective.validateOptions(target.options);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    add(problems, `${where}: ${field}.options: ${error.message}`);
    return null;
  }
  return effective;
}

function checkExecutables(
  executables: ReadonlyMap<string, { labels: Set<string>; stages: string[] }>,
  which: (command: string) => string | null,
): Check {
  const items: string[] = [];
  const problems: string[] = [];
  for (const command of [...executables.keys()].sort()) {
    const entry = executables.get(command)!;
    const found = which(command);
    if (found) items.push(`${[...entry.labels].sort().join(", ")}  ${found}`);
    else problems.push(`${command} is not on PATH (stages: ${entry.stages.join(", ")})`);
  }
  return makeCheck("providers", items, problems, []);
}

/** The key an effort check is stored under: a model alias, or the role's inline default_model field. */
function modelKey(config: Record<string, unknown>, stage: RoleStageSpec): string | null {
  if (stage.modelName !== null) return stage.modelName;
  const role = isRecord(config.roles) ? config.roles[stage.role] : undefined;
  if (!isRecord(role)) return null;
  if (typeof role.default_model === "string") return role.default_model;
  if (isRecord(role.default_model)) return `roles.${stage.role}.default_model`;
  return null;
}

function authoringWarnings(document: WorkflowDocument, label: string): string[] {
  const messages = [...(document.warnings ?? [])];
  if (document.source !== null) {
    try {
      const raw = parseYamlDocument(readFileSync(document.source, "utf8"));
      if (isRecord(raw)) messages.push(...placeholderWhenWarnings(raw));
    } catch { /* The loader already reported an unreadable workflow. */ }
  }
  return messages.map((message) => `${label}: ${message}`);
}

/** Same parsing as `loadWorkflowDocument`, without its stderr warnings, plus the empty-workflow rule. */
function loadSessionFile(filePath: string): WorkflowDocument {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`Unable to read workflow: ${filePath} (${reason})`);
  }
  const data = parseYamlDocument(text);
  if (!isRecord(data)) throw new ConfigurationError(`Workflow must be a mapping: ${filePath}`);
  return parseWorkflowMapping(data, filePath);
}

function authoringMessage(error: unknown): string {
  if (error instanceof ConfigurationError) return error.message;
  if (error instanceof ZodError) return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw error;
}

function finish(source: SessionSource | null, checks: Check[]): SessionDiagnosis {
  return { ok: checks.every((check) => check.ok), source, checks };
}

function makeCheck(name: string, items: string[], problems: string[], warnings: string[]): Check {
  return { name, ok: problems.length === 0, items, problems, warnings };
}

function display(workspace: string, target: string): string {
  const relative = path.relative(workspace, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return target;
  return relative.split(path.sep).join("/");
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function add(list: string[], message: string): void {
  if (!list.includes(message)) list.push(message);
}
