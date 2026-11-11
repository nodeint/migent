import path from 'node:path';

import { z } from 'zod';

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

export function collectOutputs(
  raw: unknown,
  stages: readonly DraftStage[],
  declaredIds: ReadonlySet<string>,
  problems: DraftProblems,
  field = 'outputs',
  basePath: readonly (string | number)[] = [field],
): CollectedOutputs {
  const result: CollectedOutputs = { sectionValid: true, complete: true, names: new Set(), values: [], indexes: [] };
  let rawItems: unknown = raw === false ? [] : raw;
  if ((rawItems === null || rawItems === undefined) || (isRecord(rawItems) && Object.keys(rawItems).length === 0)) rawItems = [];
  if (!Array.isArray(rawItems)) {
    problems.addMessage('invalid-value', `${field} must be a list.`, [...basePath]);
    return { sectionValid: false, complete: false, names: result.names, values: [], indexes: [] };
  }
  const artifactOf = (stageId: string): DraftUnit<string | null> | null =>
    stages.find((stage) => stage.id === stageId)?.artifact ?? null;
  rawItems.forEach((item, index) => {
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
        result.complete = false;
        return null;
      }
    };
    const name = read(() => filename(item.name, `${field}.name`), 'name');
    const fromStage = read(() => requiredString(item.from_stage, `${field}.from_stage`), 'from_stage');
    const artifact = read(() => filename(item.artifact, `${field}.artifact`), 'artifact');
    if (name !== null) {
      if (result.names.has(name)) {
        problems.addMessage('invalid-value', `Duplicate ${field} name: ${name}`, [...entryPath, 'name']);
        entryValid = false;
      }
      result.names.add(name);
    }
    if (fromStage !== null) {
      if (!declaredIds.has(fromStage)) {
        problems.addMessage(
          'unknown-stage',
          `${field}.from_stage is not a declared stage: ${fromStage}`,
          [...entryPath, 'from_stage'],
        );
        entryValid = false;
      } else {
        const source = artifactOf(fromStage);
        if (source !== null && source.state !== 'invalid' && name !== null && artifact !== null) {
          if (source.value === null) {
            problems.addMessage(
              'invalid-artifact',
              `${field} ${pyRepr(name)} references stage ${fromStage} which does not produce an artifact.`,
              entryPath,
            );
            entryValid = false;
          } else if (source.value !== artifact) {
            problems.addMessage(
              'invalid-artifact',
              `${field} ${pyRepr(name)} artifact ${pyRepr(artifact)} does not match stages.${fromStage}.produces.artifact ${pyRepr(source.value)}.`,
              [...entryPath, 'artifact'],
            );
            entryValid = false;
          }
        }
      }
    }
    if (!entryValid) result.complete = false;
    if (entryValid && name !== null && fromStage !== null && artifact !== null) {
      result.values.push({ name, fromStage, artifact });
      result.indexes.push(index);
    }
  });
  return result;
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
    const entryPath: (string | number)[] = [field, index];
    const structural = downstreamProblems(entry);
    if (structural.some((problem) => problem.kind === 'entry') || !isRecord(entry)) {
      problems.addMessage('invalid-value', `${field} entries must be mappings.`, entryPath);
      return;
    }
    for (const problem of structural) {
      if (problem.kind === 'key') {
        problems.addMessage('invalid-downstream', `Unknown downstream field: ${problem.key}.`, [...entryPath, problem.key]);
      }
    }
    let workflow: DraftUnit<string> = { state: 'invalid' };
    if (!structural.some((problem) => problem.kind === 'workflow')) {
      const value = (entry.workflow as string).trim();
      if (isPathReference(value)) {
        problems.addMessage(
          'invalid-downstream',
          'downstream.workflow must be a workflow id, not a path.',
          [...entryPath, 'workflow'],
        );
      } else if (seen.has(value)) {
        problems.addMessage('invalid-downstream', `Duplicate downstream workflow: ${value}.`, [...entryPath, 'workflow']);
      } else {
        seen.add(value);
        workflow = { state: 'valid', value };
      }
    } else {
      problems.addMessage('missing-required', 'Missing or invalid downstream.workflow.', [...entryPath, 'workflow']);
    }
    if (structural.some((problem) => problem.kind === 'task-missing')) {
      problems.addMessage('missing-required', 'Missing or invalid downstream.task.', [...entryPath, 'task']);
    } else if (structural.some((problem) => problem.kind === 'task-line')) {
      problems.addMessage('invalid-downstream', 'downstream.task must be a single line.', [...entryPath, 'task']);
    }
    const mapping = entry.artifacts === undefined ? {} : (entry.artifacts as Record<string, unknown>);
    if (structural.some((problem) => problem.kind === 'artifacts')) {
      problems.addMessage('invalid-downstream', 'downstream.artifacts must be a mapping.', [...entryPath, 'artifacts']);
    } else {
      for (const [name, source] of Object.entries(mapping)) {
        const artifactPath = [...entryPath, 'artifacts', name];
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || name === '__proto__' || name === 'constructor' || name === 'prototype') {
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
    entries.push({ index, workflow });
  });
  return { sectionValid: true, entries };
}

export interface CollectedCompletion {
  /** The declared completion stage, when it is readable, for the verify-path points. */
  stage: string | null;
}

/** Reads `completion` as its own unit set, so a broken stage does not hide its errors. */
export function collectCompletion(
  raw: Record<string, unknown>,
  stages: readonly DraftStage[],
  declaredIds: ReadonlySet<string>,
  problems: DraftProblems,
): CollectedCompletion {
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
  collectOutputs(raw.outputs ?? [], stages, declaredIds, problems, 'completion.outputs', ['completion', 'outputs']);
  return { stage: stageId };
}
