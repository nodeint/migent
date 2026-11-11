import type { ExecutionSnapshot } from '@nodeint/migent-kernel';
import { log } from '@nodeint/migent-kernel';
import { parseExecutionId, SessionStore, type SkipDetails } from '@nodeint/migent-session';
import type { StageSpec } from '@nodeint/migent-workflow';

import type { AgentToolRunner } from './agent-runner.js';
import { text } from './execute-state.js';
import { evaluateRunWhen } from './run-when.js';

/** A fresh visit of a run_when stage is evaluated. Retries and resumed blocks already passed the condition. */
export function skipUnlessRunWhenMatches(
  run: { workspace: string; sessionId: string; runner: Pick<AgentToolRunner, 'registry'> },
  stage: StageSpec,
  snapshots: readonly ExecutionSnapshot[],
): Record<string, unknown> | null {
  const { workspace, sessionId } = run;
  if ((stage.runWhen === null || stage.runWhen === undefined)) return null;
  if (!isFreshVisit(snapshots, stage.id)) return null;
  const evaluation = evaluateRunWhen(workspace, sessionId, stage);
  if ('matched' in evaluation) {
    log(`stage ${stage.id} · run_when matched ${evaluation.matched}.`);
    return null;
  }
  return recordRunWhenSkip(run, stage.id, evaluation.skip);
}

// A stage visit is fresh when it never ran, was skipped, or last completed without a block or question.
function isFreshVisit(snapshots: readonly ExecutionSnapshot[], stageId: string): boolean {
  let latest: ExecutionSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.stageId !== stageId) continue;
    if (latest === null || snapshot.executionOrder > latest.executionOrder) latest = snapshot;
  }
  return latest === null ||
    latest.status === 'skipped' ||
    (latest.status === 'completed' && latest.outcomeStatus !== 'blocked' && latest.outcomeStatus !== 'question');
}

// Records a skipped execution for a run_when stage whose patterns matched no changed path.
function recordRunWhenSkip(
  run: { workspace: string; sessionId: string; runner: Pick<AgentToolRunner, 'registry'> },
  stageId: string,
  skip: SkipDetails,
): Record<string, unknown> {
  const { workspace, sessionId, runner } = run;
  const store = new SessionStore(workspace, undefined, runner.registry);
  const context = store.recordSkippedExecution(sessionId, stageId, skip);
  const attempt = parseExecutionId(context.executionId)?.attempt ?? null;
  log(`stage ${stageId} · attempt ${attempt ?? 1} · skipped (no changed path matches run_when).`);
  return {
    agent_id: null,
    options: {},
    session_id: sessionId,
    execution_id: context.executionId,
    artifact_directory: context.artifactDirectory,
    failure_reason: '',
    failure_kind: '',
    reset_at: '',
    client: '',
    outcome_status: '',
    outcome_decision: '',
    session_status: text(store.readSessionStatus(sessionId).status),
    response: '',
    execution_status: 'skipped',
    skip: {
      reason: skip.reason,
      baseline: skip.baseline,
      patterns: skip.patterns,
      changed_paths: skip.changedPaths,
    },
  };
}
