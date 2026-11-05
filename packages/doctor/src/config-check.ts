import { spawnSync } from "node:child_process";
import {
  ConfigurationError,
  LOCAL_CONFIG_FILE,
  createProviderResolver,
  hasLocalConfig,
  listModelDefinitions,
  loadMergedConfig,
  loadModelDefinition,
  loadRoleInstructions,
  mergeConfigLayers,
  resolveEffectiveProvider,
  resolveRoleCascade,
  unknownRoleKeyEntries,
  validateRoleOptions,
  type ConfigOwner,
  type ProviderInfo,
} from "@nodeint/migent-kernel";
import { DiagnosticList, failed, passed, type Check, type Diagnostic, type ModelEffortCheck } from "./check.js";
import { failureText, withTargetClient } from "./providers.js";

type Providers = Readonly<Record<string, ProviderInfo>>;

/** What the structural rules found in one effective config. Pure: no files, PATH or catalogs. */
export interface ConfigAnalysis {
  diagnostics: DiagnosticList;
  /** Executable per provider that at least one definition resolves to. */
  executableByProvider: Record<string, string>;
  /** Roles that resolve cleanly, sorted. */
  roleNames: string[];
  /** Aliases defined as an empty mapping: waiting for a local mapping. */
  unmapped: ReadonlySet<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Applies the runtime's rules to an effective config and reports every violation, not just the first.
 * `effortChecks` carries what the environment learned about models; pass `{}` for a static check.
 */
export function analyzeConfig(
  config: Record<string, unknown>,
  providers: Providers,
  effortChecks: Readonly<Record<string, ModelEffortCheck>>,
  ownerOf: (path: readonly string[]) => ConfigOwner,
): ConfigAnalysis {
  const diagnostics = new DiagnosticList();
  const executableByProvider: Record<string, string> = {};
  const error = (code: string, message: string, path?: readonly string[], detail?: string): void => {
    diagnostics.add({
      severity: "error",
      code,
      message,
      ...(path === undefined ? {} : { path, source: { layer: ownerOf(path) } }),
      ...(detail === undefined ? {} : { detail }),
    });
  };
  const fromError = (caught: unknown, fallbackPath?: readonly string[]): void => {
    if (!(caught instanceof ConfigurationError)) throw caught;
    error(caught.code ?? "config-invalid", caught.message, caught.path ?? fallbackPath);
  };

  let models: Record<string, unknown>;
  let roles: Record<string, unknown>;
  if (config.models === undefined) {
    models = {};
  } else if (!isRecord(config.models)) {
    error("models-invalid", "Missing or invalid models.", ["models"]);
    models = {};
  } else {
    models = config.models;
  }
  if (!isRecord(config.roles)) {
    error("roles-invalid", "Missing or invalid roles.", ["roles"]);
    roles = {};
  } else {
    roles = config.roles;
    if (Object.keys(roles).length === 0) error("roles-empty", "roles is empty.", ["roles"]);
  }

  const unmapped = new Set(
    Object.keys(models).filter((name) => isRecord(models[name]) && Object.keys(models[name]).length === 0),
  );
  if (unmapped.size > 0) error("model-unmapped", unmappedMessage([...unmapped].sort()), ["models"]);

  const resolver = createProviderResolver(providers);
  for (const [name, role] of Object.entries(roles)) {
    if (!isRecord(role)) continue;
    try { validateRoleOptions(role, name); } catch (caught) { fromError(caught, ["roles", name, "options"]); }
  }
  for (const entry of listModelDefinitions(config)) {
    if (unmapped.has(entry.key)) continue;
    const effortCheck = effortChecks[entry.key];
    if (effortCheck?.problem) error("model-unavailable", effortCheck.problem, entry.path);
    if (effortCheck?.warning) {
      diagnostics.add({ severity: "warning", code: "model-unverified", message: effortCheck.warning, path: entry.path });
    }
    let definition = entry.value;
    if (effortCheck?.problem && isRecord(definition)) {
      const { effort: _effort, ...rest } = definition;
      definition = rest;
    }
    let target;
    try {
      target = loadModelDefinition(definition, { label: entry.field, path: entry.path }, resolver);
    } catch (caught) {
      fromError(caught, entry.path);
      continue;
    }
    const bound = resolveEffectiveProvider(providers, target);
    if (bound.provider !== undefined && !Object.hasOwn(executableByProvider, target.provider)) {
      executableByProvider[target.provider] = bound.provider.command;
    }
    if (bound.failure !== undefined) {
      const { failure } = bound;
      error(
        failure.code,
        failureText(entry.field, failure),
        [...entry.path, failure.part],
        failure.code === "options-invalid" ? failure.message : undefined,
      );
    }
  }

  const roleNames: string[] = [];
  for (const roleKey of Object.keys(roles).sort()) {
    const role = roles[roleKey];
    const defaultModel = isRecord(role) ? role.default_model : undefined;
    if (typeof defaultModel === "string" && unmapped.has(defaultModel)) {
      roleNames.push(roleKey);
      continue;
    }
    if (typeof defaultModel === "string" && effortChecks[defaultModel]?.problem) {
      try { loadRoleInstructions(config, roleKey); } catch (caught) { fromError(caught, ["roles", roleKey]); }
      continue;
    }
    if (effortChecks[`roles.${roleKey}.default_model`]?.problem) continue;
    let resolved;
    try {
      resolved = resolveRoleCascade(config, roleKey, { options: null }, resolver);
      loadRoleInstructions(config, roleKey);
    } catch (caught) {
      fromError(caught, ["roles", roleKey]);
      continue;
    }
    const roleProvider = withTargetClient(providers[resolved.provider], resolved.client);
    if (roleProvider !== undefined) {
      try {
        roleProvider.validateOptions(resolved.options);
      } catch (caught) {
        if (!(caught instanceof Error)) throw caught;
        error("options-invalid", `roles.${roleKey}: ${caught.message}`, ["roles", roleKey], caught.message);
      }
    }
    roleNames.push(roleKey);
  }

  for (const unknown of unknownRoleKeyEntries(config)) {
    diagnostics.add({ severity: "warning", code: unknown.code, message: unknown.message, path: unknown.path, source: { layer: ownerOf(unknown.path) } });
  }
  return { diagnostics, executableByProvider, roleNames, unmapped };
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

/**
 * Static validation of config layers a caller already holds (for example an unsaved draft).
 * It merges them exactly like the runtime and applies the structural rules to the result. It never
 * touches PATH, catalogs or git. Reading and parsing the layers is the caller's job, through
 * `readConfigLayer`, so a layer that fails to parse never gets here.
 */
export function validateConfigLayers(
  layers: { project: Record<string, unknown>; local?: Record<string, unknown> | null },
  providers: Providers,
): Diagnostic[] {
  const merged = mergeConfigLayers(layers.project, layers.local);
  const analysis = analyzeConfig(merged.config, providers, {}, merged.ownerOf);
  return analysis.diagnostics.items;
}

export interface ConfigCheckResult {
  check: Check;
  executableByProvider: Record<string, string>;
  /** Errors found; empty when the config could not be loaded only if `config` is null. */
  diagnostics: DiagnosticList;
  config: Record<string, unknown> | null;
  unmapped: ReadonlySet<string>;
}

export function checkConfig(
  workspace: string,
  providers: Providers,
  effortChecks: Readonly<Record<string, ModelEffortCheck>>,
): ConfigCheckResult {
  let merged;
  try {
    merged = loadMergedConfig(workspace);
  } catch (caught) {
    if (!(caught instanceof ConfigurationError)) throw caught;
    const diagnostics = new DiagnosticList();
    diagnostics.add({
      severity: "error",
      code: caught.code ?? "config-invalid",
      message: caught.message,
      ...(caught.path === undefined ? {} : { path: caught.path }),
      ...(caught.layer === undefined ? {} : { source: { layer: caught.layer } }),
      ...(caught.position === undefined ? {} : { position: caught.position }),
    });
    return {
      check: failed("config", [caught.message], [], trackedLocalConfigWarnings(workspace)),
      executableByProvider: {},
      diagnostics,
      config: null,
      unmapped: new Set(),
    };
  }
  const { config, ownerOf } = merged;
  const analysis = analyzeConfig(config, providers, effortChecks, ownerOf);
  const warnings = [
    ...trackedLocalConfigWarnings(workspace),
    ...analysis.diagnostics.warnings.map((warning) => warning.message),
  ];
  const problems = analysis.diagnostics.errors.map((item) => item.message);
  return {
    check: problems.length > 0 ? failed("config", problems, [], warnings) : passed("config", analysis.roleNames, warnings),
    executableByProvider: analysis.executableByProvider,
    diagnostics: analysis.diagnostics,
    config,
    unmapped: analysis.unmapped,
  };
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
