import { spawnSync } from 'node:child_process';

import {
  buildStructuralIndex,
  type ClientRegistry,
  type ConfigOwner,
  ConfigurationError,
  containerIssues,
  hasLocalConfig,
  isAgentPlaceholder,
  listAgentDefinitions,
  loadAgentDefinition,
  loadMergedConfig,
  loadRoleDescription,
  loadRoleResponsibilities,
  LOCAL_CONFIG_FILE,
  mergeConfigLayers,
  rejectLegacyConfigKeys,
  resolveEffectiveClient,
  resolveRoleCascade,
  type StructuralIndex,
  unknownRoleKeyEntries,
  validateRoleKeys,
} from '@nodeint/migent-kernel';

import { type Check, type Diagnostic, DiagnosticList, failed, type ModelEffortCheck,passed } from './check.js';
import { failurePath, failureText } from './clients.js';

/** What the structural rules found in one effective config. Pure: no files, PATH or catalogs. */
export interface ConfigAnalysis {
  diagnostics: DiagnosticList;
  /** Executable per client that at least one definition resolves to. */
  executableByClient: Record<string, string>;
  /** Roles that resolve cleanly, sorted. */
  roleNames: string[];
  /** One-line descriptions of the roles that declare one. */
  roleDescriptions: Record<string, string>;
  /** Agents defined as an empty mapping: waiting for a local mapping. */
  unmapped: ReadonlySet<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Applies the runtime's rules to an effective config and reports every violation, not just the first.
 * `effortChecks` carries what the environment learned about models; pass `{}` for a static check.
 */
export function analyzeConfig(
  config: Record<string, unknown>,
  clients: ClientRegistry,
  source: {
    readonly effortChecks: Readonly<Record<string, ModelEffortCheck>>;
    readonly ownerOf: (path: readonly (string | number)[]) => ConfigOwner;
  },
): ConfigAnalysis {
  const { effortChecks, ownerOf } = source;
  const diagnostics = new DiagnosticList();
  const error = (
    code: string,
    message: string,
    where: { path?: readonly (string | number)[]; detail?: string } = {},
  ): void => {
    const { path, detail } = where;
    diagnostics.add({
      severity: 'error',
      code,
      message,
      ...(path === undefined ? {} : { path, source: { layer: ownerOf(path) } }),
      ...(detail === undefined ? {} : { detail }),
    });
  };
  const fromError = (caught: unknown, fallbackPath?: readonly (string | number)[]): void => {
    if (!(caught instanceof ConfigurationError)) throw caught;
    error(caught.code ?? 'config-invalid', caught.message, { path: caught.path ?? fallbackPath });
  };

  try { rejectLegacyConfigKeys(config); } catch (caught) { fromError(caught, ['models']); }
  for (const issue of containerIssues(config)) fromError(issue);
  const agents: Record<string, unknown> = isRecord(config.agents) ? config.agents : {};
  const roles: Record<string, unknown> = isRecord(config.roles) ? config.roles : {};
  if (isRecord(config.roles) && Object.keys(roles).length === 0) error('roles-empty', 'roles is empty.', { path: ['roles'] });

  const structure: StructuralIndex = buildStructuralIndex(config);
  const unmapped = new Set(
    Object.keys(agents).filter((name) => isAgentPlaceholder(agents[name])),
  );
  if (unmapped.size > 0) error('agent-unmapped', unmappedMessage([...unmapped].sort()), { path: ['agents'] });

  for (const [name, role] of Object.entries(roles)) {
    if (!isRecord(role)) continue;
    try { validateRoleKeys(role, name); } catch (caught) { fromError(caught, ['roles', name, 'options']); }
  }
  const ctx: AnalysisContext = { config, clients, effortChecks, structure, unmapped, diagnostics, error, fromError };
  const executableByClient = checkAgentDefinitions(ctx);
  const { roleNames, roleDescriptions } = checkRoles(ctx, roles);

  for (const unknown of unknownRoleKeyEntries(config)) {
    diagnostics.add({ severity: 'warning', code: unknown.code, message: unknown.message, path: unknown.path, source: { layer: ownerOf(unknown.path) } });
  }
  return { diagnostics, executableByClient, roleNames, roleDescriptions, unmapped };
}

type ReportError = (
  code: string,
  message: string,
  where?: { path?: readonly (string | number)[]; detail?: string },
) => void;

interface AnalysisContext {
  readonly config: Record<string, unknown>;
  readonly clients: ClientRegistry;
  readonly effortChecks: Readonly<Record<string, ModelEffortCheck>>;
  readonly structure: StructuralIndex;
  readonly unmapped: ReadonlySet<string>;
  readonly diagnostics: DiagnosticList;
  readonly error: ReportError;
  readonly fromError: (caught: unknown, fallbackPath?: readonly (string | number)[]) => void;
}

/** Loads every mapped agent definition and binds its client; returns the executable each client runs. */
function checkAgentDefinitions(ctx: AnalysisContext): Record<string, string> {
  const { config, clients, effortChecks, structure, unmapped, diagnostics, error, fromError } = ctx;
  const executableByClient: Record<string, string> = {};
  for (const entry of listAgentDefinitions(config)) {
    if (unmapped.has(entry.key)) continue;
    const effortCheck = effortChecks[entry.key];
    if (effortCheck?.problem) error('model-unavailable', effortCheck.problem, { path: entry.path });
    if (effortCheck?.warning) {
      diagnostics.add({ severity: 'warning', code: 'model-unverified', message: effortCheck.warning, path: entry.path });
    }
    let definition = entry.value;
    // A model the environment rejects drops its effort, so the index verdict on `effort` no longer applies.
    let verdicts: StructuralIndex | undefined = structure;
    if (effortCheck?.problem && isRecord(definition)) {
      const { effort, ...rest } = definition;
      definition = rest;
      verdicts = undefined;
    }
    let target;
    try {
      target = loadAgentDefinition(
        definition,
        { label: entry.field, path: entry.path },
        { registry: clients, index: verdicts },
      );
    } catch (caught) {
      fromError(caught, entry.path);
      continue;
    }
    const bound = resolveEffectiveClient(clients, target);
    if (bound.client !== undefined && !Object.hasOwn(executableByClient, target.client)) {
      executableByClient[target.client] = bound.client.command;
    }
    if (bound.failure !== undefined) {
      const { failure } = bound;
      error(
        failure.code,
        failureText(entry.field, failure),
        { path: [...entry.path, ...failurePath(failure)], detail: failure.code === 'options-invalid' ? failure.message : undefined },
      );
    }
  }
  return executableByClient;
}

/** Resolves every role's cascade in name order; unmapped roles count as known without further checks. */
function checkRoles(
  ctx: AnalysisContext,
  roles: Record<string, unknown>,
): { roleNames: string[]; roleDescriptions: Record<string, string> } {
  const { config, clients, effortChecks, structure, unmapped, error, fromError } = ctx;
  const roleNames: string[] = [];
  const roleDescriptions: Record<string, string> = {};
  for (const roleKey of Object.keys(roles).sort()) {
    const role = roles[roleKey];
    const roleAgent = isRecord(role) ? role.agent : undefined;
    if (typeof roleAgent === 'string' && unmapped.has(roleAgent)) {
      roleNames.push(roleKey);
      continue;
    }
    if (typeof roleAgent === 'string' && effortChecks[roleAgent]?.problem) {
      try { loadRoleResponsibilities(config, roleKey, structure); loadRoleDescription(config, roleKey, structure); } catch (caught) { fromError(caught, ['roles', roleKey]); }
      continue;
    }
    if (effortChecks[`roles.${roleKey}.agent`]?.problem) continue;
    let resolved;
    try {
      resolved = resolveRoleCascade(config, roleKey, { options: null, registry: clients, index: structure });
      loadRoleResponsibilities(config, roleKey, structure);
      const description = loadRoleDescription(config, roleKey, structure);
      if (description !== null) roleDescriptions[roleKey] = description;
    } catch (caught) {
      fromError(caught, ['roles', roleKey]);
      continue;
    }
    const bound = resolveEffectiveClient(clients, resolved);
    if (bound.failure !== undefined) {
      const where = `roles.${roleKey}`;
      const detail = failurePath(bound.failure).join('.');
      error(
        bound.failure.code,
        bound.failure.part === 'options' ? `${where}: ${bound.failure.message}` : `${where}.${detail} ${bound.failure.message}`,
        { path: ['roles', roleKey, ...failurePath(bound.failure)], detail: bound.failure.code === 'options-invalid' ? bound.failure.message : undefined },
      );
    }
    roleNames.push(roleKey);
  }
  return { roleNames, roleDescriptions };
}

function unmappedMessage(aliases: readonly string[]): string {
  const lines = [
    `${aliases.map((alias) => `agents.${alias}`).join(', ')} ${aliases.length === 1 ? 'has' : 'have'} no client and model on this machine.`,
    `Add ${aliases.length === 1 ? 'it' : 'them'} to .migent/${LOCAL_CONFIG_FILE}, for example:`,
    'agents:',
  ];
  for (const alias of aliases) lines.push(`  ${alias}:`, '    client:', '      type: <client>', '    model: <model>');
  return lines.join('\n');
}

/**
 * Static validation of config layers a caller already holds (for example an unsaved draft).
 * It merges them exactly like the runtime and applies the structural rules to the result. It never
 * touches PATH, catalogs or git. Reading and parsing the layers is the caller's job, through
 * `readConfigLayer`, so a layer that fails to parse never gets here.
 */
export function validateConfigLayers(
  layers: { project: Record<string, unknown>; local?: Record<string, unknown> | null },
  clients: ClientRegistry,
): Diagnostic[] {
  const merged = mergeConfigLayers(layers.project, layers.local);
  const analysis = analyzeConfig(merged.config, clients, { effortChecks: {}, ownerOf: merged.ownerOf });
  return analysis.diagnostics.items;
}

export interface ConfigCheckResult {
  check: Check;
  executableByClient: Record<string, string>;
  /** Errors found; empty when the config could not be loaded only if `config` is null. */
  diagnostics: DiagnosticList;
  config: Record<string, unknown> | null;
  unmapped: ReadonlySet<string>;
}

export function checkConfig(
  workspace: string,
  clients: ClientRegistry,
  effortChecks: Readonly<Record<string, ModelEffortCheck>>,
): ConfigCheckResult {
  let merged;
  try {
    merged = loadMergedConfig(workspace);
  } catch (caught) {
    if (!(caught instanceof ConfigurationError)) throw caught;
    const diagnostics = new DiagnosticList();
    diagnostics.add({
      severity: 'error',
      code: caught.code ?? 'config-invalid',
      message: caught.message,
      ...(caught.path === undefined ? {} : { path: caught.path }),
      ...(caught.layer === undefined ? {} : { source: { layer: caught.layer } }),
      ...(caught.position === undefined ? {} : { position: caught.position }),
    });
    return {
      check: failed('config', [caught.message], { warnings: trackedLocalConfigWarnings(workspace) }),
      executableByClient: {},
      diagnostics,
      config: null,
      unmapped: new Set(),
    };
  }
  const { config, ownerOf } = merged;
  const analysis = analyzeConfig(config, clients, { effortChecks, ownerOf });
  const warnings = [
    ...trackedLocalConfigWarnings(workspace),
    ...analysis.diagnostics.warnings.map((warning) => warning.message),
  ];
  const problems = analysis.diagnostics.errors.map((item) => item.message);
  return {
    check: problems.length > 0 ? failed('config', problems, { warnings }) : passed('config', analysis.roleNames.map((name) => analysis.roleDescriptions[name] === undefined ? name : `${name}  ${analysis.roleDescriptions[name]}`), warnings),
    executableByClient: analysis.executableByClient,
    diagnostics: analysis.diagnostics,
    config,
    unmapped: analysis.unmapped,
  };
}

/** Empty unless the local override exists and git tracks it. No git, no repo, or untracked is silent. */
function trackedLocalConfigWarnings(workspace: string): string[] {
  if (!hasLocalConfig(workspace)) return [];
  const relative = `.migent/${LOCAL_CONFIG_FILE}`;
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', relative], {
    cwd: workspace,
    stdio: 'ignore',
  });
  if (result.error !== undefined || result.status !== 0) return [];
  return [`${relative} is tracked by git; run git rm --cached ${relative} and keep it ignored.`];
}
