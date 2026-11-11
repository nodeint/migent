/** Upgrade config and workflow documents from the version they record.

Version steps are built into this module. The v0 "thinking" tables live in
`migration-legacy.ts`, keyed by the historical provider ID. This module walks
the steps and writes the resulting schema_version. A missing schema_version is
version 0. Writes stay on the text patchers.
*/
import { documentVersion, isRecord } from '@nodeint/migent-workflow';
import { conditionalStages, parseWorkflowMapping,SCHEMA_VERSION } from '@nodeint/migent-workflow';

import { ConfigurationError } from './errors.js';
import { type ConfigLayerKind,liftConfigAgents, liftConfigClients, liftWorkflowClients } from './migration-config.js';
import { migrateModels, migrateRoles, migrateStages } from './migration-legacy.js';
import { SCHEMA_VERSION_FIELD, stagesById } from './workflow-text.js';
import { deepCopy, deepCopyRecord, deepEqual } from './yaml-patch.js';

export type MigrationFn = (entry: Record<string, unknown>) => void;

export interface MigrationLayer {
  layer?: ConfigLayerKind;
  /** The original v5 project + local merge, before any rewrite. */
  merged?: Readonly<Record<string, unknown>>;
  /** The other layer, for the project/local decision in the v5 to v6 lift. */
  other?: Readonly<Record<string, unknown>> | null;
  /** Client ids named when a provider has no resolvable default client. */
  clientIds?: readonly string[];
  /** The project layer as it will be written, for a local lift's surviving view. */
  project?: Record<string, unknown>;
  /** The local layer as it will be written, for a project lift's surviving view. */
  local?: Record<string, unknown> | null;
}

export function migrateConfig(
  config: Record<string, unknown>,
  current = SCHEMA_VERSION,
  context: Readonly<Record<string, unknown>> = config,
  layers: MigrationLayer = {},
): string[] {
  let version = requireCurrent(documentVersion(config), current, 'config');
  if (version === current) return [];
  const before = deepCopyRecord(config);
  let providerStage: Record<string, unknown> | null = null;
  let structural: string[] = [];
  while (version < current) {
    migrateModels(config, version, context);
    migrateRoles(config, version, context);
    // Version 4 to 5 renames and reshapes keys for every provider alike.
    if (version === 4) {
      providerStage = deepCopyRecord(config);
      structural = liftConfigAgents(config);
    }
    if (version === 5) {
      structural.push(...liftConfigClients({
        layer: layers.layer ?? 'project',
        layerConfig: config,
        project: layers.project ?? config,
        local: layers.local ?? null,
        merged: layers.merged ?? context,
        clientIds: layers.clientIds ?? [],
      }));
    }
    version += 1;
  }
  config[SCHEMA_VERSION_FIELD] = current;
  const notes = [`${SCHEMA_VERSION_FIELD} -> ${String(config[SCHEMA_VERSION_FIELD])}`];
  // Provider steps ran on the shape they were written for; compare that shape, then list the lifts.
  const compared = providerStage ?? config;
  notes.push(...namedNotes(before.models ?? before.agents, compared.models ?? compared.agents, 'models'));
  notes.push(...namedNotes(before.roles, compared.roles, 'roles'));
  notes.push(...structural);
  return notes;
}

export function migrateWorkflow(
  workflow: Record<string, unknown>,
  config: Readonly<Record<string, unknown>>,
  current = SCHEMA_VERSION,
  clientIds: readonly string[] = [],
): string[] {
  let version = requireCurrent(documentVersion(workflow), current, 'workflow');
  if (version === current) return [];
  const before = deepCopyRecord(workflow);
  const semanticNotes: string[] = [];
  while (version < current) {
    if (version === 6) semanticNotes.push(...liftWorkflowArtifacts(workflow));
    migrateStages(workflow, config, version);
    if (version === 1) liftWorkflowCompletion(workflow);
    if (version === 2) liftWorkflowDecisions(workflow);
    if (version === 3) delete workflow.requires;
    if (version === 4) liftWorkflowAgents(workflow);
    if (version === 5) liftWorkflowClients(workflow, config, clientIds);
    version += 1;
  }
  workflow[SCHEMA_VERSION_FIELD] = current;
  return [...workflowNotes(before, workflow), ...semanticNotes];
}

const ARTIFACT_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
/**
 * Schema 7 replaces `produces.artifact` plus top-level `outputs` with a registry. The whole workflow is
 * analysed first; any refusal throws before the document is changed, so nothing is written.
 * Returns the semantic changes the author must know about.
 */
function liftWorkflowArtifacts(workflow: Record<string, unknown>): string[] {
  const rawStages = Array.isArray(workflow.stages) ? workflow.stages : [];
  const hasProduces = rawStages.some((stage) => isRecord(stage) && Object.hasOwn(stage, 'produces'));
  if (!hasProduces && !Object.hasOwn(workflow, 'outputs')) return [];
  const probe = deepCopyRecord(workflow);
  probe[SCHEMA_VERSION_FIELD] = 6;
  const parsed = parseWorkflowMapping(probe, 'migrating workflow');
  const conditional = conditionalStages(parsed.stages);
  const outputs = parsed.outputs ?? [];
  const problems: string[] = [];
  const notes: string[] = [];
  const plans: { stage: Record<string, unknown>; stageId: string; id: string; file: string; required: boolean }[] = [];
  const byId = new Map<string, string>();
  const byFile = new Map<string, string>();
  const aliasTarget = new Map<string, string>();
  for (const raw of rawStages) {
    if (!isRecord(raw) || typeof raw.id !== 'string') continue;
    const stageId = raw.id.trim();
    const spec = parsed.stages[stageId];
    const file = spec?.artifacts[0]?.file;
    if (spec === undefined || file === undefined) continue;
    const named = outputs.filter((output) => output.fromStage === stageId);
    const id = named[0]?.name ?? stageId;
    if (!ARTIFACT_ID.test(id)) {
      problems.push(`stages.${stageId}: cannot derive an artifact id from ${named[0] === undefined ? 'the stage id' : `output ${JSON.stringify(id)}`}; rename it to letters, digits, "_" or "-" and start with a letter.`);
      continue;
    }
    const clash = byId.get(id);
    if (clash !== undefined) {
      problems.push(`stages.${stageId} and stages.${clash} both derive the artifact id ${id}; rename one output or stage.`);
      continue;
    }
    const sameFile = byFile.get(file);
    if (sameFile !== undefined) {
      problems.push(`stages.${stageId} and stages.${sameFile} both write ${file}; schema 7 publishes every artifact into outputs/, so rename one file.`);
      continue;
    }
    byId.set(id, stageId);
    byFile.set(file, stageId);
    const required = !conditional.has(stageId);
    plans.push({ stage: raw, stageId, id, file, required });
    for (const alias of named.slice(1)) aliasTarget.set(alias.name, id);
    if (named.length === 0) notes.push(`stages.${stageId}.produces.artifact is now published as artifact ${id} (it was unpublished in schema 6)`);
    if (!required) notes.push(`artifact ${id} comes from a run_when stage: it is now published when produced and declared required: false, so a turn may complete without ${file}`);
    for (const alias of named.slice(1)) notes.push(`output alias ${alias.name} merged into artifact ${id}; downstream runs without a mapping now receive one context name`);
  }
  if (problems.length > 0) {
    throw new ConfigurationError(`Cannot migrate artifacts to schema_version 7:\n- ${problems.join('\n- ')}`);
  }
  const registry: Record<string, unknown> = {};
  for (const plan of plans) {
    registry[plan.id] = plan.required ? { file: plan.file } : { file: plan.file, required: false };
    delete plan.stage.produces;
    plan.stage.artifacts = [plan.id];
  }
  for (const raw of rawStages) {
    if (isRecord(raw) && Object.hasOwn(raw, 'produces')) delete raw.produces;
  }
  if (Object.keys(registry).length > 0) workflow.artifacts = registry;
  delete workflow.outputs;
  if (Array.isArray(workflow.downstream)) {
    for (const entry of workflow.downstream) {
      if (!isRecord(entry) || !isRecord(entry.artifacts)) continue;
      for (const [name, value] of Object.entries(entry.artifacts)) {
        if (typeof value === 'string' && aliasTarget.has(value)) entry.artifacts[name] = aliasTarget.get(value);
      }
    }
  }
  return notes;
}

/** Version 5 selects an `agent` per stage; stage `options` no longer exist and are dropped. */
function liftWorkflowAgents(workflow: Record<string, unknown>): void {
  if (!Array.isArray(workflow.stages)) return;
  for (const stage of workflow.stages) {
    if (!isRecord(stage)) continue;
    if (Object.hasOwn(stage, 'model')) {
      if (Object.hasOwn(stage, 'agent')) {
        throw new ConfigurationError(`stages.${String(stage.id)} has both model and agent.`);
      }
      const lifted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(stage)) {
        if (key === 'model') {
          if ((value !== null && value !== undefined)) lifted.agent = value;
        } else {
          lifted[key] = value;
        }
      }
      for (const key of Object.keys(stage)) delete stage[key];
      Object.assign(stage, lifted);
    }
    delete stage.options;
  }
}

/** Version 2 has no completion block and no requires.decision. */
function liftWorkflowCompletion(workflow: Record<string, unknown>): void {
  const {completion} = workflow;
  if (isRecord(completion)) {
    refuseForeignCompleteRoutes(workflow, completion);
    const {outputs} = completion;
    const emptyOutputs =
      (outputs === null || outputs === undefined) || outputs === false || (isRecord(outputs) && Object.keys(outputs).length === 0);
    if (!emptyOutputs) workflow.outputs = deepCopy(outputs);
    delete workflow.completion;
  } else if (Object.hasOwn(workflow, 'completion')) {
    delete workflow.completion;
  }
  const {requires} = workflow;
  if (!isRecord(requires)) return;
  delete requires.decision;
  if (Object.keys(requires).length === 0) delete workflow.requires;
}

/** Keep existing prose criteria; migration cannot infer a new decision policy. */
function liftWorkflowDecisions(workflow: Record<string, unknown>): void {
  if (!Array.isArray(workflow.stages)) return;
  for (const stage of workflow.stages) {
    if (!isRecord(stage) || (stage.decision === null || stage.decision === undefined) || Array.isArray(stage.decision)) continue;
    const field = `stages.${String(stage.id)}.decision`;
    const {decision} = stage;
    if (isRecord(decision) && Object.keys(decision).length === 0) {
      delete stage.decision;
      continue;
    }
    if (!isRecord(decision) || !Array.isArray(decision.values) || !isRecord(decision.routes)) {
      throw new ConfigurationError(`${field} requires values and routes before migration.`);
    }
    const {routes} = decision;
    const names = decision.values.map((value) => typeof value === 'string' ? value.trim().toLowerCase() : '');
    const targets = new Map(Object.entries(routes).map(([key, value]) => [key.trim().toLowerCase(), value]));
    if (names.length === 0 || names.some((name) => !name || !targets.has(name)) ||
        new Set(names).size !== names.length || targets.size !== Object.keys(routes).length ||
        targets.size !== names.length) {
      throw new ConfigurationError(`${field}.routes keys must match unique decision.values.`);
    }
    stage.decision = names.map((name) => ({
      [name]: { navigate: targets.get(name) },
    }));
  }
}

function refuseForeignCompleteRoutes(
  workflow: Record<string, unknown>,
  completion: Record<string, unknown>,
): void {
  const completionStage = typeof completion.stage === 'string' ? completion.stage.trim() : '';
  const completionDecision =
    typeof completion.decision === 'string' && completion.decision.trim() !== ''
      ? completion.decision.trim().toLowerCase()
      : null;
  const {stages} = workflow;
  if (!Array.isArray(stages)) return;
  for (const stage of stages) {
    if (!isRecord(stage)) continue;
    const stageId = typeof stage.id === 'string' ? stage.id.trim() : '';
    const {decision} = stage;
    if (!isRecord(decision) || !isRecord(decision.routes)) continue;
    for (const [rawKey, rawTarget] of Object.entries(decision.routes)) {
      const routeKey = rawKey.trim().toLowerCase();
      if (!routeListsComplete(rawTarget)) continue;
      if (stageId !== completionStage) {
        throw new ConfigurationError(
          `stages.${stageId}.decision.routes.${routeKey} routes to complete, but completion.stage is ${completionStage || 'missing'}.`,
        );
      }
      if (completionDecision !== null && routeKey !== completionDecision) {
        throw new ConfigurationError(
          `stages.${stageId}.decision.routes.${routeKey} routes to complete, but completion.decision is ${completionDecision}.`,
        );
      }
    }
  }
}

function routeListsComplete(target: unknown): boolean {
  if (typeof target === 'string') return target.trim() === 'complete';
  if (!Array.isArray(target)) return false;
  return target.some((item) => typeof item === 'string' && item.trim() === 'complete');
}

function requireCurrent(version: number, current: number, label: string): number {
  if (version > current) {
    throw new ConfigurationError(
      `${label} ${SCHEMA_VERSION_FIELD} ${version} is newer than this Migent (${current}).`,
    );
  }
  return version;
}

function workflowNotes(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): string[] {
  const notes = stageNotes(before, after);
  if (Object.hasOwn(before, 'completion') && !Object.hasOwn(after, 'completion')) notes.push('completion removed');
  if (!Object.hasOwn(before, 'outputs') && Object.hasOwn(after, 'outputs')) notes.push('completion.outputs -> outputs');
  const beforeRequires = isRecord(before.requires) ? before.requires : null;
  const afterRequires = isRecord(after.requires) ? after.requires : null;
  if (Object.hasOwn(before, 'requires') && !Object.hasOwn(after, 'requires')) {
    notes.push('requires removed; use --prior for context and add downstream suggestions to the producer manually');
  }
  if (
    beforeRequires !== null &&
    Object.hasOwn(beforeRequires, 'decision') &&
    (afterRequires === null || !Object.hasOwn(afterRequires, 'decision'))
  ) {
    notes.push('requires.decision removed');
  }
  return notes;
}

function stageNotes(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): string[] {
  const notes = [`${SCHEMA_VERSION_FIELD} -> ${String(after[SCHEMA_VERSION_FIELD])}`];
  const beforeStages = stagesById(before.stages);
  const afterStages = stagesById(after.stages);
  for (const [stageId, stage] of beforeStages) {
    const updated = afterStages.get(stageId);
    if (updated === undefined) continue;
    notes.push(...bodyNotes(stage, updated, `stages.${stageId}`));
    if (Object.hasOwn(stage, 'model') && Object.hasOwn(updated, 'agent') && !Object.hasOwn(updated, 'model')) {
      notes.push(`stages.${stageId}.model -> agent`);
    }
    if (!deepEqual(stage.decision, updated.decision)) {
      notes.push(`stages.${stageId}.decision migrated (existing criteria remain in stage instructions)`);
    }
  }
  return notes;
}

function namedNotes(before: unknown, after: unknown, label: string): string[] {
  if (!isRecord(before) || !isRecord(after)) return [];
  const notes: string[] = [];
  for (const name of Object.keys(before)) {
    const previous = before[name];
    const updated = after[name];
    if (Object.hasOwn(after, name) && isRecord(previous) && isRecord(updated)) {
      notes.push(...bodyNotes(previous, updated, `${label}.${name}`));
    }
  }
  return notes;
}

function bodyNotes(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  label: string,
): string[] {
  const notes: string[] = [];
  const beforeOptions = isRecord(before.options) ? before.options : {};
  const afterOptions = isRecord(after.options) ? after.options : {};
  const removed = Object.keys(beforeOptions).filter((key) => !Object.hasOwn(afterOptions, key));
  const added = Object.keys(afterOptions).filter((key) => !Object.hasOwn(beforeOptions, key));
  const renamedOption = removed.length === 1 && removed[0] === 'thinking' && added.length === 1;
  const movedScalar =
    Object.hasOwn(before, 'thinking') &&
    !Object.hasOwn(after, 'thinking') &&
    removed.length === 0 &&
    added.length === 1;
  const [addedName] = added;
  if (renamedOption && addedName !== undefined) {
    notes.push(`${label}.options.thinking -> ${addedName}`);
  } else if (movedScalar && addedName !== undefined) {
    notes.push(`${label}.thinking -> options.${addedName}`);
  } else {
    notes.push(...removed.map((key) => `${label}.options.${key} removed`));
    if (label.startsWith('stages.') && removed.length > 0 && !Object.hasOwn(after, 'options')) {
      notes.push(`${label}.options removed in schema_version 5; set options on an inline ${label}.agent if the stage still needs them`);
    }
    notes.push(...added.map((key) => `${label}.options.${key} set`));
    if (Object.hasOwn(before, 'thinking') && !Object.hasOwn(after, 'thinking')) {
      notes.push(`${label}.thinking removed`);
    }
  }
  return notes;
}

