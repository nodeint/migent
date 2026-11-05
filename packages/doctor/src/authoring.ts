import {
  ConfigurationError,
  checkDocumentSchemaVersion,
  createProviderResolver,
  isRoleStage,
  mergeConfigLayers,
  parseWorkflowMapping,
  checkWorkflowCatalog,
  loadModelTarget,
  resolveStageSpec,
  type RoleStageSpec,
  type StageTarget,
  unknownWorkflowKeyEntries,
  type ConfigOwner,
  type MergedConfig,
  type WorkflowDocument,
  type ProviderInfo,
} from "@nodeint/migent-kernel";
import { analyzeConfig } from "./config-check.js";
import type { Diagnostic } from "./check.js";
import { withTargetClient } from "./providers.js";

type Providers = Readonly<Record<string, ProviderInfo>>;
type Mapping = Record<string, unknown>;

const isRecord = (value: unknown): value is Mapping =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fromError(error: ConfigurationError, source: Diagnostic["source"], fallbackCode: string): Diagnostic {
  return {
    severity: "error",
    code: error.code ?? fallbackCode,
    message: error.message,
    ...(error.path === undefined ? {} : { path: error.path }),
    ...(source === undefined ? {} : { source }),
    ...(error.position === undefined ? {} : { position: error.position }),
  };
}

function versionDiagnostics(document: Mapping, label: string, source: Diagnostic["source"]): Diagnostic[] {
  const result = checkDocumentSchemaVersion(document);
  const base = { severity: "error" as const, path: ["schema_version"], ...(source === undefined ? {} : { source }) };
  switch (result.status) {
    case "current":
      return [];
    case "invalid":
      return [{ ...base, code: "schema-version-invalid", message: `${label}: ${result.message}` }];
    case "outdated":
      return [{ ...base, code: "schema-outdated", message: `${label}: schema_version is v${result.version}; this Migent uses the current version. Run \`migent migrate\`.` }];
    case "newer":
      return [{ ...base, code: "schema-newer", message: `${label}: schema_version v${result.version} is newer than this Migent supports.` }];
  }
}

export interface ConfigDraftInput {
  /** Which layer the draft replaces. */
  scope: "project" | "local";
  draft: Mapping;
  /** The other layer as it is on disk, or null when absent. */
  companion: Mapping | null;
}

/**
 * Validates an unsaved config layer with the runtime's rules. The draft is merged with the other layer
 * exactly as the runtime would. Findings carry the layer that owns the node (`draft` marks the draft's).
 * A missing project layer (scope local) is the caller's error to report.
 */
export function validateConfigDraft(input: ConfigDraftInput, providers: Providers): Diagnostic[] {
  const out: Diagnostic[] = [];
  out.push(...versionDiagnostics(input.draft, `${input.scope} config`, { layer: input.scope }));
  if (input.companion !== null) {
    const other = input.scope === "project" ? "local" : "project";
    out.push(...versionDiagnostics(input.companion, `${other} config`, { layer: other }));
  }
  const project = input.scope === "project" ? input.draft : input.companion;
  const local = input.scope === "local" ? input.draft : input.companion;
  if (project === null) return out;
  const merged = mergeConfigLayers(project, local);
  const analysis = analyzeConfig(merged.config, providers, {}, merged.ownerOf);
  for (const item of analysis.diagnostics.items) {
    // The alias waits for this machine's mapping; that describes the machine, not the document.
    out.push(item.code === "model-unmapped" ? { ...item, severity: "warning" } : item);
  }
  return out;
}

/** The effective config together with the separate layers it was merged from. */
export interface ConfigLoad extends MergedConfig {
  layers: { project: Mapping; local: Mapping | null };
}

export interface WorkflowDraftInput {
  draft: Mapping;
  /** The basename the draft is (or would be) saved as. */
  file: string;
  /** Sibling workflows already on disk, without the draft's own file. */
  siblings: ReadonlyArray<{ file: string; document: Mapping } | { file: string; error: ConfigurationError }>;
  /** The effective config and its layers, or the error that stopped it loading. */
  config: ConfigLoad | ConfigurationError;
}

function stageIndexOf(draft: Mapping, stageId: string): number | null {
  if (!Array.isArray(draft.stages)) return null;
  const index = draft.stages.findIndex((stage) => isRecord(stage) && stage.id === stageId);
  return index === -1 ? null : index;
}

function ownerSource(owner: ConfigOwner): Diagnostic["source"] {
  return { layer: owner };
}

/** Validates an unsaved workflow against the parser, the catalog rules and the effective config. */
export function validateWorkflowDraft(input: WorkflowDraftInput, providers: Providers): Diagnostic[] {
  const out: Diagnostic[] = [];
  const source = { workflow: input.file };
  out.push(...versionDiagnostics(input.draft, input.file === "" ? "workflow" : input.file, source));
  let document;
  try {
    document = parseWorkflowMapping(input.draft, input.file);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    out.push(fromError(error, source, "workflow-invalid"));
    return dedupe(out);
  }
  if ((document.warnings ?? []).length > 0) {
    for (const entry of unknownWorkflowKeyEntries(input.draft)) {
      out.push({ severity: "warning", code: entry.code, message: entry.message, path: entry.path, source });
    }
  }

  // Siblings go through the same parser and catalog rules the runtime applies to the directory.
  const entries: Array<{ file: string; document: WorkflowDocument }> = [];
  const failedIds = new Set<string>();
  for (const sibling of input.siblings) {
    const sibSource = { workflow: sibling.file };
    let error: ConfigurationError | null = null;
    if ("error" in sibling) {
      error = sibling.error;
    } else {
      try {
        entries.push({ file: sibling.file, document: parseWorkflowMapping(sibling.document, sibling.file) });
      } catch (caught) {
        if (!(caught instanceof ConfigurationError)) throw caught;
        error = caught;
      }
    }
    if (error !== null) {
      failedIds.add(sibling.file.replace(/\.yaml$/, ""));
      out.push({ ...fromError(error, sibSource, "workflow-invalid"), severity: "warning", message: `${sibling.file}: ${error.message}` });
    }
  }
  entries.push({ file: input.file, document });
  const fileOf = (workflowId: string): string | undefined => entries.find((entry) => entry.document.id === workflowId)?.file;
  const draftPaths: Record<string, string> = { "duplicate-id": "id", "unknown-downstream": "downstream", "no-stages": "stages", "requires-invalid": "requires" };
  for (const problem of checkWorkflowCatalog(entries, failedIds).problems) {
    const concerns = problem.workflow === document.id || (problem.files?.includes(input.file) ?? false);
    const where = concerns ? source : { workflow: fileOf(problem.workflow) ?? input.file };
    out.push({
      severity: concerns ? "error" : "warning",
      code: problem.code,
      message: problem.message,
      ...(concerns ? { path: [draftPaths[problem.code] ?? "id"] } : {}),
      source: where,
    });
  }

  if (input.config instanceof ConfigurationError) {
    out.push(fromError(input.config, input.config.layer === undefined ? undefined : { layer: input.config.layer }, "config-invalid"));
    return dedupe(out);
  }
  const { config, ownerOf, layers } = input.config;
  const layerVersions = [
    ...versionDiagnostics(layers.project, "project config", { layer: "project" }),
    ...(layers.local === null ? [] : versionDiagnostics(layers.local, "local config", { layer: "local" })),
  ];
  if (layerVersions.length > 0) return dedupe([...out, ...layerVersions]);
  for (const stage of Object.values(document.stages)) {
    if (!isRoleStage(stage)) continue;
    const index = stageIndexOf(input.draft, stage.id);
    const stagePath = (field: string): (string | number)[] => (index === null ? [] : ["stages", index, field]);
    let target;
    try {
      target = resolveStageSpec(config, stage, undefined, createProviderResolver(providers));
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      const head = error.path?.[0];
      const missingRole = error.code === "missing-or-invalid" && error.path?.join(".") === `roles.${stage.role}`;
      if (head === "stages" || missingRole) {
        // The stage's own reference (its explicit model, or a role that does not exist) is the workflow's to fix.
        const field = missingRole ? "role" : "model";
        out.push({ severity: "error", code: missingRole ? "unknown-role" : (error.code ?? "workflow-invalid"), message: `${document.id}.${stage.id}: ${error.message}`, path: stagePath(field), source });
      } else if (error.path !== undefined) {
        // A fault in the config, including a model inherited from the role's default: the config owns the fix.
        out.push({ severity: "error", code: error.code ?? "config-invalid", message: error.message, path: error.path, source: ownerSource(ownerOf(error.path)) });
      } else {
        out.push({ severity: "error", code: error.code ?? "workflow-invalid", message: `${document.id}.${stage.id}: ${error.message}`, path: stagePath("role"), source });
      }
      continue;
    }
    const failure = optionsFailure(config, stage, target, providers);
    if (failure === null) continue;
    if (failure.path === null) {
      out.push({ severity: "error", code: "options-invalid", message: `${document.id}.${stage.id}: ${failure.message}`, path: stagePath("options"), source });
    } else {
      // The options come from the model or role definition: the config layer that owns it fixes them.
      out.push({ severity: "error", code: "options-invalid", message: `${document.id}.${stage.id}: ${failure.message}`, path: failure.path, source: ownerSource(ownerOf(failure.path)) });
    }
  }
  return dedupe(out);
}

/**
 * Finds where invalid provider options come from by validating one layer at a time:
 * the model definition, then the role's options on top, then the stage's own options.
 * `path` is null when only the stage's options cause the failure.
 */
function optionsFailure(
  config: Mapping,
  stage: RoleStageSpec,
  target: StageTarget,
  providers: Providers,
): { message: string; path: (string | number)[] | null } | null {
  const validate = (candidate: StageTarget): string | null => {
    const provider = withTargetClient(providers[candidate.provider], candidate.client);
    if (provider === undefined) return null;
    try {
      provider.validateOptions(candidate.options);
      return null;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return error.message;
    }
  };
  // Options the stage's own values make valid are fine, whatever the lower layers hold.
  const full = validate(target);
  if (full === null) return null;
  const resolver = createProviderResolver(providers);
  const roleDefault = isRecord(config.roles) && isRecord(config.roles[stage.role]) ? config.roles[stage.role] : undefined;
  const selected = stage.modelName ?? (isRecord(roleDefault) ? roleDefault.default_model : undefined);
  if (typeof selected === "string") {
    try {
      const message = validate(loadModelTarget(config, selected, resolver));
      if (message !== null) return { message, path: ["models", selected, "options"] };
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
    }
  }
  const withRole = resolveStageSpec(config, { ...stage, options: {} }, undefined, resolver);
  const roleMessage = validate(withRole);
  if (roleMessage !== null) {
    const inline = stage.modelName === null && isRecord(roleDefault) && isRecord(roleDefault.default_model);
    return { message: roleMessage, path: inline ? ["roles", stage.role, "default_model"] : ["roles", stage.role, "options"] };
  }
  return { message: full, path: null };
}

function dedupe(items: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.severity}|${item.code}|${JSON.stringify(item.path ?? null)}|${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
