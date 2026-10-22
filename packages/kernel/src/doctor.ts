import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import type { ProviderInfo } from "./provider-contract.js";
import {
  loadModelTarget,
  loadRoleInstructions,
  loadYamlMapping,
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
}

const checkSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  items: z.array(z.string()),
  problems: z.array(z.string()),
});

export interface DiagnoseOptions {
  providers: Readonly<Record<string, ProviderInfo>>;
  which?: (command: string) => string | null;
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
  const configResult = checkConfig(workspace, options.providers);
  const workflowCheck = checkWorkflows(
    workspace,
    options.providers,
    configResult.problems,
    configResult.config,
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
): {
  check: Check;
  executableByProvider: Record<string, string>;
  problems: string[];
  config: Record<string, unknown> | null;
} {
  let config: Record<string, unknown>;
  try {
    config = loadYamlMapping(path.join(workspace, ".migent", "config.yaml"));
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return {
      check: failed("config", [error.message]),
      executableByProvider: {},
      problems: [error.message],
      config: null,
    };
  }

  const problems: string[] = [];
  const executableByProvider: Record<string, string> = {};
  let models: Record<string, unknown>;
  let roles: Record<string, unknown>;
  if (!isRecord(config.models)) {
    problems.push("Missing or invalid models.");
    models = {};
  } else {
    models = config.models;
    if (Object.keys(models).length === 0) problems.push("models is empty.");
  }
  if (!isRecord(config.roles)) {
    problems.push("Missing or invalid roles.");
    roles = {};
  } else {
    roles = config.roles;
    if (Object.keys(roles).length === 0) problems.push("roles is empty.");
  }

  for (const modelName of Object.keys(models).sort()) {
    let target;
    try {
      target = loadModelTarget(config, modelName);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      add(problems, error.message);
      continue;
    }
    const provider = providers[target.provider];
    if (provider === undefined) {
      add(problems, `models.${modelName}.provider is not supported: ${target.provider}`);
      continue;
    }
    if (!Object.hasOwn(executableByProvider, target.provider)) {
      executableByProvider[target.provider] = provider.command;
    }
    if (target.client !== undefined) {
      try {
        if (provider.withClient === undefined) throw new Error(`${target.provider} cannot switch CLI client.`);
        provider.withClient(target.client);
      } catch (error) {
        add(problems, `models.${modelName}.client is not supported: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    rejectOptions(problems, `models.${modelName}.options`, provider, target.options);
  }

  const roleNames: string[] = [];
  for (const roleKey of Object.keys(roles).sort()) {
    let resolved;
    try {
      resolved = resolveRoleTarget(workspace, roleKey);
      loadRoleInstructions(config, roleKey);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      add(problems, error.message);
      continue;
    }
    const roleProvider = providers[resolved.provider];
    if (roleProvider !== undefined) {
      rejectOptions(problems, `roles.${roleKey}`, roleProvider, resolved.options);
    }
    roleNames.push(roleKey);
  }

  if (problems.length > 0) {
    return { check: failed("config", problems), executableByProvider, problems, config };
  }
  return {
    check: passed("config", roleNames),
    executableByProvider,
    problems: [],
    config,
  };
}

function checkWorkflows(
  workspace: string,
  providers: Readonly<Record<string, ProviderInfo>>,
  configProblems: readonly string[],
  config: Record<string, unknown> | null,
): Check {
  const catalog = loadWorkflowCatalog(workspace);
  const problems = [...catalog.problems];
  const known = new Set(configProblems);
  if (config !== null) {
    for (const document of Object.values(catalog.documents)) {
      checkStageBindings(config, document, providers, known, problems);
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
  problems: string[],
): void {
  for (const stage of Object.values(document.stages)) {
    if (!isRoleStage(stage)) continue;
    let target;
    try {
      target = resolveStageSpec(config, stage);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      if (known.has(error.message)) continue;
      add(problems, `${document.id}.${stage.id}: ${error.message}`);
      continue;
    }
    const provider = providers[target.provider];
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

function passed(name: string, items: readonly string[]): Check {
  return checkSchema.parse({ name, ok: true, items: [...items], problems: [] });
}

function failed(name: string, problems: readonly string[], items: readonly string[] = []): Check {
  return checkSchema.parse({ name, ok: false, items: [...items], problems: [...problems] });
}

function add(problems: string[], message: string): void {
  if (!problems.includes(message)) problems.push(message);
}
