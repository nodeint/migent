import path from 'node:path';

import { type ClientRegistry,ConfigurationError, resolveEffectiveClient, resolveStageSpec, whichSync } from '@nodeint/migent-kernel';
import { isRoleStage, loadWorkflowCatalog, type WorkflowDocument } from '@nodeint/migent-workflow';

import { optionalArtifactMappings } from './artifact-notes.js';
import {
  type Check,
  type DiagnoseOptions,
  DiagnosticList,
  failed,
  identityKey,
  type ModelEffortCheck,
  passed,
} from './check.js';
import { checkConfig } from './config-check.js';
import { stageAgentKey } from './stage-agents.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The static and PATH checks: config, workflows, clients. Never reads model catalogs. */
export function diagnose(workspace: string, options: DiagnoseOptions): [Check, Check, Check] {
  const which = options.which ?? whichSync;
  const efforts = options.modelEffortChecks ?? {};
  const configResult = checkConfig(workspace, options.clients, efforts);
  const workflowCheck = checkWorkflows(workspace, {
    clients: options.clients,
    configDiagnostics: configResult.diagnostics,
    config: configResult.config,
    unmapped: configResult.unmapped,
    invalidEffort: new Set(Object.keys(efforts).filter((key) => efforts[key]?.problem)),
    efforts,
  });
  const clientCheck = checkClients(
    configResult.executableByClient,
    configResult.diagnostics.errors.length,
    which,
  );
  return [configResult.check, workflowCheck, clientCheck];
}

/** What the workflow check knows from the config check and the environment. */
interface WorkflowCheckContext {
  readonly clients: ClientRegistry;
  readonly configDiagnostics: DiagnosticList;
  readonly config: Record<string, unknown> | null;
  readonly unmapped: ReadonlySet<string>;
  readonly invalidEffort: ReadonlySet<string>;
  readonly efforts: Readonly<Record<string, ModelEffortCheck>>;
}

/** Where stage-binding findings are collected. */
interface BindingSink {
  readonly problems: string[];
  readonly warnings: string[];
  readonly failedWorkflows: Set<string>;
}

function checkWorkflows(workspace: string, context: WorkflowCheckContext): Check {
  const { configDiagnostics, config } = context;
  const catalog = loadWorkflowCatalog(workspace);
  const problems = [...catalog.problems];
  const failedWorkflows = new Set<string>();
  const stageWarnings: string[] = [];
  if (config !== null) {
    // A stage finding the config check already reported is the same root cause: report it once.
    const known = new Set(configDiagnostics.errors.map(identityKey));
    const knownOptionReasons = new Set(
      configDiagnostics.errors.flatMap((item) => (item.detail === undefined ? [] : [item.detail])),
    );
    for (const document of Object.values(catalog.documents)) {
      checkStageBindings(
        document,
        { ...context, config, known, knownOptionReasons },
        { problems, warnings: stageWarnings, failedWorkflows },
      );
    }
  }
  const items = Object.keys(catalog.documents)
    .filter((workflowId) => !workflowFailed(workflowId, catalog.problems, failedWorkflows));
  const warnings = [...Object.values(catalog.documents).flatMap(workflowWarnings), ...stageWarnings];
  if (problems.length > 0) return failed('workflows', problems, { items, warnings });
  return passed('workflows', items, warnings);
}

/** Parse-time unknown keys in the workflow. */
function workflowWarnings(document: WorkflowDocument): string[] {
  const label = document.source === null ? document.id : path.basename(document.source);
  return [
    ...(document.warnings ?? []),
    ...optionalArtifactMappings(document).map((item) => item.message),
  ].map((message) => `${label}: ${message}`);
}

type StageBindingContext = Omit<WorkflowCheckContext, 'config' | 'configDiagnostics'> & {
  readonly config: Record<string, unknown>;
  readonly known: ReadonlySet<string>;
  readonly knownOptionReasons: ReadonlySet<string>;
};

type RoleStage = Parameters<typeof resolveStageSpec>[1];

function checkStageBindings(
  document: WorkflowDocument,
  context: StageBindingContext,
  sink: BindingSink,
): void {
  const { problems, failedWorkflows } = sink;
  for (const stage of Object.values(document.stages)) {
    if (!isRoleStage(stage)) continue;
    const message = stageBindingProblem({ workflowId: document.id, stage }, context, sink.warnings);
    if (message === null) continue;
    const text = `${document.id}.${stage.id}: ${message}`;
    if (!problems.includes(text)) problems.push(text);
    failedWorkflows.add(document.id);
  }
}

/** Whether the stage's agent has an effort the config check already reported as invalid. */
function hasInvalidEffort(
  stage: RoleStage,
  config: Record<string, unknown>,
  invalidEffort: ReadonlySet<string>,
): boolean {
  if (stage.agent === null && invalidEffort.has(`roles.${stage.role}.agent`)) return true;
  const role = isRecord(config.roles) ? config.roles[stage.role] : undefined;
  let alias: unknown;
  if (stage.agent !== null) alias = stage.agent.kind === 'named' ? stage.agent.name : undefined;
  else alias = isRecord(role) ? role.agent : undefined;
  return typeof alias === 'string' && invalidEffort.has(alias);
}

/** Resolves and binds one role stage; returns the problem to report, or null when it binds or is reported elsewhere. */
function stageBindingProblem(
  where: { workflowId: string; stage: RoleStage & { id: string } },
  context: StageBindingContext,
  warnings: string[],
): string | null {
  const { workflowId, stage } = where;
  const { config, clients, knownOptionReasons, invalidEffort, efforts } = context;
  if (hasInvalidEffort(stage, config, invalidEffort)) return null;
  if (stage.agent?.kind === 'inline') {
    // An inline stage agent is checked like a named one: its model and effort against the catalog.
    const check = efforts[stageAgentKey(workflowId, stage.id)];
    if (check?.warning && !warnings.includes(check.warning)) warnings.push(check.warning);
    if (check?.problem) return check.problem;
  }
  let target;
  try {
    target = resolveStageSpec(config, stage, { registry: clients });
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return resolutionProblem(error, context);
  }
  const bound = resolveEffectiveClient(clients, target);
  if (bound.failure === undefined) return null;
  if (bound.failure.code === 'options-invalid' && knownOptionReasons.has(bound.failure.message)) return null;
  return bound.failure.message;
}

/** A resolution error's message, or null when the config check already reports it. */
function resolutionProblem(error: ConfigurationError, context: StageBindingContext): string | null {
  const identity = { code: error.code ?? 'config-invalid', ...(error.path === undefined ? {} : { path: error.path }), message: error.message };
  if (context.known.has(identityKey(identity))) return null;
  // An unmapped alias is reported once, by the config check.
  if (error.path?.[0] === 'agents' && typeof error.path[1] === 'string' && context.unmapped.has(error.path[1])) return null;
  return error.message;
}

/**
 * A workflow is out of the list when the catalog named it in a problem (its text starts with the
 * workflow id) or one of its stage bindings failed.
 */
function workflowFailed(
  workflowId: string,
  catalogProblems: readonly string[],
  failedBindings: ReadonlySet<string>,
): boolean {
  if (failedBindings.has(workflowId)) return true;
  const prefix = `${workflowId}:`;
  const stagePrefix = `${workflowId}.`;
  return catalogProblems.some((problem) => problem.startsWith(prefix) || problem.startsWith(stagePrefix));
}

function checkClients(
  executableByClient: Readonly<Record<string, string>>,
  configProblemCount: number,
  which: (command: string) => string | null,
): Check {
  const clients = Object.keys(executableByClient);
  if (clients.length === 0) {
    const problem = configProblemCount > 0 ? 'No clients could be resolved from config.' : 'Config names no clients.';
    return failed('clients', [problem]);
  }
  const items: string[] = [];
  const problems: string[] = [];
  for (const client of clients.sort()) {
    const command = executableByClient[client] ?? '';
    const found = which(command);
    if (found) items.push(`${client}  ${found}`);
    else problems.push(`${command} is not on PATH`);
  }
  if (problems.length > 0) return failed('clients', problems, { items });
  return passed('clients', items);
}
