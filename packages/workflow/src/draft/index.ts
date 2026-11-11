
import { buildArtifactsV7 } from '../artifacts.js';
import type { WorkflowCatalogEntry } from '../catalog.js';
import { SCHEMA_V2, SCHEMA_V3, SCHEMA_V4_DOWNSTREAM, SCHEMA_V5, SCHEMA_V7_ARTIFACTS } from '../constants.js';
import { UNKNOWN_KEYS_ERROR_SCHEMA_VERSION, unknownWorkflowKeyEntries, workflowRuleCode } from '../diagnostics.js';
import { collectGraphProblems, draftConditionalStages } from '../draft/graph.js';
import type { CollectedOutputs } from '../draft/outputs.js';
import { collectCompletion, collectDownstream, collectOutputs } from '../draft/outputs.js';
import type { DraftDownstreamEntry, DraftStage, DraftUnit, WorkflowDraftParse } from '../draft/problems.js';
import { draftPathFor, DraftProblems, draftUnit } from '../draft/problems.js';
import type { DraftStageContext } from '../draft/stage.js';
import { collectStage, collectStringItems } from '../draft/stage.js';
import type { WorkflowRequires } from '../model.js';
import { SCHEMA_VERSION } from '../model.js';
import { documentId, parseConcurrency, parseRequires, parseWorkflowMapping } from '../parse.js';
import { documentVersion, isRecord } from '../record.js';
import { requiredString } from '../stage-fields.js';

/**
 * Collects every independent problem of a workflow mapping. The rules are the runtime's; only the
 * failure handling differs. `document` is set only when nothing is incomplete, and it always comes
 * from `parseWorkflowMapping` so runtime parsing stays the one authority.
 */
export function collectWorkflowDraft(data: Record<string, unknown>, source: string): WorkflowDraftParse {
  const problems = new DraftProblems();
  const idUnit = draftUnit(() => documentId(data, source), problems, ['id']);
  const versionUnit = draftUnit(() => documentVersion(data), problems, ['schema_version']);
  const unknownKeys = unknownWorkflowKeyEntries(data);
  const emptyResult = (schemaVersion: number): WorkflowDraftParse =>
    emptyDraftResult({ problems, source, id: idUnit, schemaVersion, unknownKeys });
  if (idUnit.state === 'invalid' || versionUnit.state === 'invalid') return emptyResult(0);
  const schemaVersion = versionUnit.value;
  const version2 = schemaVersion >= SCHEMA_V2;
  const version3 = schemaVersion >= SCHEMA_V3;
  const version5 = schemaVersion >= SCHEMA_V5;
  const version7 = schemaVersion >= SCHEMA_V7_ARTIFACTS;
  if (schemaVersion > SCHEMA_VERSION) {
    problems.addMessage(
      'schema-newer',
      `workflow schema_version ${schemaVersion} is newer than this Migent (${SCHEMA_VERSION}).`,
      ['schema_version'],
    );
    return emptyResult(schemaVersion);
  }
  collectSectionVersionProblems(data, { schemaVersion, unknownKeys, problems });

  const rawStages: unknown[] = Array.isArray(data.stages) ? data.stages : [];
  const stagesDeclared = rawStages.length > 0;
  const { declaredStageIds, duplicateIndexes } = scanDeclaredStageIds(rawStages);
  const stageContext = { version2, version3, version5, version7, declaredIds: declaredStageIds, problems };
  const stages = collectDraftStages(rawStages, duplicateIndexes, stageContext);

  const outputContext = { declaredIds: declaredStageIds, problems };
  const outputs = collectDraftOutputs(data, stages, { version2, version7, ...outputContext });
  const downstream = schemaVersion >= SCHEMA_V4_DOWNSTREAM
    ? collectDownstream(data.downstream, outputs, problems)
    : { sectionValid: true, entries: [] };
  let requires: DraftUnit<WorkflowRequires | null>;
  if (schemaVersion < SCHEMA_V4_DOWNSTREAM) requires = draftUnit(() => parseRequires(data.requires, version2), problems, ['requires']);
  else if (Object.hasOwn(data, 'requires')) requires = { state: 'invalid' };
  else requires = { state: 'absent', value: null };
  // Top-level fields are leaf units of their own: they are read even when a stage is unreadable.
  if (version2) draftUnit(() => parseConcurrency(data), problems, ['concurrency']);
  collectStringItems(data.constraints, 'constraints', problems);
  const completion =
    !version2 && isRecord(data.completion) && declaredStageIds.size > 0
      ? collectCompletion(data.completion, stages, outputContext)
      : { stage: null };

  collectStageReferenceProblems(stages, outputContext);

  collectGraphProblems(
    stages,
    {
      rawCount: rawStages.length,
      declaredIds: declaredStageIds,
      completionStage: completion.stage,
      outputs,
      version2,
      problems,
    },
  );

  return finishWorkflowDraft(data, {
    ...emptyResult(schemaVersion),
    stagesDeclared,
    declaredStageIds,
    stages,
    requires,
    downstream: downstream.entries,
    outputNames: outputs.names,
    outputsComplete: outputs.complete,
    catalogEntry: catalogEntryOfDraft(source, { id: idUnit, stagesDeclared, requires, downstream: downstream.entries }),
  }, problems);
}

/** The result for a document whose id, version or schema range stops collection before its stages. */
function emptyDraftResult(parts: {
  readonly problems: DraftProblems;
  readonly source: string;
  readonly id: DraftUnit<string>;
  readonly schemaVersion: number;
  readonly unknownKeys: ReturnType<typeof unknownWorkflowKeyEntries>;
}): WorkflowDraftParse {
  const { problems, source, id, schemaVersion, unknownKeys } = parts;
  return {
    problems: problems.items,
    document: null,
    id,
    schemaVersion,
    stagesDeclared: false,
    declaredStageIds: new Set(),
    stages: [],
    requires: { state: 'invalid' },
    downstream: [],
    outputNames: new Set(),
    outputsComplete: false,
    unknownKeys,
    catalogEntry: {
      file: source,
      document: null,
      id: id.state === 'invalid' ? { known: false } : { known: true, value: id.value },
      stagesDeclared: false,
      requires: { known: false },
      downstream: [],
    },
  };
}

/**
 * Attaches the runtime-parsed document when the draft found no problem; a runtime error the draft
 * rules missed is recorded instead, so `document` and `problems` never disagree.
 */
function finishWorkflowDraft(
  data: Record<string, unknown>,
  draft: WorkflowDraftParse,
  problems: DraftProblems,
): WorkflowDraftParse {
  if (problems.items.length === 0) {
    try {
      return { ...draft, document: parseWorkflowMapping(data, draft.catalogEntry.file) };
    } catch (error) {
      problems.add(error, draftPathFor(error instanceof Error ? error.message : String(error), data));
    }
  }
  return draft;
}

/** Top-level sections the document's schema_version removed or does not yet allow. */
function collectSectionVersionProblems(
  data: Record<string, unknown>,
  context: {
    readonly schemaVersion: number;
    readonly unknownKeys: ReturnType<typeof unknownWorkflowKeyEntries>;
    readonly problems: DraftProblems;
  },
): void {
  const { schemaVersion, unknownKeys, problems } = context;
  const version2 = schemaVersion >= SCHEMA_V2;
  if (unknownKeys.length > 0 && schemaVersion >= UNKNOWN_KEYS_ERROR_SCHEMA_VERSION) {
    for (const entry of unknownKeys) problems.addMessage(entry.code, entry.message, entry.path);
  }
  if (schemaVersion >= SCHEMA_V4_DOWNSTREAM && Object.hasOwn(data, 'requires')) {
    const message = 'requires was removed in schema_version 4. Run `migent migrate`; use --prior for context and downstream for suggestions.';
    problems.addMessage(workflowRuleCode(message), message, ['requires']);
  }
  if (schemaVersion < SCHEMA_V4_DOWNSTREAM && Object.hasOwn(data, 'downstream')) {
    const message = 'downstream requires schema_version 4.';
    problems.addMessage(workflowRuleCode(message), message, ['downstream']);
  }
  if (version2 && Object.hasOwn(data, 'completion') && (data.completion !== null && data.completion !== undefined)) {
    const message = 'schema_version 2 does not allow completion. Run `migent migrate`.';
    problems.addMessage(workflowRuleCode(message), message, ['completion']);
  }
}

/** Every readable stage id, and the indexes of stages that repeat an earlier id. */
function scanDeclaredStageIds(rawStages: readonly unknown[]): {
  declaredStageIds: Set<string>;
  duplicateIndexes: Set<number>;
} {
  const declaredStageIds = new Set<string>();
  const duplicateIndexes = new Set<number>();
  rawStages.forEach((item, index) => {
    if (!isRecord(item)) return;
    let value: string;
    try {
      value = requiredString(item.id, 'stages.id');
    } catch {
      return;
    }
    if (declaredStageIds.has(value)) duplicateIndexes.add(index);
    declaredStageIds.add(value);
  });
  return { declaredStageIds, duplicateIndexes };
}

/** Collects each stage that is not a duplicate; a duplicate is reported once at its id. */
function collectDraftStages(
  rawStages: readonly unknown[],
  duplicateIndexes: ReadonlySet<number>,
  stageContext: DraftStageContext,
): DraftStage[] {
  const stages: DraftStage[] = [];
  rawStages.forEach((item, index) => {
    if (duplicateIndexes.has(index)) {
      const id = isRecord(item) && typeof item.id === 'string' ? item.id.trim() : '';
      stageContext.problems.addMessage('duplicate-stage-id', `Duplicate stage id: ${id}`, ['stages', index, 'id']);
      return;
    }
    const stage = collectStage(item, index, stageContext);
    if (stage !== null) stages.push(stage);
  });
  return stages;
}

/** Collects `outputs` (schema 2 to 6) or the schema 7 `artifacts` registry as the document's outputs. */
function collectDraftOutputs(
  data: Record<string, unknown>,
  stages: readonly DraftStage[],
  context: {
    readonly version2: boolean;
    readonly version7: boolean;
    readonly declaredIds: ReadonlySet<string>;
    readonly problems: DraftProblems;
  },
): CollectedOutputs {
  const { version2, version7, declaredIds, problems } = context;
  const outputs: CollectedOutputs = version2 && !version7
    ? collectOutputs(data.outputs, stages, { declaredIds, problems })
    : { sectionValid: true, complete: true, names: new Set(), values: [], indexes: [] };
  if (!version7) {
    if (Object.hasOwn(data, 'artifacts')) {
      problems.addMessage('invalid-artifact', 'artifacts requires schema_version 7.', ['artifacts']);
    }
    return outputs;
  }
  if (Object.hasOwn(data, 'outputs')) {
    const message = 'outputs was removed in schema_version 7. Declare artifacts and run `migent migrate`.';
    problems.addMessage('invalid-artifact', message, ['outputs']);
  }
  const built = buildArtifactsV7(data, draftConditionalStages(stages, declaredIds));
  for (const problem of built.problems) problems.addMessage(problem.code, problem.message, problem.path);
  const names = new Set(Object.keys(isRecord(data.artifacts) ? data.artifacts : {}));
  return {
    sectionValid: isRecord(data.artifacts) || (data.artifacts === null || data.artifacts === undefined),
    complete: built.problems.length === 0,
    names,
    values: [],
    indexes: [],
  };
}

/** Each `depends_on` must name a declared stage, and `session.resume_from` must name a role stage. */
function collectStageReferenceProblems(
  stages: readonly DraftStage[],
  context: { readonly declaredIds: ReadonlySet<string>; readonly problems: DraftProblems },
): void {
  const { declaredIds: declaredStageIds, problems } = context;
  const stagesById = new Map(stages.map((stage) => [stage.id, stage]));
  for (const stage of stages) {
    if (stage.dependsOn.state === 'invalid') continue;
    for (const dependency of stage.dependsOn.value) {
      if (!declaredStageIds.has(dependency)) {
        const message = `stages.${stage.id}.depends_on is not a declared stage: ${dependency}`;
        problems.addMessage('unknown-stage', message, ['stages', stage.index, 'depends_on']);
      }
    }
    if (stage.resumeFrom.state === 'invalid' || stage.resumeFrom.value === null) continue;
    const target = stagesById.get(stage.resumeFrom.value);
    if (target !== undefined && target.kind === 'verify') {
      const message = `stages.${stage.id}.session.resume_from must name a role stage: ${stage.resumeFrom.value}.`;
      problems.addMessage('invalid-value', message, ['stages', stage.index, 'session', 'resume_from']);
    }
  }
}

export interface DraftCatalogParts {
  readonly id: DraftUnit<string>;
  readonly stagesDeclared: boolean;
  readonly requires: DraftUnit<WorkflowRequires | null>;
  readonly downstream: readonly DraftDownstreamEntry[];
}

export function catalogEntryOfDraft(file: string, parts: DraftCatalogParts): WorkflowCatalogEntry {
  const { id, stagesDeclared, requires, downstream } = parts;
  return {
    file,
    document: null,
    id: id.state === 'invalid' ? { known: false } : { known: true, value: id.value },
    stagesDeclared,
    requires: requires.state === 'invalid' ? { known: false } : { known: true, value: requires.value },
    downstream: downstream.map((entry) => ({
      index: entry.index,
      workflow: entry.workflow.state === 'invalid'
        ? { known: false }
        : { known: true, value: entry.workflow.value },
    })),
  };
}
