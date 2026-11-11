import path from 'node:path';

import { buildArtifactsV7 } from '../artifacts.js';
import type { WorkflowCatalogEntry } from '../catalog.js';
import { UNKNOWN_KEYS_ERROR_SCHEMA_VERSION, unknownWorkflowKeyEntries, workflowRuleCode } from '../diagnostics.js';
import { collectGraphProblems, draftConditionalStages } from '../draft/graph.js';
import type { CollectedOutputs } from '../draft/outputs.js';
import { collectCompletion, collectDownstream, collectOutputs } from '../draft/outputs.js';
import type { DraftDownstreamEntry, DraftStage, DraftUnit, WorkflowDraftParse } from '../draft/problems.js';
import { draftPathFor, DraftProblems, draftUnit } from '../draft/problems.js';
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
  const emptyResult = (schemaVersion: number): WorkflowDraftParse => ({
    problems: problems.items,
    document: null,
    id: idUnit,
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
      id: idUnit.state === 'invalid' ? { known: false } : { known: true, value: idUnit.value },
      stagesDeclared: false,
      requires: { known: false },
      downstream: [],
    },
  });
  if (idUnit.state === 'invalid' || versionUnit.state === 'invalid') return emptyResult(0);
  const schemaVersion = versionUnit.value;
  const version2 = schemaVersion >= 2;
  const version3 = schemaVersion >= 3;
  const version5 = schemaVersion >= 5;
  const version7 = schemaVersion >= 7;
  if (schemaVersion > SCHEMA_VERSION) {
    problems.addMessage(
      'schema-newer',
      `workflow schema_version ${schemaVersion} is newer than this Migent (${SCHEMA_VERSION}).`,
      ['schema_version'],
    );
    return emptyResult(schemaVersion);
  }
  if (unknownKeys.length > 0 && schemaVersion >= UNKNOWN_KEYS_ERROR_SCHEMA_VERSION) {
    for (const entry of unknownKeys) problems.addMessage(entry.code, entry.message, entry.path);
  }
  if (schemaVersion >= 4 && Object.hasOwn(data, 'requires')) {
    const message = 'requires was removed in schema_version 4. Run `migent migrate`; use --prior for context and downstream for suggestions.';
    problems.addMessage(workflowRuleCode(message), message, ['requires']);
  }
  if (schemaVersion < 4 && Object.hasOwn(data, 'downstream')) {
    const message = 'downstream requires schema_version 4.';
    problems.addMessage(workflowRuleCode(message), message, ['downstream']);
  }
  if (version2 && Object.hasOwn(data, 'completion') && (data.completion !== null && data.completion !== undefined)) {
    const message = 'schema_version 2 does not allow completion. Run `migent migrate`.';
    problems.addMessage(workflowRuleCode(message), message, ['completion']);
  }

  const rawStages: unknown[] = Array.isArray(data.stages) ? data.stages : [];
  const stagesDeclared = rawStages.length > 0;
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

  const stages: DraftStage[] = [];
  rawStages.forEach((item, index) => {
    if (duplicateIndexes.has(index)) {
      const id = isRecord(item) && typeof item.id === 'string' ? item.id.trim() : '';
      problems.addMessage('duplicate-stage-id', `Duplicate stage id: ${id}`, ['stages', index, 'id']);
      return;
    }
    const stage = collectStage(item, index, version2, version3, version5, version7, declaredStageIds, problems);
    if (stage !== null) stages.push(stage);
  });

  let outputs: CollectedOutputs = version2 && !version7
    ? collectOutputs(data.outputs, stages, declaredStageIds, problems)
    : { sectionValid: true, complete: true, names: new Set(), values: [], indexes: [] };
  if (version7) {
    if (Object.hasOwn(data, 'outputs')) {
      const message = 'outputs was removed in schema_version 7. Declare artifacts and run `migent migrate`.';
      problems.addMessage('invalid-artifact', message, ['outputs']);
    }
    const built = buildArtifactsV7(data, draftConditionalStages(stages, declaredStageIds));
    for (const problem of built.problems) problems.addMessage(problem.code, problem.message, problem.path);
    const names = new Set(Object.keys(isRecord(data.artifacts) ? data.artifacts : {}));
    outputs = { sectionValid: isRecord(data.artifacts) || (data.artifacts === null || data.artifacts === undefined), complete: built.problems.length === 0, names, values: [], indexes: [] };
  } else if (Object.hasOwn(data, 'artifacts')) {
    problems.addMessage('invalid-artifact', 'artifacts requires schema_version 7.', ['artifacts']);
  }
  const downstream = schemaVersion >= 4
    ? collectDownstream(data.downstream, outputs, problems)
    : { sectionValid: true, entries: [] };
  const requires: DraftUnit<WorkflowRequires | null> =
    schemaVersion >= 4
      ? Object.hasOwn(data, 'requires')
        ? { state: 'invalid' }
        : { state: 'absent', value: null }
      : draftUnit(() => parseRequires(data.requires, version2), problems, ['requires']);
  // Top-level fields are leaf units of their own: they are read even when a stage is unreadable.
  if (version2) draftUnit(() => parseConcurrency(data), problems, ['concurrency']);
  collectStringItems(data.constraints, 'constraints', problems);
  const completion =
    !version2 && isRecord(data.completion) && declaredStageIds.size > 0
      ? collectCompletion(data.completion, stages, declaredStageIds, problems)
      : { stage: null };

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

  collectGraphProblems(stages, rawStages.length, declaredStageIds, completion.stage, outputs, version2, problems);

  if (problems.items.length === 0) {
    try {
      return {
        ...emptyResult(schemaVersion),
        document: parseWorkflowMapping(data, source),
        stagesDeclared,
        declaredStageIds,
        stages,
        requires,
        downstream: downstream.entries,
        outputNames: outputs.names,
        outputsComplete: outputs.complete,
        catalogEntry: catalogEntryOfDraft(source, idUnit, stagesDeclared, requires, downstream.entries),
      };
    } catch (error) {
      problems.add(error, draftPathFor(error instanceof Error ? error.message : String(error), data));
    }
  }

  return {
    problems: problems.items,
    document: null,
    id: idUnit,
    schemaVersion,
    stagesDeclared,
    declaredStageIds,
    stages,
    requires,
    downstream: downstream.entries,
    outputNames: outputs.names,
    outputsComplete: outputs.complete,
    unknownKeys,
    catalogEntry: catalogEntryOfDraft(source, idUnit, stagesDeclared, requires, downstream.entries),
  };
}

export function catalogEntryOfDraft(
  file: string,
  id: DraftUnit<string>,
  stagesDeclared: boolean,
  requires: DraftUnit<WorkflowRequires | null>,
  downstream: readonly DraftDownstreamEntry[],
): WorkflowCatalogEntry {
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
