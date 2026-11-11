
import { ARTIFACT_ID_PATTERN, isValid,WorkflowArtifact, WorkflowDecisionEntry } from '@nodeint/migent-contracts';

import type { DraftUnit } from './draft/problems.js';
import { ConfigurationError } from './errors.js';
import { dependencyClosure, isLeafStage, routeTargets } from './graph.js';
import type { ArtifactSpec, StageArtifact, StageSpec, WorkflowCompletion, WorkflowOutput } from './model.js';
import { VERIFY_ARTIFACT } from './model.js';
import { isRecord, pyRepr } from './record.js';
import { workflowCompletionSchema, workflowOutputSchema } from './schema.js';
import { filename, requiredString, stageHasRole } from './stage-fields.js';
import { containerError, DOCUMENT_FIELD_SCHEMAS } from './structure.js';

export function parseTopLevelOutputs(raw: unknown, stages: Record<string, StageSpec>): WorkflowOutput[] {
  if ((raw === null || raw === undefined)) return [];
  return parseOutputItems(raw, stages, 'outputs');
}

export function parseOutputItems(
  raw: unknown,
  stages: Record<string, StageSpec>,
  field: string,
): WorkflowOutput[] {
  let outputsRaw: unknown = raw === false ? [] : raw;
  if (isRecord(outputsRaw) && Object.keys(outputsRaw).length === 0) outputsRaw = [];
  if (!Array.isArray(outputsRaw)) throw new ConfigurationError(`${field} must be a list.`);
  const outputs: WorkflowOutput[] = [];
  const seen = new Set<string>();
  for (const item of outputsRaw) {
    const output = parseOutputItem(item, stages, { field, seen });
    seen.add(output.name);
    const [sourceArtifact] = stages[output.fromStage].artifacts;
    sourceArtifact.scope = 'published';
    outputs.push(output);
  }
  return outputs;
}

/** Validates one output item against the names seen so far and its source stage's first artifact. */
function parseOutputItem(
  item: unknown,
  stages: Record<string, StageSpec>,
  { field, seen }: { field: string; seen: ReadonlySet<string> },
): WorkflowOutput {
  if (!isRecord(item)) throw new ConfigurationError(`${field} item must be a mapping.`);
  const name = filename(item.name, `${field}.name`);
  const fromStage = requiredString(item.from_stage, `${field}.from_stage`);
  const artifact = filename(item.artifact, `${field}.artifact`);
  if (seen.has(name)) throw new ConfigurationError(`Duplicate ${field} name: ${name}`);
  if (!Object.hasOwn(stages, fromStage)) {
    throw new ConfigurationError(`${field}.from_stage is not a declared stage: ${fromStage}`);
  }
  const sourceFile = stages[fromStage].artifacts[0]?.file ?? null;
  if (sourceFile === null) {
    throw new ConfigurationError(
      `${field} ${pyRepr(name)} references stage ${fromStage} which does not produce an artifact.`,
    );
  }
  if (sourceFile !== artifact) {
    throw new ConfigurationError(
      `${field} ${pyRepr(name)} artifact ${pyRepr(artifact)} does not match stages.${fromStage}.produces.artifact ${pyRepr(sourceFile)}.`,
    );
  }
  return workflowOutputSchema.parse({ name, fromStage, artifact });
}

export function legacyArtifacts(stageId: string, artifact: DraftUnit<string | null>): StageArtifact[] {
  return artifact.state === 'valid' && artifact.value !== null
    ? [{ id: stageId, file: artifact.value, description: null, required: true, scope: 'local' }]
    : [];
}

export function outputOfArtifact(artifact: ArtifactSpec): WorkflowOutput {
  return {
    name: artifact.id,
    fromStage: artifact.producer.stage,
    artifact: artifact.file,
    required: artifact.required,
    decision: artifact.producer.decision,
  };
}

export interface ArtifactProblem {
  code: string;
  message: string;
  path: (string | number)[];
}

export interface ArtifactBuild {
  registry: ArtifactSpec[];
  perStage: Map<string, { artifacts: StageArtifact[]; decisionArtifacts: Record<string, StageArtifact[]> }>;
  problems: ArtifactProblem[];
}

export const ARTIFACT_ID = new RegExp(ARTIFACT_ID_PATTERN);

export const DECISION_ENTRY_KEYS: readonly string[] = Object.keys(WorkflowDecisionEntry.properties);

export const ARTIFACT_KEYS: readonly string[] = Object.keys(WorkflowArtifact.properties);

type ArtifactPath = (string | number)[];

type FailArtifact = (message: string, at: ArtifactPath) => void;

type StageArtifactEntry = { artifacts: StageArtifact[]; decisionArtifacts: Record<string, StageArtifact[]> };

type ArtifactProducers = Map<string, { stage: string; decision: string | null }[]>;

/** Shared state while one stage's artifact references and inline definitions are read. */
interface StageArtifactScope {
  readonly fail: FailArtifact;
  readonly declared: ReadonlyMap<string, StageArtifact>;
  readonly producers: ArtifactProducers;
  readonly conditional: ReadonlyMap<string, string>;
  readonly stageId: string;
  readonly stageField: string;
  readonly filesInStage: Map<string, string>;
  readonly localIds: Set<string>;
}

/**
 * Reads the schema 7 artifact declarations from the raw mapping: the top-level registry, stage
 * references and decision artifacts. It collects every problem it can name, so the strict parser
 * reports the first and the draft collector reports all. `conditional` maps each stage in a
 * `run_when` reach to the stage that reaches it.
 */
export function buildArtifactsV7(
  data: Record<string, unknown>,
  conditional: ReadonlyMap<string, string>,
): ArtifactBuild {
  const problems: ArtifactProblem[] = [];
  const fail: FailArtifact = (message, at) => {
    problems.push({ code: 'invalid-artifact', message, path: at });
  };
  const declared = readArtifactRegistry(data.artifacts, fail);
  const producers: ArtifactProducers = new Map();
  const perStage: ArtifactBuild['perStage'] = new Map();
  const rawStages = Array.isArray(data.stages) ? data.stages : [];
  rawStages.forEach((rawStage, index) => {
    if (!isRecord(rawStage) || typeof rawStage.id !== 'string' || rawStage.id.trim() === '') return;
    const stageId = rawStage.id.trim();
    const scope: StageArtifactScope = {
      fail,
      declared,
      producers,
      conditional,
      stageId,
      stageField: `stages.${stageId}`,
      filesInStage: new Map(),
      localIds: new Set(),
    };
    perStage.set(stageId, collectStageArtifactEntry(scope, rawStage, ['stages', index]));
  });
  const registry = resolveArtifactProducers(declared, producers, fail);
  return { registry, perStage, problems };
}

/** Reads one artifact definition body, from the top-level registry or a decision's inline mapping. */
function readArtifactDefinition(
  id: string,
  body: unknown,
  where: { label: string; at: ArtifactPath; fail: FailArtifact },
): StageArtifact | null {
  const { label, at, fail } = where;
  if (!ARTIFACT_ID.test(id)) {
    fail(`Invalid ${label} id: ${pyRepr(id)}.`, at);
    return null;
  }
  const bodyError = containerError(WorkflowArtifact, body, label);
  if (bodyError !== null || !isRecord(body)) {
    fail(`${label} must be a mapping.`, at);
    return null;
  }
  const keysOk = checkArtifactKeys(body, where);
  const file = readArtifactFile(body, where);
  const description = readOptionalArtifactField(body, 'description', {
    ...where,
    message: `Missing or invalid ${label}.description.`,
  });
  const required = readOptionalArtifactField(body, 'required', {
    ...where,
    message: `${label}.required must be true or false.`,
  });
  if (!keysOk || file === null || description === INVALID || required === INVALID) return null;
  return {
    id,
    file,
    description: description === undefined ? null : description.trim(),
    required: required ?? true,
    scope: 'published',
  };
}

type ArtifactWhere = { label: string; at: ArtifactPath; fail: FailArtifact };

const INVALID = Symbol('invalid');

interface OptionalArtifactFields {
  description: string;
  required: boolean;
}

/** Reports every key of an artifact body that the schema does not allow. */
function checkArtifactKeys(body: Record<string, unknown>, { label, at, fail }: ArtifactWhere): boolean {
  let ok = true;
  for (const key of Object.keys(body)) {
    if (!ARTIFACT_KEYS.includes(key)) {
      fail(`${label}.${key} is not allowed.`, [...at, key]);
      ok = false;
    }
  }
  return ok;
}

/** Reads the artifact `file`, which must be a plain filename other than the verify artifact. */
function readArtifactFile(body: Record<string, unknown>, { label, at, fail }: ArtifactWhere): string | null {
  try {
    const file = filename(body.file, `${label}.file`);
    if (file === VERIFY_ARTIFACT) throw new ConfigurationError(`${label}.file cannot be ${VERIFY_ARTIFACT}.`);
    return file;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), [...at, 'file']);
    return null;
  }
}

/** Reads an optional schema-validated artifact field: `undefined` when absent, `INVALID` when rejected. */
function readOptionalArtifactField<K extends keyof OptionalArtifactFields>(
  body: Record<string, unknown>,
  key: K,
  { at, fail, message }: ArtifactWhere & { message: string },
): OptionalArtifactFields[K] | undefined | typeof INVALID {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (isValid(WorkflowArtifact.properties[key], value)) return value as unknown as OptionalArtifactFields[K];
  fail(message, [...at, key]);
  return INVALID;
}

/** Reads the top-level `artifacts` registry, rejecting two artifacts that share one file. */
function readArtifactRegistry(rawRegistry: unknown, fail: FailArtifact): Map<string, StageArtifact> {
  const declared = new Map<string, StageArtifact>();
  if (rawRegistry === undefined || rawRegistry === null) return declared;
  const registryError = containerError(DOCUMENT_FIELD_SCHEMAS.artifacts, rawRegistry, 'artifacts');
  if (registryError !== null) {
    fail(registryError.message, ['artifacts']);
    return declared;
  }
  const files = new Map<string, string>();
  for (const [id, body] of Object.entries(rawRegistry)) {
    const definition = readArtifactDefinition(id, body, { label: `artifacts.${id}`, at: ['artifacts', id], fail });
    if (definition === null) continue;
    const clash = files.get(definition.file);
    if (clash !== undefined) {
      fail(`artifacts.${id}.file ${pyRepr(definition.file)} is already used by artifacts.${clash}; outputs share one directory.`, ['artifacts', id, 'file']);
      continue;
    }
    files.set(definition.file, id);
    declared.set(id, definition);
  }
  return declared;
}

/** Reads a stage's `artifacts` references and each decision's artifacts into one per-stage entry. */
function collectStageArtifactEntry(
  scope: StageArtifactScope,
  rawStage: Record<string, unknown>,
  stageAt: ArtifactPath,
): StageArtifactEntry {
  const { fail, stageField } = scope;
  const hasRole = stageHasRole(rawStage);
  const entry: StageArtifactEntry = { artifacts: [], decisionArtifacts: {} };
  if (rawStage.artifacts !== undefined && rawStage.artifacts !== null) {
    const at = [...stageAt, 'artifacts'];
    if (!Array.isArray(rawStage.artifacts)) fail(`${stageField}.artifacts must be a list of artifact ids.`, at);
    else if (!hasRole && rawStage.artifacts.length > 0) fail(`${stageField}.artifacts requires a role.`, at);
    else entry.artifacts = collectArtifactReferences(scope, rawStage.artifacts, { field: `${stageField}.artifacts`, at, decision: null });
  }
  if (!Array.isArray(rawStage.decision)) return entry;
  rawStage.decision.forEach((rawEntry, entryIndex) => {
    if (!isRecord(rawEntry) || Object.keys(rawEntry).length !== 1) return;
    const [rawName] = Object.keys(rawEntry);
    const name = rawName.trim().toLowerCase();
    const body = rawEntry[rawName];
    if (!isRecord(body) || body.artifacts === undefined || body.artifacts === null) return;
    const field = `${stageField}.decision.${name}.artifacts`;
    const at: ArtifactPath = [...stageAt, 'decision', entryIndex, rawName, 'artifacts'];
    if (!hasRole) {
      fail(`${field} requires a role.`, at);
      return;
    }
    entry.decisionArtifacts[name] = collectDecisionArtifacts(scope, body.artifacts, { field, at, decision: name });
  });
  return entry;
}

/** Reads one decision's `artifacts`: a list of registry ids or a mapping of inline definitions. */
function collectDecisionArtifacts(
  scope: StageArtifactScope,
  rawArtifacts: unknown,
  where: { field: string; at: ArtifactPath; decision: string },
): StageArtifact[] {
  const { field, at } = where;
  if (Array.isArray(rawArtifacts)) return collectArtifactReferences(scope, rawArtifacts, where);
  if (!isRecord(rawArtifacts)) {
    scope.fail(`${field} must be a list of artifact ids or a mapping of inline artifacts.`, at);
    return [];
  }
  const list: StageArtifact[] = [];
  for (const [id, definitionBody] of Object.entries(rawArtifacts)) {
    const local = collectInlineArtifact(scope, [id, definitionBody], where);
    if (local !== null) list.push(local);
  }
  return list;
}

/** Reads one inline decision artifact, rejecting an id already used by the registry or this stage. */
function collectInlineArtifact(
  scope: StageArtifactScope,
  [id, definitionBody]: [string, unknown],
  { field, at }: { field: string; at: ArtifactPath },
): StageArtifact | null {
  const itemAt = [...at, id];
  const definition = readArtifactDefinition(id, definitionBody, { label: `${field}.${id}`, at: itemAt, fail: scope.fail });
  if (definition === null) return null;
  if (scope.declared.has(id) || scope.localIds.has(id)) {
    scope.fail(`${field}.${id}: artifact id collides with ${scope.declared.has(id) ? 'a top-level artifact' : 'another inline artifact of this stage'}.`, itemAt);
    return null;
  }
  scope.localIds.add(id);
  const local: StageArtifact = { ...definition, scope: 'local' };
  return noteStageArtifactFile(scope, local, [...itemAt, 'file']) ? local : null;
}

/** Resolves a list of artifact ids against the registry, keeping each distinct one. */
function collectArtifactReferences(
  scope: StageArtifactScope,
  ids: readonly unknown[],
  where: { field: string; at: ArtifactPath; decision: string | null },
): StageArtifact[] {
  const { field, at, decision } = where;
  const target: StageArtifact[] = [];
  const seen = new Set<string>();
  ids.forEach((id, position) => {
    const itemAt = [...at, position];
    const found = referenceArtifact(scope, id, { field: `${field}[${position}]`, at: itemAt, decision });
    if (found === null) return;
    if (seen.has(found.id)) {
      scope.fail(`Duplicate ${field} item: ${found.id}`, itemAt);
      return;
    }
    seen.add(found.id);
    if (noteStageArtifactFile(scope, found, itemAt)) target.push(found);
  });
  return target;
}

/** Records that `artifact` writes its file in this stage; false when another artifact already does. */
function noteStageArtifactFile(scope: StageArtifactScope, artifact: StageArtifact, at: ArtifactPath): boolean {
  const clash = scope.filesInStage.get(artifact.file);
  if (clash !== undefined) {
    scope.fail(`${scope.stageField}: file ${pyRepr(artifact.file)} of ${artifact.id} is already used by ${clash}.`, at);
    return false;
  }
  scope.filesInStage.set(artifact.file, artifact.id);
  return true;
}

/** Looks up one registry reference, records its producer, and checks its `required` flag fits the stage. */
function referenceArtifact(
  scope: StageArtifactScope,
  id: unknown,
  where: { field: string; at: ArtifactPath; decision: string | null },
): StageArtifact | null {
  const { fail, stageId, stageField, conditional } = scope;
  const { field, at, decision } = where;
  if (typeof id !== 'string' || id.trim() === '') {
    fail(`Missing or invalid ${field}.`, at);
    return null;
  }
  const name = id.trim();
  const found = scope.declared.get(name);
  if (found === undefined) {
    fail(`${field}: unknown artifact ${name}.`, at);
    return null;
  }
  const list = scope.producers.get(name) ?? [];
  list.push({ stage: stageId, decision });
  scope.producers.set(name, list);
  if (decision !== null && found.required) {
    fail(`${field}: artifact ${name} is referenced from a decision and must declare required: false.`, at);
  }
  if (found.required && conditional.has(stageId)) {
    const source = conditional.get(stageId);
    const origin = source === stageId ? `run_when stage ${source}` : `${stageField}, which is reached through run_when stage ${source}`;
    fail(`${field}: required artifact ${name} comes from ${origin}; a skip would leave it missing. Declare required: false.`, at);
  }
  return found;
}

/** Pairs each registry artifact with its single producer; zero or several producers is a problem. */
function resolveArtifactProducers(
  declared: ReadonlyMap<string, StageArtifact>,
  producers: ArtifactProducers,
  fail: FailArtifact,
): ArtifactSpec[] {
  const registry: ArtifactSpec[] = [];
  for (const [id, artifact] of declared) {
    const found = producers.get(id) ?? [];
    if (found.length === 0) {
      fail(`artifacts.${id} is not produced by any stage; reference it from a stage or decision.`, ['artifacts', id]);
      continue;
    }
    if (found.length > 1) {
      const where = found.map((item) => (item.decision === null ? item.stage : `${item.stage}.${item.decision}`)).join(', ');
      fail(`artifacts.${id} has more than one producer: ${where}.`, ['artifacts', id]);
      continue;
    }
    registry.push({ ...artifact, producer: found[0] });
  }
  return registry;
}

export function parseCompletion(
  raw: Record<string, unknown>,
  stages: Record<string, StageSpec>,
): WorkflowCompletion {
  const stageId = requiredString(raw.stage, 'completion.stage');
  if (!Object.hasOwn(stages, stageId)) {
    throw new ConfigurationError(`completion.stage is not a declared stage: ${stageId}`);
  }
  const decision = (raw.decision === null || raw.decision === undefined) ? null : requiredString(raw.decision, 'completion.decision');
  const outputs = parseOutputItems(raw.outputs ?? [], stages, 'completion.outputs');
  return workflowCompletionSchema.parse({ stage: stageId, decision, outputs });
}

export function validateVerifyPaths(
  stages: Record<string, StageSpec>,
  completion: WorkflowCompletion | null,
  version2 = false,
): void {
  const points = completionPoints(stages, completion, version2);
  if (points.size === 0) return;
  for (const stage of Object.values(stages)) {
    if (stage.verify.length === 0) continue;
    const missed = [...points].find(
      (point) => point !== stage.id && !dependencyClosure(stages, point).has(stage.id),
    );
    if (missed !== undefined) {
      throw new ConfigurationError(
        `stages.${stage.id}.verify is not on every path to complete: ${missed} does not depend on ${stage.id}.`,
      );
    }
  }
}

/** The stages from which a run can complete. */
function completionPoints(
  stages: Record<string, StageSpec>,
  completion: WorkflowCompletion | null,
  version2: boolean,
): Set<string> {
  const points = new Set<string>();
  if (!version2 && completion !== null) points.add(completion.stage);
  for (const stage of Object.values(stages)) {
    if (Object.values(stage.routes).some((value) => routeTargets(value).includes('complete'))) points.add(stage.id);
    if (version2 && isLeafStage(stages, stage)) points.add(stage.id);
  }
  return points;
}
