import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { frozenResumePolicy, readWorkflowFreeze, type SessionStore } from '@nodeint/migent-session';
import { isRoleStage } from '@nodeint/migent-workflow';

import type { ExecuteRun } from './dispatch.js';
import { gateResume } from './resume-gate.js';

/** What the gate decided for the cancelled executions a continue would reopen. */
export interface ReopenVerdicts {
  /** Executions that must not be reopened in place: `ask` and `fresh` both leave them cancelled. */
  readonly skip: ReadonlySet<string>;
  /** `fresh`: the cancelled execution, its stage, and the text the new attempt carries. */
  readonly fresh: readonly { executionId: string; stageId: string; reply: string }[];
}

const CUT_OFF = 'The previous turn was cut off before it finished. Continue the stage.';

/** The turn that was cut off, as the new attempt's carried input. */
function cutOffPrompt(store: SessionStore, sessionId: string, executionId: string): string {
  const context = store.executionContext(sessionId, executionId);
  const file = context === null ? null : path.join(context.directory, 'prompt.md');
  const text = file !== null && existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  return text === '' ? CUT_OFF : text;
}

/**
 * Judges every cancelled execution before any is reopened (D12), from the evidence as it stands: the
 * `completed_at` it was given when it was cancelled. Only role executions of a stage with a frozen policy
 * are judged; the rest reopen as before.
 */
export function judgeCancelled(
  run: Pick<ExecuteRun, 'workspace' | 'workflow' | 'sessionId' | 'runner' | 'store'>,
  latestPerStage: boolean,
  onlyStage: string | null = null,
): ReopenVerdicts {
  const { workspace, workflow, sessionId, runner, store } = run;
  const freeze = readWorkflowFreeze(path.join(workspace, '.migent', 'sessions', sessionId));
  const skip = new Set<string>();
  const fresh: { executionId: string; stageId: string; reply: string }[] = [];
  if (freeze === null) return { skip, fresh };
  for (const item of store.reopenableCancelled(sessionId, latestPerStage, onlyStage)) {
    const stage = workflow.stages[item.stageId];
    const policy = frozenResumePolicy(freeze, item.stageId);
    if (stage === undefined || !isRoleStage(stage) || policy === null) continue;
    const { verdict } = gateResume({
      store, workspace, sessionId, stageId: item.stageId, sourceExecutionId: item.executionId,
      policy, stageOnExpired: stage.onExpired, clients: runner.registry,
    });
    if (verdict === 'resume') continue;
    skip.add(item.executionId);
    if (verdict === 'fresh') {
      fresh.push({ ...item, reply: cutOffPrompt(store, sessionId, item.executionId) });
    }
  }
  return { skip, fresh };
}
