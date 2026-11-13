import { type ClientInfo, type ClientRegistry, ConfigurationError, loadRoleResponsibilities, loadWorkspaceConfig, resolveEffectiveClient, resolveStageSpec, type StageTarget,whichSync } from '@nodeint/migent-kernel';
import { collectFrozenDrift, type SessionSelection, type SessionSource, type WorkflowFreeze } from '@nodeint/migent-session';
import { isRoleStage, type RoleStageSpec, type WorkflowDocument } from '@nodeint/migent-workflow';

import { optionalArtifactMappings } from './artifact-notes.js';
import { addUnique, type Check, type DiagnoseOptions,makeCheck } from './check.js';
import { failureText } from './clients.js';
import { analyzeNativeOptions } from './native-options.js';
import { stageAgentKey } from './stage-agents.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
  const {source} = selection;
  const sessionCheck = buildSessionCheck(selection);
  const {document} = selection;
  if (document === null) return finish(source, [sessionCheck]); // Nothing further can be checked.

  const label = source === null ? document.id : source.path;
  const workflowProblems: string[] = [];
  if (Object.keys(document.stages).length === 0) workflowProblems.push(`${document.id}: declares no stages.`);
  const workflowWarnings = authoringWarnings(document, label);
  const drift = frozenDrift(workspace, selection, options);
  const workflowCheck = makeCheck('workflow', { items: [document.id], problems: workflowProblems, warnings: [...workflowWarnings, ...drift] });
  if (workflowProblems.length > 0) return finish(source, [sessionCheck, workflowCheck]);

  const { bindingsCheck, executables } = checkBindings(workspace, { selection, document, options });
  const clientsCheck = checkExecutables(executables, which);
  return finish(source, [sessionCheck, workflowCheck, bindingsCheck, clientsCheck]);
}

function buildSessionCheck(selection: SessionSelection): Check {
  const {source} = selection;
  const sessionCheck = makeCheck('session', { items: [], problems: [...selection.problems], warnings: [...selection.warnings] });
  sessionCheck.items.push(`session  ${selection.sessionId}`);
  if (source !== null) {
    if (source.workflowId !== null) sessionCheck.items.push(`workflow  ${source.workflowId}`);
    sessionCheck.items.push(`source  ${source.kind}  ${source.path}`);
  }
  return sessionCheck;
}

/** How a frozen session's workflow differs from the live files; empty for live sessions. */
function frozenDrift(workspace: string, selection: SessionSelection, options: DiagnoseSessionOptions): string[] {
  if (selection.freeze === null) return [];
  return collectFrozenDrift(
    workspace,
    selection.freeze,
    {
      workflowPath: selection.workflowPath,
      workflowId: selection.manifestWorkflowId,
      resolveClient: options.clients,
      quiet: true,
    },
  ).map((detail) => `Frozen workflow differs from the live files: ${detail}`);
}

type Executables = Map<string, { labels: Set<string>; stages: string[] }>;

/** Binds every role stage, from the freeze or live config, and groups the resolved clients by executable. */
function checkBindings(
  workspace: string,
  input: { selection: SessionSelection; document: WorkflowDocument; options: DiagnoseSessionOptions },
): { bindingsCheck: Check; executables: Executables } {
  const { selection, document, options } = input;
  const stages = Object.values(document.stages).filter(isRoleStage);
  const bindingItems: string[] = [];
  const bindingProblems: string[] = [];
  const bindingWarnings: string[] = [];
  const executables: Executables = new Map();
  const record = (target: StageTarget, effective: ClientInfo, stageId: string): void => {
    const name = target.client;
    const entry = executables.get(effective.command) ?? { labels: new Set<string>(), stages: [] };
    entry.labels.add(name);
    entry.stages.push(stageId);
    executables.set(effective.command, entry);
    bindingItems.push(`${stageId}  ${name}  ${target.model}`);
  };

  if (selection.freeze !== null) {
    checkFrozenBindings(
      selection.freeze,
      { stages, workflowId: document.id, options, problems: bindingProblems, warnings: bindingWarnings, record },
    );
  } else {
    checkLiveBindings(
      workspace,
      { stages, workflowId: document.id, options, problems: bindingProblems, warnings: bindingWarnings, record },
    );
  }
  const bindingsCheck = makeCheck('bindings', { items: bindingItems, problems: bindingProblems, warnings: bindingWarnings });
  return { bindingsCheck, executables };
}

/** The stages of one workflow, and where their binding findings and resolved clients go. */
interface BindingScope {
  readonly stages: readonly RoleStageSpec[];
  readonly workflowId: string;
  readonly options: DiagnoseSessionOptions;
  readonly problems: string[];
  readonly warnings: string[];
  readonly record: (target: StageTarget, effective: ClientInfo, stageId: string) => void;
}

function checkFrozenBindings(freeze: WorkflowFreeze, scope: BindingScope): void {
  const { stages, workflowId, options, problems, record } = scope;
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
    const effective = effectiveClient(options.clients, target, { field: `targets.${stage.id}`, where, problems, flat: true });
    if (effective !== null) {
      // The frozen options are what the run sends.
      reportNativeOptions(effective, target, { where, options, problems, warnings: scope.warnings });
      record(target, effective, stage.id);
    }
  }
}

type LiveScope = BindingScope;

function checkLiveBindings(workspace: string, scope: LiveScope): void {
  let config: Record<string, unknown>;
  try {
    config = loadWorkspaceConfig(workspace);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    addUnique(scope.problems, error.message);
    return;
  }
  const reportedRoles = new Set<string>();
  for (const stage of scope.stages) {
    if (!reportedRoles.has(stage.role)) {
      reportedRoles.add(stage.role);
      checkRoleResponsibilities(config, stage, scope);
    }
    checkLiveStage(config, stage, scope);
  }
}

/** Reports a role whose responsibilities cannot be loaded, once per role. */
function checkRoleResponsibilities(config: Record<string, unknown>, stage: RoleStageSpec, scope: LiveScope): void {
  try {
    loadRoleResponsibilities(config, stage.role);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    addUnique(scope.problems, `${scope.workflowId}.${stage.id}: ${error.message}`);
  }
}

/** `session.on_expired` does nothing without a resume policy that can apply. */
function warnUnusedOnExpired(config: Record<string, unknown>, stage: RoleStageSpec, scope: LiveScope): void {
  const policies = config.resume_policies;
  if (stage.onExpired === null || (isRecord(policies) && Object.keys(policies).length > 0)) return;
  addUnique(scope.warnings, `${scope.workflowId}.${stage.id}: session.on_expired has no effect: no resume_policies are configured.`);
}

function isUnmappedAgent(config: Record<string, unknown>, key: string | null): key is string {
  return key !== null && isRecord(config.agents) && isRecord(config.agents[key])
    && Object.keys(config.agents[key]).length === 0;
}

/** Resolves one stage against live config and records its client, reporting the first fault. */
function checkLiveStage(config: Record<string, unknown>, stage: RoleStageSpec, scope: LiveScope): void {
  const { workflowId, options, problems, warnings, record } = scope;
  const where = `${workflowId}.${stage.id}`;
  const key = modelKey(config, stage, workflowId);
  warnUnusedOnExpired(config, stage, scope);
  const effort = key === null ? undefined : (options.modelEffortChecks ?? {})[key];
  if (effort?.warning) addUnique(warnings, effort.warning);
  if (effort?.problem) {
    addUnique(problems, `${where}: ${effort.problem}`);
    return;
  }
  if (isUnmappedAgent(config, key)) {
    addUnique(problems, `${where}: agents.${key} has no client and model on this machine. Map it in .migent/config.local.yaml.`);
    return;
  }
  let target: StageTarget;
  try {
    target = resolveStageSpec(config, stage, { registry: options.clients });
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    addUnique(problems, `${where}: ${error.message}`);
    return;
  }
  const field = stage.agent !== null ? `stages.${stage.id}.agent` : `roles.${stage.role}.agent`;
  const effective = effectiveClient(options.clients, target, { field, where, problems });
  if (effective !== null) {
    reportNativeOptions(effective, target, { where, options, problems, warnings });
    record(target, effective, stage.id);
  }
}

/** Reports what the client's help says about the target's effective options. */
function reportNativeOptions(
  client: ClientInfo,
  target: StageTarget,
  report: { where: string; options: DiagnoseSessionOptions; problems: string[]; warnings: string[] },
): void {
  const { where, options, problems, warnings } = report;
  for (const finding of analyzeNativeOptions(client, target.options, options.nativeOptionFacts)) {
    addUnique(finding.severity === 'error' ? problems : warnings, `${where}: ${finding.message}`);
  }
}

/** Binds the target to its client, reporting a failure as `where: field…`. */
function effectiveClient(
  clients: ClientRegistry,
  target: StageTarget,
  report: { field: string; where: string; problems: string[]; flat?: boolean },
): ClientInfo | null {
  const { field, where, problems, flat = false } = report;
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
  const ordered = [...executables].sort(([left], [right]) => Number(left > right) - Number(left < right));
  for (const [command, entry] of ordered) {
    const found = which(command);
    if (found) items.push(`${[...entry.labels].sort().join(', ')}  ${found}`);
    else problems.push(`${command} is not on PATH (stages: ${entry.stages.join(', ')})`);
  }
  return makeCheck('clients', { items, problems, warnings: [] });
}

/** The key an effort check is stored under: an agent name, or the role's inline agent field. */
function modelKey(config: Record<string, unknown>, stage: RoleStageSpec, workflowId: string): string | null {
  if (stage.agent !== null) return stage.agent.kind === 'named' ? stage.agent.name : stageAgentKey(workflowId, stage.id);
  const role = isRecord(config.roles) ? config.roles[stage.role] : undefined;
  if (!isRecord(role)) return null;
  if (typeof role.agent === 'string') return role.agent;
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
