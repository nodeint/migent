import path from "node:path";
import {
  ConfigurationError,
  createProviderResolver,
  isRoleStage,
  loadWorkflowCatalog,
  resolveStageSpec,
  whichSync,
  type ProviderInfo,
  type WorkflowDocument,
} from "@nodeint/migent-kernel";
import {
  DiagnosticList,
  identityKey,
  failed,
  passed,
  type Check,
  type DiagnoseOptions,
  type ModelEffortCheck,
} from "./check.js";
import { checkConfig } from "./config-check.js";
import { withTargetClient } from "./providers.js";
import { stageAgentKey } from "./stage-agents.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The static and PATH checks: config, workflows, providers. Never reads model catalogs. */
export function diagnose(workspace: string, options: DiagnoseOptions): [Check, Check, Check] {
  const which = options.which ?? whichSync;
  const efforts = options.modelEffortChecks ?? {};
  const configResult = checkConfig(workspace, options.providers, efforts);
  const workflowCheck = checkWorkflows(
    workspace,
    options.providers,
    configResult.diagnostics,
    configResult.config,
    configResult.unmapped,
    new Set(Object.keys(efforts).filter((key) => efforts[key]?.problem)),
    efforts,
  );
  const providerCheck = checkProviders(
    configResult.executableByProvider,
    configResult.diagnostics.errors.length,
    which,
  );
  return [configResult.check, workflowCheck, providerCheck];
}

function checkWorkflows(
  workspace: string,
  providers: Readonly<Record<string, ProviderInfo>>,
  configDiagnostics: DiagnosticList,
  config: Record<string, unknown> | null,
  unmapped: ReadonlySet<string>,
  invalidEffort: ReadonlySet<string>,
  efforts: Readonly<Record<string, ModelEffortCheck>>,
): Check {
  const catalog = loadWorkflowCatalog(workspace);
  const problems = [...catalog.problems];
  const failedWorkflows = new Set<string>();
  const stageWarnings: string[] = [];
  if (config !== null) {
    // A stage finding the config check already reported is the same root cause: report it once.
    const known = new Set(configDiagnostics.errors.map(identityKey));
    const knownOptionReasons = new Set(configDiagnostics.errors.flatMap((item) => (item.detail === undefined ? [] : [item.detail])));
    for (const document of Object.values(catalog.documents)) {
      checkStageBindings(config, document, providers, known, knownOptionReasons, unmapped, invalidEffort, efforts, problems, stageWarnings, failedWorkflows);
    }
  }
  const items = Object.keys(catalog.documents).filter((workflowId) => !workflowFailed(workflowId, catalog.problems, failedWorkflows));
  const warnings = [...Object.values(catalog.documents).flatMap(workflowWarnings), ...stageWarnings];
  if (problems.length > 0) return failed("workflows", problems, items, warnings);
  return passed("workflows", items, warnings);
}

/** Parse-time unknown keys in the workflow. */
function workflowWarnings(document: WorkflowDocument): string[] {
  const label = document.source === null ? document.id : path.basename(document.source);
  return [...(document.warnings ?? [])].map((message) => `${label}: ${message}`);
}

function checkStageBindings(
  config: Record<string, unknown>,
  document: WorkflowDocument,
  providers: Readonly<Record<string, ProviderInfo>>,
  known: ReadonlySet<string>,
  knownOptionReasons: ReadonlySet<string>,
  unmapped: ReadonlySet<string>,
  invalidEffort: ReadonlySet<string>,
  efforts: Readonly<Record<string, ModelEffortCheck>>,
  problems: string[],
  warnings: string[],
  failedWorkflows: Set<string>,
): void {
  const report = (stageId: string, message: string): void => {
    const text = `${document.id}.${stageId}: ${message}`;
    if (!problems.includes(text)) problems.push(text);
    failedWorkflows.add(document.id);
  };
  for (const stage of Object.values(document.stages)) {
    if (!isRoleStage(stage)) continue;
    const role = isRecord(config.roles) ? config.roles[stage.role] : undefined;
    const alias = stage.agent !== null
      ? (stage.agent.kind === "named" ? stage.agent.name : undefined)
      : (isRecord(role) ? role.agent : undefined);
    if (stage.agent === null && invalidEffort.has(`roles.${stage.role}.agent`)) continue;
    if (typeof alias === "string" && invalidEffort.has(alias)) continue;
    if (stage.agent?.kind === "inline") {
      // An inline stage agent is checked like a named one: its model and effort against the catalog.
      const check = efforts[stageAgentKey(document.id, stage.id)];
      if (check?.warning && !warnings.includes(check.warning)) warnings.push(check.warning);
      if (check?.problem) {
        report(stage.id, check.problem);
        continue;
      }
    }
    let target;
    try {
      target = resolveStageSpec(config, stage, undefined, createProviderResolver(providers));
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      const identity = { code: error.code ?? "config-invalid", ...(error.path === undefined ? {} : { path: error.path }), message: error.message };
      if (known.has(identityKey(identity))) continue;
      // An unmapped alias is reported once, by the config check.
      if (error.path?.[0] === "agents" && typeof error.path[1] === "string" && unmapped.has(error.path[1])) continue;
      report(stage.id, error.message);
      continue;
    }
    const provider = withTargetClient(providers[target.provider], target.client);
    if (provider === undefined) continue;
    try {
      provider.validateOptions(target.options);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (knownOptionReasons.has(error.message)) continue;
      report(stage.id, error.message);
    }
  }
}

/**
 * A workflow is out of the list when the catalog named it in a problem (its text starts with the
 * workflow id) or one of its stage bindings failed.
 */
function workflowFailed(workflowId: string, catalogProblems: readonly string[], failedBindings: ReadonlySet<string>): boolean {
  if (failedBindings.has(workflowId)) return true;
  const prefix = `${workflowId}:`;
  const stagePrefix = `${workflowId}.`;
  return catalogProblems.some((problem) => problem.startsWith(prefix) || problem.startsWith(stagePrefix));
}

function checkProviders(
  executableByProvider: Readonly<Record<string, string>>,
  configProblemCount: number,
  which: (command: string) => string | null,
): Check {
  const providers = Object.keys(executableByProvider);
  if (providers.length === 0) {
    const problem = configProblemCount > 0 ? "No providers could be resolved from config." : "Config names no providers.";
    return failed("providers", [problem]);
  }
  const items: string[] = [];
  const problems: string[] = [];
  for (const provider of providers.sort()) {
    const command = executableByProvider[provider] ?? "";
    const found = which(command);
    if (found) items.push(`${provider}  ${found}`);
    else problems.push(`${command} is not on PATH`);
  }
  if (problems.length > 0) return failed("providers", problems, items);
  return passed("providers", items);
}
