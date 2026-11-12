

import type { DraftDownstreamEntry, DraftStage, DraftUnit } from '../draft/problems.js';
import { DraftProblems, draftUnit } from '../draft/problems.js';
import type { WorkflowOutput } from '../model.js';
import { isPathReference } from '../model.js';
import { isRecord, pyRepr } from '../record.js';
import { filename, requiredString } from '../stage-fields.js';
import { downstreamArtifactSourceProblem,downstreamListProblem, downstreamProblems } from '../structure.js';

export interface CollectedOutputs {
  sectionValid: boolean;
  /** True when every output entry parsed. */
  complete: boolean;
  names: Set<string>;
  values: WorkflowOutput[];
  /** Raw list index of each value, for author-coordinate paths. */
  indexes: number[];
}

export interface OutputsContext {
  readonly declaredIds: ReadonlySet<string>;
  readonly problems: DraftProblems;
  /** Name of the section in messages. Defaults to `outputs`. */
  readonly field?: string;
  /** Author-coordinate path of the section. Defaults to `[field]`. */
  readonly basePath?: readonly (string | number)[];
}

export function collectOutputs(raw: unknown, stages: readonly DraftStage[], context: OutputsContext): CollectedOutputs {
  const { declaredIds, problems, field = 'outputs' } = context;
  const { basePath = [field] } = context;
  const result: CollectedOutputs = { sectionValid: true, complete: true, names: new Set(), values: [], indexes: [] };
  let rawItems: unknown = raw === false ? [] : raw;
  if ((rawItems === null || rawItems === undefined) || (isRecord(rawItems) && Object.keys(rawItems).length === 0)) {
    rawItems = [];
  }
  if (!Array.isArray(rawItems)) {
    problems.addMessage('invalid-value', `${field} must be a list.`, [...basePath]);
    return { sectionValid: false, complete: false, names: result.names, values: [], indexes: [] };
  }
  const artifactOf = (stageId: string): DraftUnit<string | null> | null =>
    stages.find((stage) => stage.id === stageId)?.artifact ?? null;
  rawItems.forEach((item, index) => {
    collectOutputEntry(item, index, { field, basePath, declaredIds, problems, result, artifactOf });
  });
  return result;
}

interface OutputEntryContext {
  readonly field: string;
  readonly basePath: readonly (string | number)[];
  readonly declaredIds: ReadonlySet<string>;
  readonly problems: DraftProblems;
  readonly result: CollectedOutputs;
  readonly artifactOf: (stageId: string) => DraftUnit<string | null> | null;
}

/** Reads one output entry, recording its problems and, when it is fully valid, its value. */
function collectOutputEntry(item: unknown, index: number, context: OutputEntryContext): void {
  const { field, basePath, problems, result } = context;
  const entryPath: (string | number)[] = [...basePath, index];
  if (!isRecord(item)) {
    problems.addMessage('invalid-value', `${field} item must be a mapping.`, entryPath);
    result.complete = false;
    return;
  }
  let entryValid = true;
  const read = <T>(fn: () => T, suffix: string): T | null => {
    try {
      return fn();
    } catch (error) {
      problems.add(error, [...entryPath, suffix]);
      entryValid = false;
      return null;
    }
  };
  const name = read(() => filename(item.name, `${field}.name`), 'name');
  const fromStage = read(() => requiredString(item.from_stage, `${field}.from_stage`), 'from_stage');
  const artifact = read(() => filename(item.artifact, `${field}.artifact`), 'artifact');
  const nameValid = checkOutputName(name, entryPath, context);
  const sourceValid = checkOutputSource({ name, fromStage, artifact }, entryPath, context);
  entryValid = entryValid && nameValid && sourceValid;
  if (!entryValid) result.complete = false;
  if (entryValid && name !== null && fromStage !== null && artifact !== null) {
    result.values.push({ name, fromStage, artifact });
    result.indexes.push(index);
  }
}

/** Records the output name and reports a duplicate. */
function checkOutputName(name: string | null, entryPath: (string | number)[], context: OutputEntryContext): boolean {
  const { field, problems, result } = context;
  if (name === null) return true;
  const duplicate = result.names.has(name);
  if (duplicate) problems.addMessage('invalid-value', `Duplicate ${field} name: ${name}`, [...entryPath, 'name']);
  result.names.add(name);
  return !duplicate;
}

/** Checks that `from_stage` is declared and produces the named artifact. */
function checkOutputSource(
  entry: { name: string | null; fromStage: string | null; artifact: string | null },
  entryPath: (string | number)[],
  context: OutputEntryContext,
): boolean {
  const { name, fromStage, artifact } = entry;
  const { field, declaredIds, problems, artifactOf } = context;
  if (fromStage === null) return true;
  if (!declaredIds.has(fromStage)) {
    problems.addMessage(
      'unknown-stage',
      `${field}.from_stage is not a declared stage: ${fromStage}`,
      [...entryPath, 'from_stage'],
    );
    return false;
  }
  const source = artifactOf(fromStage);
  if (source === null || source.state === 'invalid' || name === null || artifact === null) return true;
  if (source.value === null) {
    problems.addMessage(
      'invalid-artifact',
      `${field} ${pyRepr(name)} references stage ${fromStage} which does not produce an artifact.`,
      entryPath,
    );
    return false;
  }
  if (source.value !== artifact) {
    problems.addMessage(
      'invalid-artifact',
      `${field} ${pyRepr(name)} artifact ${pyRepr(artifact)} does not match stages.${fromStage}.produces.artifact ${pyRepr(source.value)}.`,
      [...entryPath, 'artifact'],
    );
    return false;
  }
  return true;
}

export function collectDownstream(
  raw: unknown,
  outputs: CollectedOutputs,
  problems: DraftProblems,
): { sectionValid: boolean; entries: DraftDownstreamEntry[] } {
  const field = 'downstream';
  if (raw === undefined) return { sectionValid: true, entries: [] };
  if (downstreamListProblem(raw)) {
    problems.addMessage('invalid-value', `${field} must be a list.`, [field]);
    return { sectionValid: false, entries: [] };
  }
  const entries: DraftDownstreamEntry[] = [];
  const seen = new Set<string>();
  (raw as unknown[]).forEach((entry, index) => {
    const collected = collectDownstreamEntry(entry, [field, index], { outputs, problems, seen });
    if (collected !== null) entries.push({ index, workflow: collected });
  });
  return { sectionValid: true, entries };
}

interface DownstreamEntryContext {
  readonly outputs: CollectedOutputs;
  readonly problems: DraftProblems;
  readonly seen: Set<string>;
}

type DownstreamStructure = ReturnType<typeof downstreamProblems>;

const RESERVED_ARTIFACT_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Reads one downstream entry; null when it is not a mapping at all. */
function collectDownstreamEntry(
  entry: unknown,
  entryPath: (string | number)[],
  context: DownstreamEntryContext,
): DraftUnit<string> | null {
  const { problems } = context;
  const structural = downstreamProblems(entry);
  const has = (kind: DownstreamStructure[number]['kind']): boolean => structural.some((problem) => problem.kind === kind);
  if (has('entry') || !isRecord(entry)) {
    problems.addMessage('invalid-value', 'downstream entries must be mappings.', entryPath);
    return null;
  }
  for (const problem of structural) {
    if (problem.kind === 'key') {
      problems.addMessage('invalid-downstream', `Unknown downstream field: ${problem.key}.`, [...entryPath, problem.key]);
    }
  }
  const workflow = has('workflow')
    ? missingDownstreamWorkflow(entryPath, problems)
    : readDownstreamWorkflow((entry.workflow as string).trim(), entryPath, context);
  if (has('task-missing')) {
    problems.addMessage('missing-required', 'Missing or invalid downstream.task.', [...entryPath, 'task']);
  } else if (has('task-line')) {
    problems.addMessage('invalid-downstream', 'downstream.task must be a single line.', [...entryPath, 'task']);
  }
  if (has('artifacts')) {
    problems.addMessage('invalid-downstream', 'downstream.artifacts must be a mapping.', [...entryPath, 'artifacts']);
  } else {
    const mapping = entry.artifacts === undefined ? {} : (entry.artifacts as Record<string, unknown>);
    checkDownstreamArtifacts(mapping, entryPath, context);
  }
  return workflow;
}

function missingDownstreamWorkflow(entryPath: (string | number)[], problems: DraftProblems): DraftUnit<string> {
  problems.addMessage('missing-required', 'Missing or invalid downstream.workflow.', [...entryPath, 'workflow']);
  return { state: 'invalid' };
}

/** Rejects a path or a repeated workflow id; otherwise records the id as seen. */
function readDownstreamWorkflow(
  value: string,
  entryPath: (string | number)[],
  { problems, seen }: DownstreamEntryContext,
): DraftUnit<string> {
  if (isPathReference(value)) {
    problems.addMessage(
      'invalid-downstream',
      'downstream.workflow must be a workflow id, not a path.',
      [...entryPath, 'workflow'],
    );
    return { state: 'invalid' };
  }
  if (seen.has(value)) {
    problems.addMessage('invalid-downstream', `Duplicate downstream workflow: ${value}.`, [...entryPath, 'workflow']);
    return { state: 'invalid' };
  }
  seen.add(value);
  return { state: 'valid', value };
}

/** Checks each downstream artifact name and that its source names a declared output. */
function checkDownstreamArtifacts(
  mapping: Record<string, unknown>,
  entryPath: (string | number)[],
  { outputs, problems }: DownstreamEntryContext,
): void {
  for (const [name, source] of Object.entries(mapping)) {
    const artifactPath = [...entryPath, 'artifacts', name];
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || RESERVED_ARTIFACT_NAMES.has(name)) {
      problems.addMessage('invalid-downstream', `Invalid downstream artifact name: ${name}.`, artifactPath);
      continue;
    }
    if (downstreamArtifactSourceProblem(source)) {
      problems.addMessage('missing-required', `Missing or invalid downstream.artifacts.${name}.`, artifactPath);
      continue;
    }
    const output = (source as string).trim();
    if (outputs.sectionValid && !outputs.names.has(output)) {
      problems.addMessage(
        'invalid-artifact',
        `downstream.artifacts.${name}: unknown output ${output}.`,
        artifactPath,
      );
    }
  }
}

export interface CollectedCompletion {
  /** The declared completion stage, when it is readable, for the verify-path points. */
  stage: string | null;
}

/** Reads `completion` as its own unit set, so a broken stage does not hide its errors. */
export function collectCompletion(
  raw: Record<string, unknown>,
  stages: readonly DraftStage[],
  context: OutputsContext,
): CollectedCompletion {
  const { declaredIds, problems } = context;
  const stage = draftUnit(() => requiredString(raw.stage, 'completion.stage'), problems, ['completion', 'stage']);
  let stageId: string | null = null;
  if (stage.state === 'valid') {
    if (declaredIds.has(stage.value)) {
      stageId = stage.value;
    } else {
      problems.addMessage(
        'unknown-stage',
        `completion.stage is not a declared stage: ${stage.value}`,
        ['completion', 'stage'],
      );
    }
  }
  if ((raw.decision !== null && raw.decision !== undefined)) {
    draftUnit(() => requiredString(raw.decision, 'completion.decision'), problems, ['completion', 'decision']);
  }
  collectOutputs(raw.outputs ?? [], stages, { declaredIds, problems, field: 'completion.outputs', basePath: ['completion', 'outputs'] });
  return { stage: stageId };
}
