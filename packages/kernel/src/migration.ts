/** Upgrade config and workflow documents from the version they record.

Version steps are built into this module. The v0 "thinking" tables live in
`migration-legacy.ts`, keyed by the historical provider ID. This module walks
the steps and writes the resulting schema_version. A missing schema_version is
version 0. Writes stay on the text patchers.
*/
import { documentVersion, isRecord } from '@nodeint/migent-workflow';
import { conditionalStages, parseWorkflowMapping,SCHEMA_VERSION } from '@nodeint/migent-workflow';
import { parseYamlDocument } from '@nodeint/migent-workflow';
import { stringify } from 'yaml';

import { renderAuthoringYaml } from './authoring.js';
import { ConfigEditError, yamlScalar } from './config-edit.js';
import { ConfigurationError } from './errors.js';
import { type ConfigLayerKind,liftConfigAgents, liftConfigClients, liftWorkflowClients } from './migration-config.js';
import { applyLegacyMigration } from './migration-legacy.js';


const SCHEMA_VERSION_FIELD = 'schema_version';

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

type Edit = [number, number, string[]];

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
const AMBIGUOUS_SCALAR = /^(null|true|false|yes|no|on|off|y|n)$/i;

/** An artifact id as a YAML flow scalar; words YAML may read as null or boolean stay strings. */
function artifactIdScalar(id: string): string {
  return AMBIGUOUS_SCALAR.test(id) ? JSON.stringify(id) : yamlScalar(id);
}

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

export function patchWorkflowText(original: string, updated: Readonly<Record<string, unknown>>): string {
  if (original.includes('\t')) throw new ConfigEditError('Cannot edit a workflow that uses tabs.');
  const current = parseYamlDocument(original);
  if (!isRecord(current)) throw new ConfigEditError('Workflow must be a mapping.');
  const lines = splitLines(original);
  const edits: Edit[] = [];
  insertSchemaVersion(lines, updated, edits);
  syncChangedStages(lines, current, updated, edits);
  syncDocumentShape(lines, current, updated, edits);
  const text = applyEdits(original, lines, edits);
  assertMigratedWorkflow(text, updated);
  return text;
}

/** The migrated document must load and must not retain removed fields. */
function assertMigratedWorkflow(text: string, updated: Readonly<Record<string, unknown>>): void {
  if (documentVersion(updated) < 2) return;
  const parsed = parseYamlDocument(text);
  if (!isRecord(parsed)) throw new ConfigEditError('Workflow must be a mapping.');
  if (Object.hasOwn(parsed, 'completion')) {
    throw new ConfigurationError('migration left completion in the workflow.');
  }
  const {requires} = parsed;
  if (isRecord(requires) && Object.hasOwn(requires, 'decision')) {
    throw new ConfigurationError('migration left requires.decision in the workflow.');
  }
  parseWorkflowMapping(parsed, 'migrated workflow');
  if (!deepEqual(parsed, updated)) {
    throw new ConfigEditError('Workflow text does not match the migrated document.');
  }
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

function migrateModels(
  config: Record<string, unknown>,
  version: number,
  context: Readonly<Record<string, unknown>>,
): void {
  const {models} = config;
  if (!isRecord(models)) return;
  for (const [name, body] of Object.entries(models)) {
    if (!isRecord(body)) continue;
    const provider = providerName(body.provider) ?? modelProvider(context, name);
    applyLegacyMigration('model', provider, version, body);
  }
}

function migrateRoles(
  config: Record<string, unknown>,
  version: number,
  context: Readonly<Record<string, unknown>>,
): void {
  const {roles} = config;
  if (!isRecord(roles)) return;
  for (const [name, body] of Object.entries(roles)) {
    if (!isRecord(body)) continue;
    const effectiveRoles = context.roles;
    const effectiveRole = isRecord(effectiveRoles) ? effectiveRoles[name] : null;
    const provider = roleProvider(
      context,
      Object.hasOwn(body, 'default_model') || Object.hasOwn(body, 'agent') ? body : isRecord(effectiveRole) ? effectiveRole : body,
    );
    applyLegacyMigration('role', provider, version, body);
  }
}

function migrateStages(
  workflow: Record<string, unknown>,
  config: Readonly<Record<string, unknown>>,
  version: number,
): void {
  const {stages} = workflow;
  if (!Array.isArray(stages)) return;
  for (const stage of stages) {
    if (!isRecord(stage)) continue;
    const provider = stageProvider(config, stage);
    applyLegacyMigration('stage', provider, version, stage);
  }
}

/** Reads the provider of a role's agent in either document shape: `agent` or the earlier `default_model`. */
function roleProvider(config: Readonly<Record<string, unknown>>, role: Readonly<Record<string, unknown>>): string | null {
  const selection = Object.hasOwn(role, 'agent') ? role.agent : role.default_model;
  if (isRecord(selection)) return bodyProvider(selection);
  if (typeof selection !== 'string') return null;
  return modelProvider(config, selection);
}

function stageProvider(config: Readonly<Record<string, unknown>>, stage: Readonly<Record<string, unknown>>): string | null {
  const selection = Object.hasOwn(stage, 'agent') ? stage.agent : stage.model;
  if (isRecord(selection)) return bodyProvider(selection);
  if (typeof selection === 'string' && selection.trim() !== '') return modelProvider(config, selection);
  const roleName = stage.role;
  if (typeof roleName !== 'string') return null;
  const {roles} = config;
  if (!isRecord(roles)) return null;
  const role = roles[roleName.trim()];
  if (!isRecord(role)) return null;
  return roleProvider(config, role);
}

function modelProvider(config: Readonly<Record<string, unknown>>, modelName: string): string | null {
  const models = isRecord(config.agents) ? config.agents : config.models;
  if (!isRecord(models)) return null;
  const model = models[modelName.trim()];
  if (!isRecord(model)) return null;
  return bodyProvider(model);
}

/** A body's own `provider`, else the legacy provider its `client.type` was lifted from. */
function bodyProvider(body: Readonly<Record<string, unknown>>): string | null {
  const provider = providerName(body.provider);
  if (provider !== null) return provider;
  const {client} = body;
  return providerName(isRecord(client) ? client.type : client);
}

function providerName(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim();
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

function stagesById(raw: unknown): Map<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(raw)) return found;
  for (const stage of raw) {
    if (!isRecord(stage)) continue;
    const stageId = stage.id;
    if (typeof stageId === 'string' && stageId.trim() !== '') found.set(stageId.trim(), stage);
  }
  return found;
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

function insertSchemaVersion(lines: string[], updated: Readonly<Record<string, unknown>>, edits: Edit[]): void {
  const value = updated[SCHEMA_VERSION_FIELD];
  if (typeof value === 'boolean' || typeof value !== 'number' || !Number.isInteger(value)) return;
  const rendered = `${SCHEMA_VERSION_FIELD}: ${value}`;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const [key] = mappingKey(line);
    if (key === SCHEMA_VERSION_FIELD && contentIndent(line) === 0) {
      const [current, comment] = splitComment(line);
      const raw = current.split(':').slice(1).join(':');
      if (raw.trim() === String(value)) return;
      let replacement = `${SCHEMA_VERSION_FIELD}: ${value}`;
      if (comment !== '') replacement = `${replacement} ${comment}`;
      edits.push([index, index + 1, [replacement]]);
      return;
    }
  }
  let insert = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    if (contentIndent(lines[index] ?? '') !== null) {
      insert = index;
      break;
    }
  }
  edits.push([insert, insert, [rendered, '']]);
}

function syncChangedStages(
  lines: string[],
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  edits: Edit[],
): void {
  const beforeStages = stagesById(before.stages);
  const afterStages = stagesById(after.stages);
  for (const [stageId, start, end] of stageSpans(lines)) {
    const previous = beforeStages.get(stageId);
    const updated = afterStages.get(stageId);
    if (previous === undefined || updated === undefined) continue;
    if (deepEqual(previous, updated)) continue;
    patchStage(lines, start, end, previous, updated, edits);
  }
}

function patchStage(
  lines: string[],
  start: number,
  end: number,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  edits: Edit[],
): void {
  const info = lines.slice(start, end).map((line) => lineInfo(line));
  const content: [number, LineInfo][] = [];
  for (let index = 0; index < info.length; index += 1) {
    const item = info[index];
    if (item !== null) content.push([index, item]);
  }
  if (content.length === 0) return;
  const [first] = content;
  if (first === undefined) return;
  const firstIndent = first[1].indent;
  const siblingIndent = siblingIndentOf(content, firstIndent);
  const unit = siblingIndent > firstIndent ? siblingIndent - firstIndent : 2;
  if (!deepEqual(before.agent, after.agent) && Object.hasOwn(after, 'agent') && !Object.hasOwn(before, 'model')) {
    const span = nestedKeySpan(lines, { start, end }, 'agent');
    if (span === null) throw new ConfigEditError('Cannot locate the stage agent to migrate.');
    const base = lines.slice(span[0], span[1]).map((line) => line.slice(siblingIndent)).join('\n');
    const result = renderAuthoringYaml({ agent: after.agent }, base);
    if (!result.preserved) throw new ConfigEditError(`Cannot preserve the stage agent: ${result.reason}.`);
    edits.push([span[0], span[1], result.text.trimEnd().split('\n').map((line) => `${' '.repeat(siblingIndent)}${line}`)]);
  }
  if (Object.hasOwn(before, 'produces') && !Object.hasOwn(after, 'produces')) {
    const span = nestedKeySpan(lines, { start, end }, 'produces');
    if (span === null) throw new ConfigEditError('Cannot locate the stage produces to migrate.');
    const ids = Array.isArray(after.artifacts) ? after.artifacts : [];
    edits.push([span[0], span[1], ids.length > 0 ? [`${' '.repeat(siblingIndent)}artifacts: [${ids.map((id) => artifactIdScalar(String(id))).join(', ')}]`] : []]);
  }
  if (!deepEqual(before.decision, after.decision)) {
    const span = nestedKeySpan(lines, { start, end }, 'decision');
    if (span === null) throw new ConfigEditError('Cannot locate the stage decision to migrate.');
    const replacement = Object.hasOwn(after, 'decision')
      ? renderTopLevel('decision', after.decision).map((line) => `${' '.repeat(siblingIndent)}${line}`)
      : [];
    edits.push([span[0], span[1], replacement]);
  }
  if (Object.hasOwn(before, 'model') && Object.hasOwn(after, 'agent') && !Object.hasOwn(after, 'model')) {
    for (const [index, item] of content) {
      if (item.indent !== siblingIndent || item.key !== 'model') continue;
      const text = lines[start + index] ?? '';
      const match = /^(\s*)(["']?)model\2(\s*:)/.exec(text);
      if (match !== null) edits.push([start + index, start + index + 1, [`${match[1]}agent${text.slice(match[0].length - match[3]!.length)}`]]);
      break;
    }
  }
  if (Object.hasOwn(before, 'options') && !Object.hasOwn(after, 'options')) {
    for (const [index, item] of content) {
      if (item.indent !== siblingIndent || item.key !== 'options' || item.rest === '') continue;
      // A flow-style `options: {..}` has no nested lines to sync; drop the whole entry.
      edits.push([start + index, optionsEnd(lines, start + index, siblingIndent, end), []]);
      break;
    }
  }
  let optionsAt: number | null = null;
  let optionIndent: number | null = null;
  let inOptions = false;
  const optionLines = new Map<string, number>();
  let thinkingAt: number | null = null;
  for (const [index, item] of content) {
    if (inOptions && item.indent <= siblingIndent) inOptions = false;
    if (inOptions && item.key !== null && item.rest !== '') {
      if (optionIndent === null) optionIndent = item.indent;
      if (item.indent === optionIndent) optionLines.set(item.key, start + index);
      continue;
    }
    if (item.indent !== siblingIndent || item.key === null) continue;
    if (item.key === 'options' && item.rest === '') {
      optionsAt = start + index;
      inOptions = true;
      continue;
    }
    if (item.key === 'thinking' && item.rest !== '') thinkingAt = start + index;
  }
  const beforeOptions = isRecord(before.options) ? before.options : {};
  const afterOptions = isRecord(after.options) ? after.options : {};
  if (!deepEqual(beforeOptions, afterOptions)) {
    syncStageOptions(
      lines,
      afterOptions,
      beforeOptions,
      optionLines,
      optionsAt,
      optionIndent ?? siblingIndent + unit,
      siblingIndent,
      end,
      edits,
    );
  }
  if (Object.hasOwn(before, 'thinking') && !Object.hasOwn(after, 'thinking') && thinkingAt !== null) {
    edits.push([thinkingAt, thinkingAt + 1, []]);
  }
}

function syncStageOptions(
  lines: string[],
  after: Readonly<Record<string, unknown>>,
  before: Readonly<Record<string, unknown>>,
  optionLines: ReadonlyMap<string, number>,
  optionsAt: number | null,
  optionIndent: number,
  siblingIndent: number,
  stageEnd: number,
  edits: Edit[],
): void {
  const afterText = new Map<string, string>();
  for (const [key, value] of Object.entries(after)) {
    if (typeof value === 'string' && value.trim() !== '') afterText.set(key, value.trim());
  }
  const beforeKeys = new Set(Object.keys(before));
  if (afterText.size === 0) {
    if (optionsAt !== null) edits.push([optionsAt, optionsEnd(lines, optionsAt, siblingIndent, stageEnd), []]);
    return;
  }
  if (optionsAt === null) {
    const indent = ' '.repeat(siblingIndent);
    const nested = ' '.repeat(optionIndent);
    const block = [`${indent}options:`];
    for (const name of sorted(afterText.keys())) block.push(`${nested}${name}: ${yamlScalar(afterText.get(name) ?? '')}`);
    edits.push([stageEnd, stageEnd, block]);
    return;
  }
  const afterNames = new Set(afterText.keys());
  for (const name of sorted([...beforeKeys].filter((key) => !afterNames.has(key)))) {
    const lineIndex = optionLines.get(name);
    if (lineIndex !== undefined) edits.push([lineIndex, lineIndex + 1, []]);
  }
  for (const name of sorted(afterText.keys())) {
    const rendered = `${' '.repeat(optionIndent)}${name}: ${yamlScalar(afterText.get(name) ?? '')}`;
    const lineIndex = optionLines.get(name);
    if (lineIndex === undefined) {
      const insertAt = optionsEnd(lines, optionsAt, siblingIndent, stageEnd);
      edits.push([insertAt, insertAt, [rendered]]);
      continue;
    }
    const [current] = splitComment(lines[lineIndex] ?? '');
    const raw = current.split(':').slice(1).join(':');
    if (unquote(raw.trim()) !== afterText.get(name)) {
      const [code, comment] = splitComment(lines[lineIndex] ?? '');
      const colon = code.indexOf(':');
      const key = colon < 0 ? code : code.slice(0, colon);
      let updated = `${key}: ${yamlScalar(afterText.get(name) ?? '')}`;
      if (comment !== '') updated = `${updated} ${comment}`;
      edits.push([lineIndex, lineIndex + 1, [updated]]);
    }
  }
}

function optionsEnd(lines: string[], optionsAt: number, siblingIndent: number, stageEnd: number): number {
  let end = optionsAt + 1;
  for (let index = optionsAt + 1; index < stageEnd; index += 1) {
    const item = lineInfo(lines[index] ?? '');
    if (item === null) continue;
    if (item.indent <= siblingIndent) break;
    end = index + 1;
  }
  return end;
}

function siblingIndentOf(content: [number, LineInfo][], firstIndent: number): number {
  let sibling: number | null = null;
  for (const [, item] of content.slice(1)) {
    if (item.indent <= firstIndent) continue;
    sibling = sibling === null ? item.indent : Math.min(sibling, item.indent);
  }
  return sibling === null ? firstIndent : sibling;
}

function stageSpans(lines: string[]): [string, number, number][] {
  const spans: [string, number, number][] = [];
  let inStages = false;
  let listIndent: number | null = null;
  let start: number | null = null;
  let stageId: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const item = lineInfo(line);
    if (item === null) continue;
    if (!inStages) {
      if (item.indent === 0 && item.key === 'stages' && item.rest === '') inStages = true;
      continue;
    }
    if (item.indent === 0) {
      if (start !== null && stageId !== null) spans.push([stageId, start, index]);
      start = null;
      break;
    }
    const text = codeOf(line);
    if (listIndent === null && (text.startsWith('- ') || text === '-')) listIndent = item.indent;
    if (listIndent !== null && item.indent === listIndent && (text.startsWith('- ') || text === '-')) {
      if (start !== null && stageId !== null) spans.push([stageId, start, index]);
      start = index;
      stageId = idOnDash(text);
      continue;
    }
    if (start !== null && stageId === null && item.key === 'id' && item.rest !== '') stageId = unquote(item.rest);
  }
  if (start !== null && stageId !== null) spans.push([stageId, start, lines.length]);
  return spans;
}

function idOnDash(text: string): string | null {
  const body = text.startsWith('- ') ? text.slice(2).trim() : '';
  if (body === '') return null;
  const colon = body.indexOf(':');
  if (colon < 0) return null;
  const key = body.slice(0, colon).trim();
  const rest = body.slice(colon + 1);
  if (key !== 'id' || rest.trim() === '') return null;
  const [first] = rest.trim().split(/\s+/);
  return first === undefined ? null : unquote(first);
}

interface LineInfo {
  indent: number;
  key: string | null;
  rest: string;
  comment: string;
}

function lineInfo(line: string): LineInfo | null {
  const indent = contentIndent(line);
  if (indent === null) return null;
  const [key, rest, comment] = mappingKey(line);
  return { indent, key, rest, comment };
}

function mappingKey(line: string): [string | null, string, string] {
  const [code, comment] = splitComment(line);
  let text = code.trim();
  if (text.startsWith('- ')) text = text.slice(2).trim();
  else if (text === '-') return [null, '', comment];
  const colon = text.indexOf(':');
  if (colon < 0) return [null, '', comment];
  const key = unquote(text.slice(0, colon).trim());
  if (key === '') return [null, '', comment];
  return [key, text.slice(colon + 1).trim(), comment];
}

function codeOf(line: string): string {
  const [code] = splitComment(line);
  return code.trim();
}

function contentIndent(line: string): number | null {
  const [code] = splitComment(line);
  if (code.trim() === '') return null;
  let index = 0;
  while (index < code.length && code[index] === ' ') index += 1;
  return index;
}

function splitComment(line: string): [string, string] {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === '#' && !inSingle && !inDouble) return [line.slice(0, index).trimEnd(), line.slice(index)];
  }
  return [line.trimEnd(), ''];
}

function unquote(value: string): string {
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

interface LineSpan {
  start: number;
  end: number;
}

function syncDocumentShape(
  lines: string[],
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  edits: Edit[],
): void {
  const spans = topLevelSpans(lines);
  for (const [key, span] of spans) {
    if (key === 'stages') continue;
    if (!Object.hasOwn(after, key)) edits.push([span.start, span.end, []]);
  }
  for (const key of Object.keys(after)) {
    if (key === SCHEMA_VERSION_FIELD || key === 'stages') continue;
    if (spans.has(key) || Object.hasOwn(before, key)) continue;
    const rendered = renderTopLevel(key, after[key]);
    if (rendered.length > 0) edits.push([lines.length, lines.length, rendered]);
  }
  for (const [key, span] of spans) {
    if (key === 'stages' || !Object.hasOwn(after, key)) continue;
    const previous = before[key];
    const next = after[key];
    if (key === 'downstream' && !deepEqual(previous, next)) {
      edits.push([span.start, span.end, renderTopLevel(key, next)]);
      continue;
    }
    if (!isRecord(previous) || !isRecord(next)) continue;
    const removed = Object.keys(previous).filter((nested) => !Object.hasOwn(next, nested));
    if (removed.length === 0) continue;
    const header = lineInfo(lines[span.start] ?? '');
    const flow = header !== null && (header.rest.startsWith('{') || header.rest.startsWith('['));
    // A flow value has no nested key line. Rewrite the parent from the migrated mapping.
    if (flow || removed.some((nested) => nestedKeySpan(lines, span, nested) === null)) {
      edits.push([span.start, span.end, renderTopLevel(key, next)]);
      continue;
    }
    for (const nested of removed) {
      const range = nestedKeySpan(lines, span, nested);
      if (range !== null) edits.push([range[0], range[1], []]);
    }
  }
}

function topLevelSpans(lines: string[]): Map<string, LineSpan> {
  const spans = new Map<string, LineSpan>();
  let current: { key: string; start: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const item = lineInfo(lines[index] ?? '');
    if (item === null || item.indent !== 0 || item.key === null) continue;
    if (current !== null && !spans.has(current.key)) spans.set(current.key, { start: current.start, end: index });
    current = { key: item.key, start: index };
  }
  if (current !== null && !spans.has(current.key)) spans.set(current.key, { start: current.start, end: lines.length });
  return spans;
}

function nestedKeySpan(lines: string[], parent: LineSpan, key: string): [number, number] | null {
  let childIndent: number | null = null;
  for (let index = parent.start + 1; index < parent.end; index += 1) {
    const item = lineInfo(lines[index] ?? '');
    if (item === null || item.key === null) continue;
    if (childIndent === null || item.indent < childIndent) childIndent = item.indent;
  }
  if (childIndent === null) return null;
  for (let index = parent.start + 1; index < parent.end; index += 1) {
    const item = lineInfo(lines[index] ?? '');
    if (item === null || item.key !== key || item.indent !== childIndent) continue;
    return [index, nestedValueEnd(lines, parent.end, index, item)];
  }
  return null;
}

function nestedValueEnd(lines: string[], parentEnd: number, index: number, item: LineInfo): number {
  let end = index + 1;
  for (let nested = index + 1; nested < parentEnd; nested += 1) {
    const next = lineInfo(lines[nested] ?? '');
    // A blank or comment line stays in the value. The next sibling key ends it.
    if (next !== null && next.key !== null && next.indent <= item.indent) break;
    end = nested + 1;
  }
  return end;
}

function renderTopLevel(key: string, value: unknown): string[] {
  if ((value === null || value === undefined)) return [];
  return splitLines(stringify({ [key]: value }, { lineWidth: 0 }));
}

function applyEdits(original: string, lines: string[], edits: Edit[]): string {
  const numbered = edits.map((edit, order) => ({ order, edit }));
  numbered.sort((left, right) => {
    if (left.edit[0] !== right.edit[0]) return right.edit[0] - left.edit[0];
    if (left.edit[1] !== right.edit[1]) return right.edit[1] - left.edit[1];
    return right.order - left.order;
  });
  for (const { edit } of numbered) {
    const [start, end, replacement] = edit;
    lines.splice(start, end - start, ...replacement);
  }
  let text = lines.join('\n');
  if (original.endsWith('\n') || original === '') text += '\n';
  return text;
}

function sorted(keys: Iterable<string>): string[] {
  return [...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

function deepCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => deepCopy(item));
  if (isRecord(value)) return deepCopyRecord(value);
  return value;
}

function deepCopyRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) copy[key] = deepCopy(item);
  return copy;
}

// Python str.splitlines(): a trailing break does not yield an empty line.
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
