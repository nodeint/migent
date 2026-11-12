import { checkDocumentSchemaVersion, type ClientRegistry,type ConfigOwner, ConfigurationError, loadAgentTarget, mergeConfigLayers, type MergedConfig, resolveEffectiveClient, resolveStageSpec, type StageTarget } from '@nodeint/migent-kernel';
import { catalogEntryFromDocument, checkWorkflowCatalog, collectWorkflowDraft, parseWorkflowMapping, type RoleStageSpec, unknownWorkflowKeyEntries, type WorkflowCatalogEntry } from '@nodeint/migent-workflow';

import { OPTIONAL_MAPPING_CODE, optionalArtifactMappings } from './artifact-notes.js';
import type { Diagnostic } from './check.js';
import { analyzeConfig } from './config-check.js';

type Mapping = Record<string, unknown>;

const isRecord = (value: unknown): value is Mapping =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fromError(error: ConfigurationError, source: Diagnostic['source'], fallbackCode: string): Diagnostic {
  return {
    severity: 'error',
    code: error.code ?? fallbackCode,
    message: error.message,
    ...(error.path === undefined ? {} : { path: error.path }),
    ...(source === undefined ? {} : { source }),
    ...(error.position === undefined ? {} : { position: error.position }),
  };
}

function versionDiagnostics(document: Mapping, label: string, source: Diagnostic['source']): Diagnostic[] {
  const result = checkDocumentSchemaVersion(document);
  const base = { severity: 'error' as const, path: ['schema_version'], ...(source === undefined ? {} : { source }) };
  switch (result.status) {
    case 'current':
      return [];
    case 'invalid':
      return [{ ...base, code: 'schema-version-invalid', message: `${label}: ${result.message}` }];
    case 'outdated':
      return [{ ...base, code: 'schema-outdated', message: `${label}: schema_version is v${result.version}; this Migent uses the current version. Run \`migent migrate\`.` }];
    case 'newer':
      return [{ ...base, code: 'schema-newer', message: `${label}: schema_version v${result.version} is newer than this Migent supports.` }];
  }
}

export interface ConfigDraftInput {
  /** Which layer the draft replaces. */
  scope: 'project' | 'local';
  draft: Mapping;
  /** The other layer as it is on disk, or null when absent. */
  companion: Mapping | null;
}

/**
 * Validates an unsaved config layer with the runtime's rules. The draft is merged with the other layer
 * exactly as the runtime would. Findings carry the layer that owns the node (`draft` marks the draft's).
 * A missing project layer (scope local) is the caller's error to report.
 */
export function validateConfigDraft(input: ConfigDraftInput, clients: ClientRegistry): Diagnostic[] {
  const out: Diagnostic[] = [];
  out.push(...versionDiagnostics(input.draft, `${input.scope} config`, { layer: input.scope }));
  if (input.companion !== null) {
    const other = input.scope === 'project' ? 'local' : 'project';
    out.push(...versionDiagnostics(input.companion, `${other} config`, { layer: other }));
  }
  const project = input.scope === 'project' ? input.draft : input.companion;
  const local = input.scope === 'local' ? input.draft : input.companion;
  if (project === null) return out;
  const merged = mergeConfigLayers(project, local);
  const analysis = analyzeConfig(merged.config, clients, { effortChecks: {}, ownerOf: merged.ownerOf });
  for (const item of analysis.diagnostics.items) {
    // The alias waits for this machine's mapping; that describes the machine, not the document.
    out.push(item.code === 'agent-unmapped' ? { ...item, severity: 'warning' } : item);
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
  siblings: readonly ({ file: string; document: Mapping } | { file: string; error: ConfigurationError })[];
  /** The effective config and its layers, or the error that stopped it loading. */
  config: ConfigLoad | ConfigurationError;
  /**
   * Set when the draft belongs to a session instead of the project catalog. `file` is then the draft's
   * own path, `siblings` are all project workflows (the draft's template included), and the draft is
   * checked against them without becoming one of them. `expectedId` is the id the session recorded.
   */
  session?: { expectedId: string };
}

function ownerSource(owner: ConfigOwner): Diagnostic['source'] {
  return { layer: owner };
}

type WorkflowDraft = ReturnType<typeof collectWorkflowDraft>;
type StageDraft = WorkflowDraft['stages'][number];

/** Parser problems, optional-artifact notes and unknown keys of the draft, in that order. */
function draftDiagnostics(draft: Mapping, parsed: WorkflowDraft, source: Diagnostic['source']): Diagnostic[] {
  const out: Diagnostic[] = [];
  // Every independent problem of the draft, not just the first one.
  for (const problem of parsed.problems) {
    out.push({
      severity: 'error',
      code: problem.code,
      message: problem.message,
      ...(problem.path === undefined ? {} : { path: problem.path }),
      source,
    });
  }
  // A mapping to an optional artifact is best-effort context; say so where the author wrote it.
  const optionalMappings = parsed.document === null ? [] : optionalArtifactMappings(parsed.document);
  for (const item of optionalMappings) {
    out.push({ severity: 'warning', code: OPTIONAL_MAPPING_CODE, message: item.message, path: item.path, source });
  }
  // Unknown keys are independent of every other rule; a newer schema turns them into errors above.
  for (const entry of unknownWorkflowKeyEntries(draft)) {
    out.push({ severity: 'warning', code: entry.code, message: entry.message, path: entry.path, source });
  }
  return out;
}

/** A parsed sibling's catalog entry, or the configuration error that rejected it. */
function siblingCatalogEntry(
  sibling: { file: string; document: Mapping },
): { entry: WorkflowCatalogEntry } | { error: ConfigurationError } {
  try {
    return { entry: catalogEntryFromDocument(sibling.file, parseWorkflowMapping(sibling.document, sibling.file)) };
  } catch (caught) {
    if (!(caught instanceof ConfigurationError)) throw caught;
    return { error: caught };
  }
}

/** Siblings go through the same parser and catalog rules the runtime applies to the directory. */
function siblingCatalog(siblings: WorkflowDraftInput['siblings']): {
  entries: WorkflowCatalogEntry[];
  failedIds: Set<string>;
  diagnostics: Diagnostic[];
} {
  const entries: WorkflowCatalogEntry[] = [];
  const failedIds = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  for (const sibling of siblings) {
    const sibSource = { workflow: sibling.file };
    const parsed = 'error' in sibling ? { error: sibling.error } : siblingCatalogEntry(sibling);
    const error = 'error' in parsed ? parsed.error : null;
    if ('entry' in parsed) entries.push(parsed.entry);
    if (error !== null) {
      failedIds.add(sibling.file.replace(/\.yaml$/, ''));
      diagnostics.push({ ...fromError(error, sibSource, 'workflow-invalid'), severity: 'warning', message: `${sibling.file}: ${error.message}` });
    }
  }
  return { entries, failedIds, diagnostics };
}

interface StageCheckContext {
  config: Mapping;
  ownerOf: MergedConfig['ownerOf'];
  clients: ClientRegistry;
  label: string;
  source: Diagnostic['source'];
}

/** Maps a stage resolution error to the diagnostic owned by the workflow or the config layer. */
function resolutionDiagnostic(
  error: ConfigurationError,
  where: { stage: RoleStageSpec; index: number },
  ctx: StageCheckContext,
): Diagnostic {
  const { stage, index } = where;
  const { ownerOf, label, source } = ctx;
  const stagePath = (field: string): (string | number)[] => ['stages', index, field];
  const head = error.path?.[0];
  const missingRole = error.code === 'missing-or-invalid' && error.path?.join('.') === `roles.${stage.role}`;
  if (head === 'stages' || missingRole) {
    // The stage's own reference (its explicit agent, or a role that does not exist) is the workflow's to fix.
    const field = missingRole ? 'role' : 'agent';
    return { severity: 'error', code: missingRole ? 'unknown-role' : (error.code ?? 'workflow-invalid'), message: `${label}.${stage.id}: ${error.message}`, path: stagePath(field), source };
  } else if (error.path !== undefined) {
    // A fault in the config, including a model inherited from the role's default: the config owns the fix.
    return { severity: 'error', code: error.code ?? 'config-invalid', message: error.message, path: error.path, source: ownerSource(ownerOf(error.path)) };
  }
  return { severity: 'error', code: error.code ?? 'workflow-invalid', message: `${label}.${stage.id}: ${error.message}`, path: stagePath('role'), source };
}

/** Resolves one readable stage against the effective config and reports who owns each fault. */
function stageDiagnostics(stageDraft: StageDraft, ctx: StageCheckContext): Diagnostic[] {
  const stage = stageDraft.roleStage;
  if (stage === null) return [];
  const { config, ownerOf, clients, label, source } = ctx;
  const {index} = stageDraft;
  let target;
  try {
    target = resolveStageSpec(config, stage, { registry: clients });
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return [resolutionDiagnostic(error, { stage, index }, ctx)];
  }
  const failure = optionsFailure(config, stage, { target, clients });
  if (failure === null) return [];
  if (failure.path === null) {
    return [{ severity: 'error', code: 'options-invalid', message: `${label}.${stage.id}: ${failure.message}`, path: ['stages', index, 'agent'], source }];
  }
  // The options come from the model or role definition: the config layer that owns it fixes them.
  return [{ severity: 'error', code: 'options-invalid', message: `${label}.${stage.id}: ${failure.message}`, path: failure.path, source: ownerSource(ownerOf(failure.path)) }];
}

const DRAFT_PATHS: Record<string, string> = { 'duplicate-id': 'id', 'unknown-downstream': 'downstream', 'no-stages': 'stages', 'requires-invalid': 'requires' };

/** Reports a draft id that differs from the id the session expects. */
function sessionIdDiagnostics(input: WorkflowDraftInput, draftId: string | null, source: Diagnostic['source']): Diagnostic[] {
  if (input.session === undefined || draftId === null || draftId === input.session.expectedId) return [];
  return [{
    severity: 'error',
    code: 'session-workflow-id-mismatch',
    message: `Session workflow id is ${input.session.expectedId}, not ${draftId}. Do not change id in the session draft.`,
    path: ['id'],
    source,
  }];
}

/** Checks the draft together with its sibling workflows and attributes each catalog problem. */
function catalogDiagnostics(
  input: WorkflowDraftInput,
  draft: { parsed: ReturnType<typeof collectWorkflowDraft>; draftId: string | null },
  source: Diagnostic['source'],
): Diagnostic[] {
  const { parsed, draftId } = draft;
  const out: Diagnostic[] = [];
  const { entries, failedIds, diagnostics: siblingDiagnostics } = siblingCatalog(input.siblings);
  out.push(...siblingDiagnostics);
  if (input.session === undefined) entries.push(parsed.catalogEntry);
  out.push(...sessionIdDiagnostics(input, draftId, source));
  const fileOf = (workflowId: string): string | undefined =>
    entries.find((entry) => entry.id.known && entry.id.value === workflowId)?.file;
  const catalog = checkWorkflowCatalog(entries, failedIds, input.session === undefined ? null : parsed.catalogEntry);
  for (const problem of catalog.problems) {
    const concerns = problem.external === true || (input.session === undefined &&
      (problem.workflow === draftId || (problem.files?.includes(input.file) ?? false)));
    const where = concerns ? source : { workflow: fileOf(problem.workflow) ?? input.file };
    out.push({
      severity: concerns ? 'error' : 'warning',
      code: problem.code,
      message: problem.message,
      ...(concerns ? { path: problem.path ?? [DRAFT_PATHS[problem.code] ?? 'id'] } : {}),
      source: where,
    });
  }
  return out;
}

/** Validates an unsaved workflow against the parser, the catalog rules and the effective config. */
export function validateWorkflowDraft(input: WorkflowDraftInput, clients: ClientRegistry): Diagnostic[] {
  const out: Diagnostic[] = [];
  const source = { workflow: input.file };
  out.push(...versionDiagnostics(input.draft, input.file === '' ? 'workflow' : input.file, source));
  const parsed = collectWorkflowDraft(input.draft, input.file);
  out.push(...draftDiagnostics(input.draft, parsed, source));
  const draftId = parsed.id.state === 'invalid' ? null : parsed.id.value;
  out.push(...catalogDiagnostics(input, { parsed, draftId }, source));

  if (input.config instanceof ConfigurationError) {
    out.push(fromError(input.config, input.config.layer === undefined ? undefined : { layer: input.config.layer }, 'config-invalid'));
    return dedupe(out);
  }
  const { config, ownerOf, layers } = input.config;
  const layerVersions = [
    ...versionDiagnostics(layers.project, 'project config', { layer: 'project' }),
    ...(layers.local === null ? [] : versionDiagnostics(layers.local, 'local config', { layer: 'local' })),
  ];
  if (layerVersions.length > 0) return dedupe([...out, ...layerVersions]);
  // Only stages whose role, agent and options are readable take part in config resolution.
  const ctx = { config, ownerOf, clients, label: draftId ?? input.file, source };
  for (const stageDraft of parsed.stages) out.push(...stageDiagnostics(stageDraft, ctx));
  return dedupe(out);
}

/**
 * Finds where invalid client options come from by validating one layer at a time:
 * the agent definition, then the role's inline agent, then the stage's own inline agent.
 * `path` is null when only the stage's options cause the failure.
 */
function optionsFailure(
  config: Mapping,
  stage: RoleStageSpec,
  resolved: { target: StageTarget; clients: ClientRegistry },
): { message: string; path: (string | number)[] | null } | null {
  const { target, clients } = resolved;
  const validate = (candidate: StageTarget): string | null => {
    const bound = resolveEffectiveClient(clients, candidate);
    return bound.failure?.code === 'options-invalid' ? bound.failure.message : null;
  };
  // Options the stage's own values make valid are fine, whatever the lower layers hold.
  const full = validate(target);
  if (full === null) return null;
  // An inline stage agent is a complete definition of its own: its options are the stage's to fix.
  if (stage.agent?.kind === 'inline') return { message: full, path: null };
  const roleDefault =
    isRecord(config.roles) && isRecord(config.roles[stage.role]) ? config.roles[stage.role] : undefined;
  const agentFailure = namedAgentFailure(config, selectedAgent(stage, roleDefault), { clients, validate });
  if (agentFailure !== null) return agentFailure;
  const withRole = resolveStageSpec(config, { ...stage, options: {} }, { registry: clients });
  const roleMessage = validate(withRole);
  if (roleMessage !== null) {
    const inline = stage.agent === null && isRecord(roleDefault) && isRecord(roleDefault.agent);
    return { message: roleMessage, path: inline ? ['roles', stage.role, 'agent'] : ['roles', stage.role, 'options'] };
  }
  return { message: full, path: null };
}

/** The agent a stage selects: its own named agent, or the role default's agent field. */
function selectedAgent(stage: RoleStageSpec, roleDefault: unknown): unknown {
  if (stage.agent !== null) return stage.agent.kind === 'named' ? stage.agent.name : undefined;
  return isRecord(roleDefault) ? roleDefault.agent : undefined;
}

/** Validates a named agent definition's options on their own. */
function namedAgentFailure(
  config: Mapping,
  selected: unknown,
  deps: { clients: ClientRegistry; validate: (candidate: StageTarget) => string | null },
): { message: string; path: (string | number)[] } | null {
  if (typeof selected !== 'string') return null;
  try {
    const message = deps.validate(loadAgentTarget(config, selected, { registry: deps.clients }));
    if (message !== null) return { message, path: ['agents', selected, 'client', 'options'] };
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
  }
  return null;
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
