import { dependencyClosure, type WorkflowDocument } from '@nodeint/migent-workflow';

import { type ExecutionSnapshot } from './outputs.js';
import { revisionResumeExecution, verifyExhaustedExecution } from './selection-history.js';

export interface RunPool {
  readonly running: readonly string[];
  readonly concurrency: number;
  readonly snapshots?: readonly ExecutionSnapshot[];
}

export function runnableNow(workflow: WorkflowDocument, ready: readonly string[], pool: RunPool): string[] {
  const { running, concurrency, snapshots = [] } = pool;
  if (concurrency < 1) return [];
  const ordered = declarationOrder(workflow, ready);
  const suspended = suspendedReady(workflow, ordered);
  const working = new Set(running);
  if (working.size >= concurrency) return [];
  const started: string[] = [];
  for (const stageId of ordered) {
    if (working.size >= concurrency) break;
    if (!workflow.stages[stageId] || working.has(stageId) || suspended.has(stageId)) continue;
    if (overlapsWorking(workflow, stageId, working)) continue;
    if (mustRunAlone(workflow, stageId, snapshots)) {
      // Borrowed agent. Skip it while anything else is in this turn; do not block the rest.
      if (working.size > 0) continue;
      started.push(stageId);
      break;
    }
    started.push(stageId);
    working.add(stageId);
  }
  return started;
}


export function declarationOrder(workflow: WorkflowDocument, ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  const ordered: string[] = [];
  for (const stageId of Object.keys(workflow.stages)) {
    if (wanted.has(stageId)) ordered.push(stageId);
  }
  return ordered;
}

function suspendedReady(workflow: WorkflowDocument, ready: readonly string[]): Set<string> {
  const readySet = new Set(ready);
  const suspended = new Set<string>();
  for (const stageId of ready) {
    for (const other of dependencyClosure(workflow.stages, stageId)) {
      if (!readySet.has(other)) continue;
      suspended.add(stageId);
      break;
    }
  }
  return suspended;
}

function overlapsWorking(workflow: WorkflowDocument, stageId: string, working: ReadonlySet<string>): boolean {
  const closure = dependencyClosure(workflow.stages, stageId);
  for (const other of working) {
    if (other === stageId) continue;
    if (closure.has(other) || dependencyClosure(workflow.stages, other).has(stageId)) return true;
  }
  return false;
}

function mustRunAlone(
  workflow: WorkflowDocument,
  stageId: string,
  snapshots: readonly ExecutionSnapshot[],
): boolean {
  const stage = workflow.stages[stageId];
  if (!stage?.resumeFrom) return false;
  // Verify repair and a route back continue this stage's own agent.
  if (verifyExhaustedExecution(snapshots, stageId) !== null) return false;
  if (revisionResumeExecution(workflow, snapshots, stageId) !== null) return false;
  return true;
}
