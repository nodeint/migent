
import type { CollectedOutputs } from '../draft/outputs.js';
import type { DraftStage } from '../draft/problems.js';
import { DraftProblems } from '../draft/problems.js';
import { dependencyClosure, isLeafStage, routeTargets, stageRouteTargets } from '../graph.js';
import type { StageSpec } from '../model.js';
import { pyRepr } from '../record.js';

/** The conditional (`run_when`) membership the draft can prove from readable edges. */
export function draftConditionalStages(
  stages: readonly DraftStage[],
  declaredIds: ReadonlySet<string>,
): Map<string, string> {
  const graph: Record<string, StageSpec> = Object.create(null);
  for (const stage of stages) graph[stage.id] = graphStageOf(stage);
  const members = new Map<string, string>();
  for (const source of stages) {
    if (source.runWhen.state !== 'valid' || source.runWhen.value === null) continue;
    for (const member of definiteConditionalReach({ stages, graph, declaredIds }, source.id)) {
      if (!members.has(member)) members.set(member, source.id);
    }
  }
  return members;
}

/** A stage view carrying only the fields the cross-stage rules read. */
export function graphStageOf(stage: DraftStage): StageSpec {
  return {
    kind: 'verify',
    role: null,
    id: stage.id,
    description: null,
    artifacts: [],
    decisionArtifacts: {},
    decisionValues: [],
    dependsOn: stage.dependsOn.state === 'valid' ? stage.dependsOn.value : [],
    resumeFrom: null,
    onExpired: null,
    instructions: [],
    agent: null,
    options: {},
    maxRevisions: stage.maxRevisions.state === 'valid' ? stage.maxRevisions.value : null,
    routes: stage.routes.state === 'valid' ? stage.routes.value : {},
    verify: stage.verify.state === 'valid' ? stage.verify.value : [],
    maxVerify: 0,
    verifyTimeoutSec: null,
    runWhen: stage.runWhen.state === 'valid' ? stage.runWhen.value : null,
  };
}

/** True when every stage `stageId` depends on, transitively, was collected with a readable list. */
export function dependencyClosureKnown(
  stagesById: ReadonlyMap<string, DraftStage>,
  declaredIds: ReadonlySet<string>,
  stageId: string,
): boolean {
  const pending = [stageId];
  const seen = new Set<string>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    // A declared stage without a collected unit, or an unknown edge, leaves the closure unproven.
    if (!declaredIds.has(next)) return false;
    const stage = stagesById.get(next);
    if (stage === undefined) return false;
    if (stage.dependsOn.state !== 'valid') return false;
    pending.push(...stage.dependsOn.value);
  }
  return true;
}

type ReachScope = {
  readonly stages: readonly DraftStage[];
  readonly graph: Record<string, StageSpec>;
  readonly declaredIds: ReadonlySet<string>;
};

/** Stages a skip of `stageId` definitely leaves unreached, using only edges the draft made readable. */
export function definiteConditionalReach(scope: ReachScope, stageId: string): Set<string> {
  const byId = new Map(scope.stages.map((stage) => [stage.id, stage]));
  const reach = new Set<string>([stageId]);
  const pending = [stageId];
  for (let member = pending.pop(); member !== undefined; member = pending.pop()) {
    for (const next of definiteSuccessors(scope, byId, member)) {
      if (reach.has(next) || !byId.has(next)) continue;
      reach.add(next);
      pending.push(next);
    }
  }
  return reach;
}

/** Readable dependents of `member`, plus its forward route targets when its dependency chain is readable. */
function definiteSuccessors(
  scope: ReachScope,
  byId: ReadonlyMap<string, DraftStage>,
  member: string,
): string[] {
  const found = scope.stages
    .filter((other) => other.dependsOn.state === 'valid' && other.dependsOn.value.includes(member))
    .map((other) => other.id);
  const stage = byId.get(member);
  // A route target is forward only when the member's whole dependency chain is readable.
  if (stage === undefined || stage.routes.state !== 'valid') return found;
  if (!dependencyClosureKnown(byId, scope.declaredIds, member)) return found;
  const closure = dependencyClosure(scope.graph, member);
  for (const target of stageRouteTargets(stage.routes.value)) {
    if (!closure.has(target)) found.push(target);
  }
  return found;
}

/** The runtime's cross-stage rules over whatever each stage could read. A rule is skipped only when a
 * unit it reads is unreadable — never because an unrelated field or stage failed.
 */
export interface GraphProblemsContext {
  readonly rawCount: number;
  readonly declaredIds: ReadonlySet<string>;
  readonly completionStage: string | null;
  readonly outputs: CollectedOutputs;
  readonly version2: boolean;
  readonly problems: DraftProblems;
}

/** The stage views and completeness flags every cross-stage rule reads. */
interface GraphScope {
  readonly stages: readonly DraftStage[];
  readonly graph: Record<string, StageSpec>;
  readonly stagesById: ReadonlyMap<string, DraftStage>;
  readonly structurallyComplete: boolean;
  readonly dependsComplete: boolean;
}

export function collectGraphProblems(stages: readonly DraftStage[], context: GraphProblemsContext): void {
  const { rawCount: rawStageCount, problems } = context;
  // An unreadable id or a duplicate leaves some stage's fields unknown, but each check below reads only
  // what its own finding needs, so the rest of the graph is still checked.
  const structurallyComplete = stages.length === rawStageCount;
  const routesComplete = !stages.some((stage) => stage.routes.state === 'invalid');
  const dependsComplete = !stages.some((stage) => stage.dependsOn.state === 'invalid');
  const stagesById = new Map(stages.map((stage) => [stage.id, stage]));
  const graph: Record<string, StageSpec> = Object.create(null);
  for (const stage of stages) graph[stage.id] = graphStageOf(stage);
  const scope: GraphScope = { stages, graph, stagesById, structurallyComplete, dependsComplete };

  // A missing route set or an uncollected stage could hide the route back, so both must be readable.
  if (routesComplete && structurallyComplete) collectMaxRevisionsProblems(scope, problems);
  collectConditionalReachProblems(scope, context);
  collectVerifyPathProblems(scope, context);
}

/** Each `max_revisions` needs some route back to its stage. */
function collectMaxRevisionsProblems(scope: GraphScope, problems: DraftProblems): void {
  const targets = new Set<string>();
  for (const stage of Object.values(scope.graph)) {
    for (const target of stageRouteTargets(stage.routes)) targets.add(target);
  }
  for (const stage of scope.stages) {
    if (stage.maxRevisions.state === 'invalid' || stage.maxRevisions.value === null) continue;
    if (targets.has(stage.id)) continue;
    problems.addMessage(
      'invalid-value',
      `stages.${stage.id}.max_revisions requires a route back to ${stage.id}.`,
      ['stages', stage.index, 'max_revisions'],
    );
  }
}

/** A `run_when` skip must not bypass a verify or leave a published output missing. */
function collectConditionalReachProblems(scope: GraphScope, context: GraphProblemsContext): void {
  const { stages, graph } = scope;
  const { declaredIds: declaredStageIds, outputs, problems } = context;
  // Conditional reach uses only readable edges; anything found this way is definitely reached, so an
  // unrelated broken `depends_on`, unreadable stage, or malformed route elsewhere hides nothing.
  const reachedBy = new Map<string, string>();
  for (const source of stages) {
    if (source.runWhen.state !== 'valid' || source.runWhen.value === null) continue;
    for (const member of definiteConditionalReach({ stages, graph, declaredIds: declaredStageIds }, source.id)) {
      if (!reachedBy.has(member)) reachedBy.set(member, source.id);
    }
  }
  for (const stage of stages) {
    const source = reachedBy.get(stage.id);
    if (source === undefined || !mayHaveVerify(stage)) continue;
    problems.addMessage(
      'invalid-value',
      `stages.${stage.id}.verify is reached through run_when stage ${source}; a skip would bypass this verify.`,
      ['stages', stage.index, 'verify'],
    );
  }
  outputs.values.forEach((output, at) => {
    const source = reachedBy.get(output.fromStage);
    if (source === undefined) return;
    const origin =
      source === output.fromStage
        ? `run_when stage ${source}`
        : `stages.${output.fromStage}, which is reached through run_when stage ${source}`;
    problems.addMessage(
      'invalid-artifact',
      `outputs ${pyRepr(output.name)} comes from ${origin}; a skip would leave it missing.`,
      ['outputs', outputs.indexes[at] ?? at, 'from_stage'],
    );
  });
}

/** A stage whose verify list is unknown-but-present or non-empty; an invalid list is reported elsewhere. */
function mayHaveVerify(stage: DraftStage): boolean {
  if (stage.verify.state === 'invalid') return false;
  return !(stage.verify.state === 'valid' && stage.verify.value.length === 0);
}

/** Every verify stage must be on each provable path to complete. */
function collectVerifyPathProblems(scope: GraphScope, context: GraphProblemsContext): void {
  const { stages, graph } = scope;
  const points = completionPoints(scope, context);
  if (points.size === 0) return;
  for (const stage of stages) {
    if (stage.verify.state !== 'valid' || stage.verify.value.length === 0) continue;
    for (const point of points) {
      if (point === stage.id || dependencyClosure(graph, point).has(stage.id)) continue;
      context.problems.addMessage(
        'invalid-value',
        `stages.${stage.id}.verify is not on every path to complete: ${point} does not depend on ${stage.id}.`,
        ['stages', stage.index, 'verify'],
      );
    }
  }
}

/** The completion points whose dependency closure the draft can read. */
function completionPoints(scope: GraphScope, context: GraphProblemsContext): Set<string> {
  const { stages, graph, stagesById, dependsComplete, structurallyComplete } = scope;
  const { declaredIds: declaredStageIds, completionStage, version2 } = context;
  // Each completion point is checked against its own dependency closure. A malformed `depends_on` or an
  // uncollected stage elsewhere cannot make a point's path unknown, and an unreadable point's own chain
  // is the only reason to skip that point.
  const points = new Set<string>();
  const closureKnown = (id: string): boolean => dependencyClosureKnown(stagesById, declaredStageIds, id);
  if (!version2 && completionStage !== null && closureKnown(completionStage)) points.add(completionStage);
  for (const stage of stages) {
    if (routesToComplete(stage) && closureKnown(stage.id)) points.add(stage.id);
  }
  // A leaf is only provable when every dependency list and every stage is readable, and the candidate's
  // own routes are readable too (an absent route set means it has none).
  if (version2 && dependsComplete && structurallyComplete) {
    for (const stage of stages) {
      if (stage.routes.state !== 'invalid' && isLeafStage(graph, graph[stage.id])) points.add(stage.id);
    }
  }
  return points;
}

/** True when the stage's readable routes send some decision to `complete`. */
function routesToComplete(stage: DraftStage): boolean {
  if (stage.routes.state === 'invalid') return false;
  return Object.values(stage.routes.value).some((value) => routeTargets(value).includes('complete'));
}
