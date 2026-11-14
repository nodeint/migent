import { readFileSync } from 'node:fs';

import { buildStagePrompt, buildStageReplyPrompt, buildVerifyRepairPrompt, type verifyExhaustedExecution } from '@nodeint/migent-kernel';
import type { TurnKind } from '@nodeint/migent-prompts';
import { type freezeSessionTask, frozenResumePolicy, type readWorkflowFreeze, SessionStore } from '@nodeint/migent-session';
import type { RoleStageSpec } from '@nodeint/migent-workflow';

import type { ExecuteRun } from './dispatch.js';
import { dispatchResumeExecution } from './dispatch.js';
import { RESUME_EXPIRED_STAGE,StageDispatchResult } from './dispatch.js';
import { gateResume } from './resume-gate.js';

export type GateOutcome =
  | { verdict: 'resume'; sourceExecutionId: null }
  | { verdict: 'fresh' | 'ask'; sourceExecutionId: string };

const NO_GATE: GateOutcome = { verdict: 'resume', sourceExecutionId: null };

/**
 * The resume gate for one stage, before its prompt exists: a saved reply is taken only when the stage dispatches.
 * Runs only when the frozen session selected a policy and the stage would resume a conversation.
 */
export function gateStageResume(
  run: Pick<ExecuteRun, 'workspace' | 'workflow' | 'sessionId' | 'runner'>,
  stage: { stageId: string; stageSpec: RoleStageSpec; freeze: ReturnType<typeof readWorkflowFreeze> },
  source: { executionId?: string } = {},
): GateOutcome {
  const { workspace, workflow, sessionId, runner } = run;
  const { stageId, stageSpec, freeze } = stage;
  const policy = freeze === null ? null : frozenResumePolicy(freeze, stageId);
  if (policy === null) return NO_GATE;
  const sourceExecutionId = source.executionId ?? dispatchResumeExecution(workspace, workflow, { sessionId, stageId });
  if (!sourceExecutionId) return NO_GATE;
  const { verdict } = gateResume({
    store: new SessionStore(workspace),
    workspace,
    sessionId,
    stageId,
    sourceExecutionId,
    policy,
    stageOnExpired: stageSpec.onExpired,
    clients: runner.registry,
  });
  return verdict === 'resume' ? NO_GATE : { verdict, sourceExecutionId };
}

/** The stage result of a resume that stopped for a decision: no execution exists. */
export function resumeExpiredStage(sessionId: string): Record<string, unknown> {
  return new StageDispatchResult({
    sessionId,
    executionId: '',
    outcomeStatus: '',
    outcomeDecision: '',
    sessionStatus: 'expired',
    response: '',
    executionStatus: RESUME_EXPIRED_STAGE,
  }).toJson();
}

/** Whether the stage's latest execution asked a question that the pending reply answers. */
export function answersQuestion(workspace: string, sessionId: string, stageId: string): boolean {
  return new SessionStore(workspace).questionStages(sessionId).some((row) => row.stageId === stageId);
}

/**
 * A fresh conversation: the full stage prompt (the task, upstream and prior-session artifacts, role instructions,
 * and the blocker, failure and route-back context it already carries), then the reply or the verify report the
 * resumed turn would have sent.
 */
export function freshStagePrompt(
  inputs: {
    stageReply: { text: string } | null;
    exhausted: ReturnType<typeof verifyExhaustedExecution>;
    frozen: ReturnType<typeof freezeSessionTask>;
    promptInput: Parameters<typeof buildStagePrompt>[0];
  },
  stage: { stageSpec: RoleStageSpec; answers: boolean },
): { turn: TurnKind; prompt: string } {
  const { stageReply, exhausted, frozen, promptInput } = inputs;
  const parts = [buildStagePrompt(promptInput)];
  const { answers } = stage;
  if (stageReply !== null) parts.push(buildStageReplyPrompt(stageReply.text, { answers, interrupted: false }));
  if (exhausted?.verifyReport) {
    const { maxVerify } = stage.stageSpec;
    parts.push(
      buildVerifyRepairPrompt(
        readFileSync(exhausted.verifyReport, 'utf8'),
        { red: maxVerify, maxVerify, artifactPath: null },
        { taskFile: frozen.taskFile, sessionDirectory: frozen.sessionDirectory },
      ),
    );
  }
  return { turn: 'start', prompt: parts.join('\n\n') };
}
