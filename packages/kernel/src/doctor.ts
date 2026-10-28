import { createProviderResolver } from "./provider-contract.js";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { z } from "zod";
import type { ProviderInfo } from "./provider-contract.js";
import {
  configuredModels,
  loadModelDefinition,
  loadRoleInstructions,
  hasLocalConfig,
  LOCAL_CONFIG_FILE,
  loadWorkspaceConfig,
  resolveRoleTarget,
  resolveStageSpec,
} from "./config.js";
import { ConfigurationError } from "./errors.js";
import { isRecord } from "./record.js";
import { isRoleStage, loadWorkflowCatalog, type WorkflowDocument } from "./workflow.js";

const require = createRequire(import.meta.url);
const whichModule = require("which") as {
  sync(command: string, options?: { nothrow?: boolean }): string | null;
};

export interface Check {
  name: string;
  ok: boolean;
  items: string[];
  problems: string[];
  warnings: string[];
}

const checkSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  items: z.array(z.string()),
  problems: z.array(z.string()),
  warnings: z.array(z.string()),
});

export interface ModelEffortCheck {
  problem?: string;
  warning?: string;
}

export interface DiagnoseOptions {
  providers: Readonly<Record<string, ProviderInfo>>;
  which?: (command: string) => string | null;
  modelEffortChecks?: Readonly<Record<string, ModelEffortCheck>>;
}

export function whichSync(command: string): string | null {
  const found = whichModule.sync(command, { nothrow: true });
  return found == null || found === "" ? null : found;
}

export function diagnose(
  workspace: string,
  options: DiagnoseOptions,
): [Check, Check, Check] {
  const which = options.which ?? whichSync;
  const configResult = checkConfig(workspace, options.providers, options.modelEffortChecks ?? {});
  const workflowCheck = checkWorkflows(
    workspace,
    options.providers,
    configResult.problems,
    configResult.config,
    configResult.unmapped,
    new Set(Object.keys(options.modelEffortChecks ?? {}).filter((alias) => options.modelEffortChecks?.[alias]?.problem)),
  );
  const providerCheck = checkProviders(
    configResult.executableByProvider,
    configResult.problems,
    which,
  );
  return [configResult.check, workflowCheck, providerCheck];
}

export const doctor = diagnose;

function checkConfig(
  workspace: string,
  providers: Readonly<Record<string, ProviderInfo>>,
  effortChecks: Readonly<Record<string, ModelEffortCheck>>,
): {
  check: Check;
  executableByProvider: Record<string, string>;
  problems: string[];
  config: Record<string, unknown> | null;
  unmapped: ReadonlySet<string>;
} {
  let config: Record<string, unknown>;
  try {
    config = loadWorkspaceConfig(workspace);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return {
      check: failed("config", [error.message], [], trackedLocalConfigWarnings(workspace)),
      executableByProvider: {},
      problems: [error.message],
      config: null,
      unmapped: new Set(),
    };
  }

  const problems: string[] = [];
  const effortWarnings: string[] = [];
  const executableByProvider: Record<string, string> = {};
  let models: Record<string, unknown>;
  let roles: Record<string, unknown>;
  if (config.models === undefined) {
    models = {};
  } else if (!isRecord(config.models)) {
    problems.push("Missing or invalid models.");
    models = {};
  } else {
    models = config.models;
  }
  if (!isRecord(config.roles)) {
    problems.push("Missing or invalid roles.");
    roles = {};
  } else {
    roles = config.roles;
    if (Object.keys(roles).length === 0) problems.push("roles is empty.");
  }

  const unmapped = new Set(
    Object.keys(models).filter((name) => isRecord(models[name]) && Object.keys(models[name]).length === 0),
  );
  if (unmapped.size > 0) add(problems, unmappedMessage([...unmapped].sort()));

  for (const { key: modelName, field, definition } of configuredModels(config).sort((a, b) => a.field.localeCompare(b.field))) {
    if (unmapped.has(modelName)) continue;
    const effortCheck = effortChecks[modelName];
    if (effortCheck?.problem) add(problems, effortCheck.problem);
    if (effortCheck?.warning) effortWarnings.push(effortCheck.warning);
    let modelConfig = definition;
    if (effortCheck?.problem && isRecord(definition)) {
      const { effort: _effort, ...rest } = definition;
      modelConfig = rest;
    }
    let target;
    try {
      target = loadModelDefinition(modelConfig, field, createProviderResolver(providers));
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      add(problems, error.message);
      continue;
    }
    const provider = providers[target.provider];
    if (provider === undefined) {
      add(problems, `${field}.provider is not supported: ${target.provider}`);
      continue;
    }
    if (provider.requiresClient === true && target.client === undefined) {
      add(problems, `${field}.client is required: ${target.provider} has no default CLI client.`);
      continue;
    }
    let effective: ProviderInfo = provider;
    if (target.client !== undefined) {
      try {
        if (provider.withClient === undefined) throw new Error(`${target.provider} cannot switch CLI client.`);
        effective = provider.withClient(target.client);
      } catch (error) {
        add(problems, `${field}.client is not supported: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    if (!Object.hasOwn(executableByProvider, target.provider)) {
      executableByProvider[target.provider] = effective.command;
    }
    rejectOptions(problems, `${field}.options`, effective, target.options);
  }

  const roleNames: string[] = [];
  for (const roleKey of Object.keys(roles).sort()) {
    const role = roles[roleKey];
    if (isRecord(role) && typeof role.default_model === "string" && unmapped.has(role.default_model)) {
      roleNames.push(roleKey);
      continue;
    }
    const effortKey = isRecord(role) && typeof role.default_model === "string"
      ? role.default_model : `roles.${roleKey}.default_model`;
    if (effortChecks[effortKey]?.problem) {
      try { loadRoleInstructions(config, roleKey); } catch (error) {
        if (!(error instanceof ConfigurationError)) throw error;
        add(problems, error.message);
      }
      continue;
    }
    let resolved;
    try {
      resolved = resolveRoleTarget(workspace, roleKey, undefined, createProviderResolver(providers));
      loadRoleInstructions(config, roleKey);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      add(problems, error.message);
      continue;
    }
    const roleProvider = withTargetClient(providers[resolved.provider], resolved.client);
    if (roleProvider !== undefined) {
      rejectOptions(problems, `roles.${roleKey}`, roleProvider, resolved.options);
    }
    roleNames.push(roleKey);
  }

  const warnings = [...trackedLocalConfigWarnings(workspace), ...effortWarnings];
  if (problems.length > 0) {
    return { check: failed("config", problems, [], warnings), executableByProvider, problems, config, unmapped };
  }
  return {
    check: passed("config", roleNames, warnings),
    executableByProvider,
    problems: [],
    config,
    unmapped,
  };
}

function unmappedMessage(aliases: readonly string[]): string {
  const lines = [
    `${aliases.map((alias) => `models.${alias}`).join(", ")} ${aliases.length === 1 ? "has" : "have"} no provider and model on this machine.`,
    `Add ${aliases.length === 1 ? "it" : "them"} to .migent/${LOCAL_CONFIG_FILE}, for example:`,
    "models:",
  ];
  for (const alias of aliases) lines.push(`  ${alias}:`, "    provider: <provider>", "    model: <model>");
  return lines.join("\n");
}

function checkWorkflows(
  workspace: string,
  providers: Readonly<Record<string, ProviderInfo>>,
  configProblems: readonly string[],
  config: Record<string, unknown> | null,
  unmapped: ReadonlySet<string>,
  invalidEffort: ReadonlySet<string>,
): Check {
  const catalog = loadWorkflowCatalog(workspace);
  const problems = [...catalog.problems];
  const known = new Set(configProblems);
  if (config !== null) {
    for (const document of Object.values(catalog.documents)) {
      checkStageBindings(config, document, providers, known, unmapped, invalidEffort, problems);
    }
  }
  const items = Object.keys(catalog.documents).filter((workflowId) => !workflowFailed(workflowId, problems));
  if (problems.length > 0) return failed("workflows", problems, items);
  return passed("workflows", items);
}

function checkStageBindings(
  config: Record<string, unknown>,
  document: WorkflowDocument,
  providers: Readonly<Record<string, ProviderInfo>>,
  known: ReadonlySet<string>,
  unmapped: ReadonlySet<string>,
  invalidEffort: ReadonlySet<string>,
  problems: string[],
): void {
  for (const stage of Object.values(document.stages)) {
    if (!isRoleStage(stage)) continue;
    const role = isRecord(config.roles) ? config.roles[stage.role] : undefined;
    const alias = stage.modelName ?? (isRecord(role) && typeof role.default_model === "string"
      ? role.default_model : `roles.${stage.role}.default_model`);
    if (typeof alias === "string" && invalidEffort.has(alias)) continue;
    let target;
    try {
      target = resolveStageSpec(config, stage, undefined, createProviderResolver(providers));
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      if (known.has(error.message)) continue;
      if ([...unmapped].some((alias) => error.message.includes(`models.${alias}.`))) continue;
      add(problems, `${document.id}.${stage.id}: ${error.message}`);
      continue;
    }
    const provider = withTargetClient(providers[target.provider], target.client);
    if (provider === undefined) continue;
    try {
      provider.validateOptions(target.options);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if ([...known].some((problem) => problem.includes(error.message))) continue;
      add(problems, `${document.id}.${stage.id}: ${error.message}`);
    }
  }
}

/** The provider bound to the target's CLI client; the base provider when no client is named or it cannot switch. */
function withTargetClient(provider: ProviderInfo | undefined, client: string | undefined): ProviderInfo | undefined {
  if (provider === undefined || client === undefined || provider.withClient === undefined) return provider;
  try {
    return provider.withClient(client);
  } catch {
    return provider;
  }
}

function rejectOptions(
  problems: string[],
  label: string,
  provider: ProviderInfo,
  options: Readonly<Record<string, string>>,
): void {
  try {
    provider.validateOptions(options);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    add(problems, `${label}: ${error.message}`);
  }
}

function workflowFailed(workflowId: string, problems: readonly string[]): boolean {
  const prefix = `${workflowId}:`;
  const stagePrefix = `${workflowId}.`;
  return problems.some((problem) => problem.startsWith(prefix) || problem.startsWith(stagePrefix));
}

function checkProviders(
  executableByProvider: Readonly<Record<string, string>>,
  configProblems: readonly string[],
  which: (command: string) => string | null,
): Check {
  const providers = Object.keys(executableByProvider);
  if (providers.length === 0) {
    const problem =
      configProblems.length > 0
        ? "No providers could be resolved from config."
        : "Config names no providers.";
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

function passed(name: string, items: readonly string[], warnings: readonly string[] = []): Check {
  return checkSchema.parse({ name, ok: true, items: [...items], problems: [], warnings: [...warnings] });
}

function failed(
  name: string,
  problems: readonly string[],
  items: readonly string[] = [],
  warnings: readonly string[] = [],
): Check {
  return checkSchema.parse({
    name,
    ok: false,
    items: [...items],
    problems: [...problems],
    warnings: [...warnings],
  });
}

/** Empty unless the local override exists and git tracks it. No git, no repo, or untracked is silent. */
function trackedLocalConfigWarnings(workspace: string): string[] {
  if (!hasLocalConfig(workspace)) return [];
  const relative = `.migent/${LOCAL_CONFIG_FILE}`;
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", relative], {
    cwd: workspace,
    stdio: "ignore",
  });
  if (result.error !== undefined || result.status !== 0) return [];
  return [`${relative} is tracked by git; run git rm --cached ${relative} and keep it ignored.`];
}

function add(problems: string[], message: string): void {
  if (!problems.includes(message)) problems.push(message);
}
