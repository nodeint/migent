import { ConfigurationError, loadRoleResponsibilities, loadWorkspaceConfig, resolveEffectiveClient, resolveStageSpec, whichSync, type ClientInfo, type ClientRegistry, type StageTarget } from "@nodeint/migent-kernel";
import { collectFrozenDrift, type SessionSelection, type SessionSource, type WorkflowFreeze } from "@nodeint/migent-session";
import { isRoleStage, type RoleStageSpec, type WorkflowDocument } from "@nodeint/migent-workflow";
import { addUnique, makeCheck, type Check, type DiagnoseOptions } from "./check.js";
import { failureText } from "./clients.js";
import { optionalArtifactMappings } from "./artifact-notes.js";
import { stageAgentKey } from "./stage-agents.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface SessionDiagnosis {
  ok: boolean;
  source: SessionSource | null;
  checks: Check[];
}

/** `modelEffortChecks` only matter for live sources; `sessionEffortKeys` names the aliases to check. */
export type DiagnoseSessionOptions = DiagnoseOptions;

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
    const key = modelKey(config, stage, selection.document.id);
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
      options.clients,
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
  const record = (target: StageTarget, effective: ClientInfo, stageId: string): void => {
    const name = target.client;
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
  const clientsCheck = checkExecutables(executables, which);
  return finish(source, [sessionCheck, workflowCheck, bindingsCheck, clientsCheck]);
}

function checkFrozenBindings(
  freeze: WorkflowFreeze,
  stages: readonly RoleStageSpec[],
  workflowId: string,
  options: DiagnoseSessionOptions,
  problems: string[],
  record: (target: StageTarget, effective: ClientInfo, stageId: string) => void,
): void {
  for (const stage of stages) {
    const where = `${workflowId}.${stage.id}`;
    if (!Object.hasOwn(freeze.roles, stage.role)) {
      addUnique(problems, `${where}: workflow.frozen.yaml pins no instructions for role ${stage.role}.`);
    }
    const target = Object.hasOwn(freeze.targets, stage.id) ? freeze.targets[stage.id] : undefined;
    if (target === undefined) {
      addUnique(problems, `${where}: workflow.frozen.yaml pins no target for stage ${stage.id}.`);
      continue;
    }
    const effective = effectiveClient(options.clients, target, `targets.${stage.id}`, where, problems, true);
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
  record: (target: StageTarget, effective: ClientInfo, stageId: string) => void,
): void {
  let config: Record<string, unknown>;
  try {
    config = loadWorkspaceConfig(workspace);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    addUnique(problems, error.message);
    return;
  }
  const efforts = options.modelEffortChecks ?? {};
  const reportedRoles = new Set<string>();
  for (const stage of stages) {
    const where = `${workflowId}.${stage.id}`;
    if (!reportedRoles.has(stage.role)) {
      reportedRoles.add(stage.role);
      try {
        loadRoleResponsibilities(config, stage.role);
      } catch (error) {
        if (!(error instanceof ConfigurationError)) throw error;
        addUnique(problems, `${where}: ${error.message}`);
      }
    }
    const key = modelKey(config, stage, workflowId);
    const effort = key === null ? undefined : efforts[key];
    if (effort?.warning) addUnique(warnings, effort.warning);
    if (effort?.problem) {
      addUnique(problems, `${where}: ${effort.problem}`);
      continue;
    }
    if (key !== null && isRecord(config.agents) && isRecord(config.agents[key]) && Object.keys(config.agents[key]).length === 0) {
      addUnique(problems, `${where}: agents.${key} has no client and model on this machine. Map it in .migent/config.local.yaml.`);
      continue;
    }
    let target: StageTarget;
    try {
      target = resolveStageSpec(config, stage, undefined, options.clients);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      addUnique(problems, `${where}: ${error.message}`);
      continue;
    }
    const field = stage.agent !== null ? `stages.${stage.id}.agent` : `roles.${stage.role}.agent`;
    const effective = effectiveClient(options.clients, target, field, where, problems);
    if (effective !== null) record(target, effective, stage.id);
  }
}

/** Binds the target to its client, reporting a failure as `where: field…`. */
function effectiveClient(
  clients: ClientRegistry,
  target: StageTarget,
  field: string,
  where: string,
  problems: string[],
  flat = false,
): ClientInfo | null {
  const bound = resolveEffectiveClient(clients, target);
  if (bound.failure !== undefined) {
    addUnique(problems, `${where}: ${failureText(field, bound.failure, flat)}`);
    return null;
  }
  return bound.client ?? null;
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
  return makeCheck("clients", items, problems, []);
}

/** The key an effort check is stored under: an agent name, or the role's inline agent field. */
function modelKey(config: Record<string, unknown>, stage: RoleStageSpec, workflowId: string): string | null {
  if (stage.agent !== null) return stage.agent.kind === "named" ? stage.agent.name : stageAgentKey(workflowId, stage.id);
  const role = isRecord(config.roles) ? config.roles[stage.role] : undefined;
  if (!isRecord(role)) return null;
  if (typeof role.agent === "string") return role.agent;
  if (isRecord(role.agent)) return `roles.${stage.role}.agent`;
  return null;
}

function authoringWarnings(document: WorkflowDocument, label: string): string[] {
  return [
    ...(document.warnings ?? []),
    ...optionalArtifactMappings(document).map((item) => item.message),
  ].map((message) => `${label}: ${message}`);
}

function finish(source: SessionSource | null, checks: Check[]): SessionDiagnosis {
  return { ok: checks.every((check) => check.ok), source, checks };
}
