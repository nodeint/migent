import path from 'node:path';

import { buildArtifactsV7, outputOfArtifact, parseCompletion, parseTopLevelOutputs, validateVerifyPaths } from './artifacts.js';
import { SCHEMA_V2, SCHEMA_V3, SCHEMA_V4_DOWNSTREAM, SCHEMA_V5, SCHEMA_V7_ARTIFACTS } from './constants.js';
import { stageErrorPath, UNKNOWN_KEYS_ERROR_SCHEMA_VERSION, unknownWorkflowKeys, workflowErrorPath, workflowRuleCode } from './diagnostics.js';
import { ConfigurationError } from './errors.js';
import { conditionalStages, validateConditionalStages, validateStageGraph } from './graph.js';
import type { ArtifactSpec, StageSpec, WorkflowDocument, WorkflowDownstream, WorkflowOutput, WorkflowRequires } from './model.js';
import { isPathReference,SCHEMA_VERSION, VERIFY_ARTIFACT } from './model.js';
import { documentVersion, isRecord } from './record.js';
import { stageSpecSchema, workflowDocumentSchema, workflowRequiresSchema } from './schema.js';
import { legacyStageModel, normalizeStageDecision, rejectRoleOnlyKeys, requiredString, stageAgent, stageArtifact, stageAsk, stageDecisionValues, stageDependsOn, stageDescription, stageHasRole, stageMaxRevisions, stageMaxVerify, stageOptions, stageResumeFrom, stageRoutes, stageRunWhen, stageVerify, stageVerifyTimeout, stringItems } from './stage-fields.js';
import { DOCUMENT_FIELD_SCHEMAS, downstreamProblems, requireContainer, requireValid,stageMappingProblem } from './structure.js';

/** Parse a workflow mapping. `source` is stored on the document and is not read from `data`. */
export function parseWorkflowMapping(data: Record<string, unknown>, source: string): WorkflowDocument {
  try {
    return parseWorkflowMappingUnchecked(data, source);
  } catch (error) {
    // Give every rule a stable code and an author-coordinate path without changing its message.
    if (!(error instanceof ConfigurationError) || (error.code !== undefined && error.path !== undefined)) throw error;
    const path = error.path ?? workflowErrorPath(error.message, data);
    throw new ConfigurationError(error.message, {
      code: error.code ?? workflowRuleCode(error.message),
      ...(path === undefined ? {} : { path }),
      ...(error.layer === undefined ? {} : { layer: error.layer }),
      ...(error.position === undefined ? {} : { position: error.position }),
    });
  }
}

export function parseWorkflowMappingUnchecked(data: Record<string, unknown>, source: string): WorkflowDocument {
  const workflowId = documentId(data, source);
  const schemaVersion = documentVersion(data);
  if (schemaVersion > SCHEMA_VERSION) {
    throw new ConfigurationError(
      `workflow schema_version ${schemaVersion} is newer than this Migent (${SCHEMA_VERSION}).`,
    );
  }
  const version2 = schemaVersion >= SCHEMA_V2;
  const unknown = unknownWorkflowKeys(data);
  if (unknown.length > 0 && schemaVersion >= UNKNOWN_KEYS_ERROR_SCHEMA_VERSION) {
    throw new ConfigurationError(`Unknown workflow keys: ${unknown.join(' ')}`);
  }
  if (schemaVersion >= SCHEMA_V4_DOWNSTREAM && Object.hasOwn(data, 'requires')) {
    throw new ConfigurationError('requires was removed in schema_version 4. Run `migent migrate`; use --prior for context and downstream for suggestions.');
  }
  if (schemaVersion < SCHEMA_V4_DOWNSTREAM && Object.hasOwn(data, 'downstream')) {
    throw new ConfigurationError('downstream requires schema_version 4.');
  }
  if (version2 && Object.hasOwn(data, 'completion') && (data.completion !== null && data.completion !== undefined)) {
    throw new ConfigurationError('schema_version 2 does not allow completion. Run `migent migrate`.');
  }
  const version7 = schemaVersion >= SCHEMA_V7_ARTIFACTS;
  if (version7 && Object.hasOwn(data, 'outputs')) {
    throw new ConfigurationError('outputs was removed in schema_version 7. Declare artifacts and run `migent migrate`.');
  }
  if (!version7 && Object.hasOwn(data, 'artifacts')) {
    throw new ConfigurationError('artifacts requires schema_version 7.');
  }
  const stages = parseStages(
    data.stages,
    { version2, version3: schemaVersion >= SCHEMA_V3, version5: schemaVersion >= SCHEMA_V5, version7 },
  );
  const completion =
    !version2 && isRecord(data.completion) && Object.keys(stages).length > 0
      ? parseCompletion(data.completion, stages)
      : null;
  let registry: ArtifactSpec[] | undefined;
  let outputs: WorkflowOutput[] | undefined;
  if (version7) {
    const built = buildArtifactsV7(data, conditionalStages(stages));
    const [first] = built.problems;
    if (first !== undefined) throw new ConfigurationError(first.message, { code: first.code, path: first.path });
    for (const [stageId, found] of built.perStage) {
      stages[stageId].artifacts = found.artifacts;
      stages[stageId].decisionArtifacts = found.decisionArtifacts;
    }
    registry = built.registry;
    outputs = registry.map(outputOfArtifact);
    validateConditionalStages(stages, []);
  } else {
    outputs = version2 ? parseTopLevelOutputs(data.outputs, stages) : undefined;
    validateConditionalStages(stages, outputs ?? []);
  }
  const concurrency = version2 ? parseConcurrency(data) : undefined;
  validateVerifyPaths(stages, completion, version2);
  const document: WorkflowDocument = workflowDocumentSchema.parse({
    id: workflowId,
    stages,
    completion,
    requires: parseRequires(data.requires, version2),
    constraints: stringItems(data.constraints, 'constraints'),
    source,
    schemaVersion,
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(outputs === undefined ? {} : { outputs }),
    ...(registry === undefined ? {} : { artifacts: registry }),
    ...(schemaVersion >= SCHEMA_V4_DOWNSTREAM ? { downstream: parseDownstream(data.downstream, outputs ?? []) } : {}),
  });
  if (unknown.length > 0) document.warnings = unknown;
  return document;
}

export function parseDownstream(raw: unknown, outputs: readonly WorkflowOutput[]): WorkflowDownstream[] {
  if (raw === undefined) return [];
  if (raw === null) throw new ConfigurationError('downstream must be a list.');
  requireContainer(DOCUMENT_FIELD_SCHEMAS.downstream, raw, 'downstream');
  const entries = raw as unknown[];
  const seen = new Set<string>();
  return entries.map((entry) => {
    const structural = downstreamProblems(entry);
    if (structural.some((problem) => problem.kind === 'entry') || !isRecord(entry)) throw new ConfigurationError('downstream entries must be mappings.');
    for (const problem of structural) {
      if (problem.kind === 'key') throw new ConfigurationError(`Unknown downstream field: ${problem.key}.`);
    }
    const workflow = requiredString(entry.workflow, 'downstream.workflow');
    if (isPathReference(workflow)) throw new ConfigurationError('downstream.workflow must be a workflow id, not a path.');
    if (seen.has(workflow)) throw new ConfigurationError(`Duplicate downstream workflow: ${workflow}.`);
    seen.add(workflow);
    if (structural.some((problem) => problem.kind === 'task-missing')) throw new ConfigurationError('Missing or invalid downstream.task.');
    if (structural.some((problem) => problem.kind === 'task-line')) throw new ConfigurationError('downstream.task must be a single line.');
    const task = requiredString(entry.task, 'downstream.task');
    if (structural.some((problem) => problem.kind === 'artifacts')) throw new ConfigurationError('downstream.artifacts must be a mapping.');
    const mapping = entry.artifacts === undefined ? {} : (entry.artifacts as Record<string, unknown>);
    const artifacts: Record<string, string> = {};
    const mapped = entry.artifacts !== undefined;
    for (const [name, source] of Object.entries(mapping)) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || name === '__proto__' || name === 'constructor' || name === 'prototype') {
        throw new ConfigurationError(`Invalid downstream artifact name: ${name}.`);
      }
      const output = requiredString(source, `downstream.artifacts.${name}`);
      if (!outputs.some((item) => item.name === output)) throw new ConfigurationError(`downstream.artifacts.${name}: unknown output ${output}.`);
      artifacts[name] = output;
    }
    return mapped ? { workflow, task, artifacts } : { workflow, task };
  });
}

export function parseConcurrency(data: Record<string, unknown>): number {
  if (!Object.hasOwn(data, 'concurrency') || (data.concurrency === null || data.concurrency === undefined)) return 1;
  requireValid(DOCUMENT_FIELD_SCHEMAS.concurrency, data.concurrency, 'concurrency must be a positive integer.');
  return Number(typeof data.concurrency === 'string' ? data.concurrency.trim() : data.concurrency);
}

export function documentId(data: Record<string, unknown>, filePath: string): string {
  if (!Object.hasOwn(data, 'id') || (data.id === null || data.id === undefined)) {
    const stem = path.parse(filePath).name.trim();
    if (stem === '') throw new ConfigurationError('Missing or invalid id.');
    return stem;
  }
  return requiredString(data.id, 'id');
}

export interface ParseStagesVersions {
  readonly version2?: boolean;
  readonly version3?: boolean;
  readonly version5?: boolean;
  readonly version7?: boolean;
}

export function parseStages(raw: unknown, versions: ParseStagesVersions = {}): Record<string, StageSpec> {
  const { version2 = false, version3 = false, version5 = false, version7 = false } = versions;
  if (!Array.isArray(raw) || raw.length === 0) return {};
  const stages: Record<string, StageSpec> = {};
  const items: Record<string, unknown>[] = [];
  const rawItems: unknown[] = [];
  for (const [index, rawItem] of raw.entries()) {
    try {
    if (stageMappingProblem(rawItem) || !isRecord(rawItem)) throw new ConfigurationError('Workflow stage must be a mapping.');
    const item = version3 ? normalizeStageDecision(rawItem, version7) : rawItem;
    const stageId = requiredString(item.id, 'stages.id');
    if (Object.hasOwn(stages, stageId)) throw new ConfigurationError(`Duplicate stage id: ${stageId}`);
    const description = stageDescription(item, stageId);
    const dependsOn = stageDependsOn(item, stageId);
    const verify = stageVerify(item, stageId);
    const runWhen = stageRunWhen(item, stageId, { version2, verify });
    if (!stageHasRole(item)) {
      if (!version2 || verify.length === 0) {
        throw new ConfigurationError(`stages.${stageId}.role is required.`);
      }
      rejectRoleOnlyKeys(item, stageId);
      stages[stageId] = stageSpecSchema.parse({
        kind: 'verify',
        id: stageId,
        description,
        role: null,
        artifacts: [],
        decisionArtifacts: {},
        decisionValues: [],
        dependsOn,
        resumeFrom: null,
        instructions: [],
        agent: null,
        options: {},
        maxRevisions: null,
        routes: {},
        verify,
        maxVerify: 0,
        verifyTimeoutSec: stageVerifyTimeout(item, stageId, verify),
        runWhen,
      });
      items.push(item);
      rawItems.push(rawItem);
      continue;
    }
    const role = requiredString(item.role, `stages.${stageId}.role`);
    if (version7 && Object.hasOwn(item, 'produces')) {
      throw new ConfigurationError(`stages.${stageId}.produces was removed in schema_version 7. Declare top-level artifacts and run \`migent migrate\`.`);
    }
    const artifact = stageArtifact(item, stageId);
    if (verify.length > 0 && artifact === VERIFY_ARTIFACT) {
      throw new ConfigurationError(
        `stages.${stageId}.produces.artifact cannot be ${VERIFY_ARTIFACT} on a stage with verify.`,
      );
    }
    stages[stageId] = stageSpecSchema.parse({
      kind: 'role',
      id: stageId,
      description,
      role,
      ...(Object.hasOwn(item, 'ask') ? { ask: stageAsk(item, stageId) } : {}),
      artifacts: artifact === null ? [] : [{ id: stageId, file: artifact, description: null, required: true, scope: 'local' }],
      decisionArtifacts: {},
      decisionValues: stageDecisionValues(item, stageId),
      ...(version3 && isRecord(item.decision) ? { decisionInstructions: item.decision.instructions } : {}),
      dependsOn,
      resumeFrom: stageResumeFrom(item, stageId, dependsOn),
      instructions: stringItems(item.instructions, `stages.${stageId}.instructions`),
      agent: version5 ? stageAgent(item, stageId) : legacyStageModel(item, stageId),
      options: version5 ? {} : stageOptions(item, stageId),
      maxRevisions: stageMaxRevisions(item, stageId),
      routes: {},
      verify,
      maxVerify: stageMaxVerify(item, stageId, verify),
      verifyTimeoutSec: stageVerifyTimeout(item, stageId, verify),
      runWhen,
    });
    items.push(item);
    rawItems.push(rawItem);
    } catch (error) {
      throw locatedAtStage(error, index, rawItem);
    }
  }
  for (const [index, item] of items.entries()) {
    try {
      const stageId = requiredString(item.id, 'stages.id');
      const stage = stages[stageId];
      stage.routes = stageRoutes(item, stageId, { values: stage.decisionValues, stages, version2 });
    } catch (error) {
      throw locatedAtStage(error, index, rawItems[index]);
    }
  }
  validateStageGraph(stages);
  return stages;
}

/** Gives a parse error raised while reading stage `index` its code and author-coordinate path. */
export function locatedAtStage(error: unknown, index: number, item: unknown): unknown {
  if (!(error instanceof ConfigurationError) || error.path !== undefined) return error;
  const path = stageErrorPath(error.message, index, item);
  return new ConfigurationError(error.message, {
    code: error.code ?? workflowRuleCode(error.message),
    path,
    ...(error.layer === undefined ? {} : { layer: error.layer }),
    ...(error.position === undefined ? {} : { position: error.position }),
  });
}

export function parseRequires(raw: unknown, version2 = false): WorkflowRequires | null {
  if ((raw === null || raw === undefined)) return null;
  if (isRecord(raw) && Object.keys(raw).length === 0) return null;
  if (!isRecord(raw)) throw new ConfigurationError('requires must be a mapping.');
  if (version2 && Object.hasOwn(raw, 'decision') && (raw.decision !== null && raw.decision !== undefined)) {
    throw new ConfigurationError('requires.decision is not allowed in schema_version 2.');
  }
  return workflowRequiresSchema.parse({
    workflow: requiredString(raw.workflow, 'requires.workflow'),
    decision: version2 ? null : requiredString(raw.decision, 'requires.decision').toLowerCase(),
  });
}
