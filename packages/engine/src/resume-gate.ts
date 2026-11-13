import path from 'node:path';

import type { ClientRegistry, OnExpired, ResolvedResumePolicy, ResumeEstimate } from '@nodeint/migent-kernel';
import { effectiveOnExpired, evaluateResume } from '@nodeint/migent-kernel';
import { readParsedEvents, resumeFacts, type SessionStore } from '@nodeint/migent-session';

/** What a gated resume does: continue the conversation, start a fresh one, or stop for a human decision. */
export type GateVerdict = 'resume' | 'fresh' | 'ask';

export interface GateRequest {
  readonly store: SessionStore;
  readonly workspace: string;
  readonly sessionId: string;
  /** The stage that is about to dispatch, not the stage of the source. */
  readonly stageId: string;
  /** The execution whose conversation would be resumed. */
  readonly sourceExecutionId: string;
  /** The frozen or inherited policy; null means no policy applies and the gate does not run. */
  readonly policy: ResolvedResumePolicy | null;
  /** `session.on_expired` of the stage, from the frozen workflow. */
  readonly stageOnExpired: OnExpired | null;
  readonly clients: ClientRegistry;
  readonly now?: Date;
}

export interface GateResult {
  readonly verdict: GateVerdict;
  /** Set when the resume was judged expired; the facts behind the decision. */
  readonly estimate: ResumeEstimate | null;
}

/**
 * The human decision recorded for this `(stage, source)`: `resume` or `fresh`, while no later turn has used it.
 * `superseded` is not a choice. A decision is used once the target stage starts an execution after it, or the
 * source itself is reopened in place (a cancelled resume), so a later resume of the same source is judged again.
 */
function decidedChoice(request: GateRequest): 'resume' | 'fresh' | null {
  const events = readParsedEvents(path.join(request.workspace, '.migent', 'sessions', request.sessionId, 'events.jsonl'));
  let choice: 'resume' | 'fresh' | null = null;
  for (const event of events) {
    const { data } = event;
    if (event.event === 'resume.decided') {
      if (data.stage_id !== request.stageId || data.source_execution_id !== request.sourceExecutionId) continue;
      choice = data.choice === 'resume' || data.choice === 'fresh' ? data.choice : null;
    } else if (choice !== null && isUse(event, request)) {
      choice = null;
    }
  }
  return choice;
}

type LogEvent = { event: string; stageId: string | null; executionId: string | null };

function isUse(event: LogEvent, request: GateRequest): boolean {
  if (event.event === 'execution.started') return event.stageId === request.stageId;
  return event.event === 'execution.running' && event.executionId === request.sourceExecutionId;
}

/**
 * The one gate for resuming a conversation after the prompt cache may have expired. Without a policy it
 * returns `resume` and writes nothing. A human decision for this `(stage, source)` is applied once and wins.
 * Otherwise an expired verdict is recorded as `resume.expired`, whatever the action, and `ask` also
 * leaves a pending decision that stops the stage. The caller holds the session lock.
 */
export function gateResume(request: GateRequest): GateResult {
  const { policy, store, sessionId, stageId, sourceExecutionId } = request;
  if (policy === null) return { verdict: 'resume', estimate: null };
  const decision = decidedChoice(request);
  if (decision !== null) return { verdict: decision, estimate: null };
  const waiting = store.pendingResumes(sessionId);
  if (waiting.some((stop) => stop.stageId === stageId && stop.sourceExecutionId === sourceExecutionId)) {
    return { verdict: 'ask', estimate: null };
  }
  const facts = resumeFacts(request.workspace, { sessionId, executionId: sourceExecutionId }, request.clients);
  const evaluation = evaluateResume(policy, { ...facts, now: request.now ?? new Date() });
  if (!evaluation.expired) return { verdict: 'resume', estimate: evaluation.estimate };
  const { action, origin } = effectiveOnExpired({ stageOnExpired: request.stageOnExpired, policy });
  store.recordResumeExpired(sessionId, {
    stageId,
    sourceExecutionId,
    action,
    origin,
    policy: policy.name,
    estimate: { ...evaluation.estimate, cacheTtlSec: policy.cacheTtlSec, marginSec: policy.marginSec },
  });
  return { verdict: action, estimate: evaluation.estimate };
}
