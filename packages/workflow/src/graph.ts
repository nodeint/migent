import { ConfigurationError } from './errors.js';
import type { StageSpec, WorkflowOutput } from './model.js';
import { isRoleStage } from './model.js';
import { pyRepr } from './record.js';

export const reachCache = new WeakMap<Record<string, StageSpec>, Map<string, Set<string>>>();

/**
 * Stages a skip of `stageId` can leave without a current completion: the stage itself, its dependents,
 * and its forward route targets, repeated until nothing changes. A route back to a stage in the
 * member's dependency closure is not a forward target.
 */
export function conditionalReach(stages: Record<string, StageSpec>, stageId: string): Set<string> {
  const cache = reachCacheFor(stages);
  const cached = cache.get(stageId);
  if (cached !== undefined) return cached;
  const reach = new Set<string>([stageId]);
  const pending = [stageId];
  for (let member = pending.pop(); member !== undefined; member = pending.pop()) {
    for (const next of skipSuccessors(stages, member)) {
      if (reach.has(next) || !Object.hasOwn(stages, next)) continue;
      reach.add(next);
      pending.push(next);
    }
  }
  cache.set(stageId, reach);
  return reach;
}

function reachCacheFor(stages: Record<string, StageSpec>): Map<string, Set<string>> {
  let cache = reachCache.get(stages);
  if (cache === undefined) {
    cache = new Map();
    reachCache.set(stages, cache);
  }
  return cache;
}

/** The dependents of `member` and its forward route targets (routes back into its closure excluded). */
function skipSuccessors(stages: Record<string, StageSpec>, member: string): string[] {
  const found: string[] = [];
  for (const other of Object.values(stages)) {
    if (other.dependsOn.includes(member)) found.push(other.id);
  }
  const closure = dependencyClosure(stages, member);
  for (const value of Object.values(stages[member]?.routes ?? {})) {
    for (const target of routeTargets(value)) {
      if (target !== 'complete' && !closure.has(target)) found.push(target);
    }
  }
  return found;
}

/** Every stage in the reach of a run_when stage, mapped to the first run_when stage that reaches it. */
export function conditionalStages(stages: Record<string, StageSpec>): Map<string, string> {
  const members = new Map<string, string>();
  for (const stage of Object.values(stages)) {
    if ((stage.runWhen === null || stage.runWhen === undefined)) continue;
    for (const reached of conditionalReach(stages, stage.id)) {
      if (!members.has(reached)) members.set(reached, stage.id);
    }
  }
  return members;
}

export function validateConditionalStages(stages: Record<string, StageSpec>, outputs: readonly WorkflowOutput[]): void {
  const members = conditionalStages(stages);
  if (members.size === 0) return;
  for (const stage of Object.values(stages)) {
    const source = members.get(stage.id);
    if (source === undefined || stage.verify.length === 0) continue;
    throw new ConfigurationError(
      `stages.${stage.id}.verify is reached through run_when stage ${source}; a skip would bypass this verify.`,
    );
  }
  for (const output of outputs) {
    const source = members.get(output.fromStage);
    if (source === undefined) continue;
    const origin =
      source === output.fromStage
        ? `run_when stage ${source}`
        : `stages.${output.fromStage}, which is reached through run_when stage ${source}`;
    throw new ConfigurationError(
      `outputs ${pyRepr(output.name)} comes from ${origin}; a skip would leave it missing.`,
    );
  }
}

/** A route value is one stage id, `complete`, or a list of stage ids. */
export function routeTargets(target: string | readonly string[] | undefined): readonly string[] {
  if (typeof target === 'string') return [target];
  if (Array.isArray(target)) return target;
  return [];
}

export function routeListsStage(target: string | readonly string[] | undefined, stageId: string): boolean {
  return routeTargets(target).includes(stageId);
}

export function validateStageGraph(stages: Record<string, StageSpec>): void {
  const targets = routedStageIds(stages);
  for (const stage of Object.values(stages)) validateStageLinks(stages, stage, targets);
}

/** Every stage id named as a route target by any stage. */
function routedStageIds(stages: Record<string, StageSpec>): Set<string> {
  const targets = new Set<string>();
  for (const stage of Object.values(stages)) {
    for (const value of Object.values(stage.routes)) {
      for (const target of routeTargets(value)) {
        if (target !== 'complete') targets.add(target);
      }
    }
  }
  return targets;
}

function validateStageLinks(stages: Record<string, StageSpec>, stage: StageSpec, targets: ReadonlySet<string>): void {
  const missingDep = stage.dependsOn.find((dep) => !Object.hasOwn(stages, dep));
  if (missingDep !== undefined) {
    throw new ConfigurationError(
      `stages.${stage.id}.depends_on is not a declared stage: ${missingDep}`,
    );
  }
  if (stage.maxRevisions !== null && !targets.has(stage.id)) {
    throw new ConfigurationError(
      `stages.${stage.id}.max_revisions requires a route back to ${stage.id}.`,
    );
  }
  if (stage.resumeFrom !== null && !isRoleStage(stages[stage.resumeFrom])) {
    throw new ConfigurationError(
      `stages.${stage.id}.session.resume_from must name a role stage: ${stage.resumeFrom}.`,
    );
  }
}

export function isLeafStage(stages: Record<string, StageSpec>, stage: StageSpec): boolean {
  if (Object.keys(stage.routes).length > 0) return false;
  return !Object.values(stages).some((other) => other.dependsOn.includes(stage.id));
}

export function dependencyClosure(stages: Record<string, StageSpec>, stageId: string): Set<string> {
  const seen = new Set<string>();
  const pending = [...(stages[stageId]?.dependsOn ?? [])];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...(stages[next]?.dependsOn ?? []));
  }
  return seen;
}
