import path from 'node:path';

import type { ClientRegistry, OnExpired, ResolvedResumePolicy } from '@nodeint/migent-kernel';
import { cancellationSignal } from '@nodeint/migent-kernel';
import { readParsedEvents, type SessionStore } from '@nodeint/migent-session';

import { GateApplier, type GateChange } from './execution/gate-changes.js';
import {
  CONVERSATION_RESUME, conversationResumeDefinition, createConversationResumeOperation, type GateVerdict,
  type ResumeExpiry, type ResumeInput,
} from './execution/resume-operation.js';
import type { InterceptorChain } from './runtime/interception.js';
import { OperationRuntime } from './runtime/operation-runtime.js';

export type { GateVerdict } from './execution/resume-operation.js';

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
  /** Which caller asks, and the frozen target of the stage or role. */
  readonly path: ResumeInput['path'];
  readonly target: { readonly client: string; readonly model: string };
  /** The host's interceptors; none for a gate no plugin intercepts. */
  readonly interceptors?: InterceptorChain | undefined;
  readonly now?: Date;
}

export interface GateResult {
  readonly verdict: GateVerdict;
  /** Set when the resume was judged expired; the facts behind the decision. */
  readonly estimate: ResumeExpiry['estimate'] | null;
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
 * returns `resume` and writes nothing. A human decision for this `(stage, source)` is applied once and wins, then
 * an existing pending stop asks. Otherwise the `conversation.resume` operation decides, and an expired verdict is
 * recorded as `resume.expired`, whatever the action. The caller holds the session lock.
 */
export async function gateResume(request: GateRequest): Promise<GateResult> {
  const { policy, store, sessionId, stageId, sourceExecutionId } = request;
  if (policy === null) return { verdict: 'resume', estimate: null };
  const decision = decidedChoice(request);
  if (decision !== null) return { verdict: decision, estimate: null };
  const waiting = store.pendingResumes(sessionId);
  if (waiting.some((stop) => stop.stageId === stageId && stop.sourceExecutionId === sourceExecutionId)) {
    return { verdict: 'ask', estimate: null };
  }
  const directory = path.join(request.workspace, '.migent', 'sessions', sessionId);
  const runtime = new OperationRuntime<GateChange>({
    operations: [createConversationResumeOperation({
      workspace: request.workspace, policy, stageOnExpired: request.stageOnExpired, clients: request.clients,
      ...(request.now === undefined ? {} : { now: request.now }),
    })],
    applier: new GateApplier({ store, sessionId, directory }),
    ...(request.interceptors === undefined ? {} : { interceptors: request.interceptors }),
  });
  const input: ResumeInput = {
    path: request.path, session_id: sessionId, stage_id: stageId, source_execution_id: sourceExecutionId,
    client: request.target.client, model: request.target.model,
  };
  const output = await runtime.run({
    scope: { sessionId, stageId, role: stageId },
    definition: conversationResumeDefinition,
    state: { input },
    request: { identity: { executionId: sourceExecutionId, operationId: CONVERSATION_RESUME, attempt: 1 }, input },
  });
  cancellationSignal().throwIfCancelled();
  return { verdict: output.verdict, estimate: output.expired === null ? null : output.expired.estimate };
}
