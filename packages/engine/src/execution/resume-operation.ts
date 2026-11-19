import path from 'node:path';

import type { ClientRegistry, OnExpired, ResolvedResumePolicy } from '@nodeint/migent-kernel';
import { effectiveOnExpired, evaluateResume } from '@nodeint/migent-kernel';
import { readParsedEvents, resumeFacts } from '@nodeint/migent-session';

import type { Definition, Edge, Operation } from '../runtime/operation.js';
import type { PlainData } from '../runtime/plain-data.js';
import type { GateChange } from './gate-changes.js';
import { type Check,detach, isNumber, isString, nullable, oneOf, revive, shape } from './plain.js';

export const CONVERSATION_RESUME = 'conversation.resume';

/** What the gate decides: continue the conversation, start a fresh one, or stop for a human decision. */
export type GateVerdict = 'resume' | 'fresh' | 'ask';

export type ResumeInput = {
  readonly path: 'dispatch' | 'reopen' | 'role';
  readonly session_id: string;
  /** The target stage, or the role of a role session. */
  readonly stage_id: string;
  readonly source_execution_id: string;
  readonly client: string;
  readonly model: string;
};

export type ResumeExpiry = {
  readonly action: GateVerdict;
  readonly origin: 'stage' | 'policy' | 'default';
  readonly policy: string;
  readonly estimate: {
    readonly idleSec: number | null;
    readonly contextTokens: number | null;
    readonly thresholdSec: number;
    readonly cacheTtlSec: number;
    readonly marginSec: number;
  };
};

export type ResumeOutput = { readonly verdict: GateVerdict; readonly expired: ResumeExpiry | null };

const inputCheck: Check = shape({
  path: oneOf('dispatch', 'reopen', 'role'), session_id: isString, stage_id: isString,
  source_execution_id: isString, client: isString, model: isString,
});

const expiryCheck: Check = shape({
  action: oneOf('resume', 'fresh', 'ask'), origin: oneOf('stage', 'policy', 'default'), policy: isString,
  estimate: shape({
    idleSec: nullable(isNumber), contextTokens: nullable(isNumber), thresholdSec: isNumber,
    cacheTtlSec: isNumber, marginSec: isNumber,
  }),
});

const outputCheck: Check = shape({ verdict: oneOf('resume', 'fresh', 'ask'), expired: nullable(expiryCheck) });

function acceptsOutput(output: PlainData): boolean {
  if (!outputCheck(output)) return false;
  const { verdict, expired } = revive<ResumeOutput>(output);
  return expired === null ? verdict === 'resume' : expired.action === verdict;
}

/** What the temporary core handler evaluates: the policy the frozen session selected. Removed by the cutover. */
export type ResumeEvaluation = {
  readonly workspace: string;
  readonly policy: ResolvedResumePolicy;
  readonly stageOnExpired: OnExpired | null;
  readonly clients: ClientRegistry;
  readonly now?: Date;
};

function sessionDirectory(workspace: string, sessionId: string): string {
  return path.join(workspace, '.migent', 'sessions', sessionId);
}

/**
 * `conversation.resume`: the one gate for resuming a conversation after the prompt cache may have expired. The
 * handler's own output is `resume`, unless the temporary evaluation says the resume expired. A plugin may supply
 * the output instead (`shortCircuit`), which must pass the same output check.
 */
export function createConversationResumeOperation(
  evaluation: ResumeEvaluation,
): Operation<ResumeInput & PlainData, ResumeOutput & PlainData, GateChange> {
  const { workspace } = evaluation;
  return {
    id: CONVERSATION_RESUME,
    interceptable: { before: [], shortCircuit: true },
    evidence(input) {
      const { session_id: sessionId, stage_id: stageId, source_execution_id: source } = input;
      const facts = resumeFacts(workspace, { sessionId, executionId: source }, evaluation.clients);
      const events = readParsedEvents(path.join(sessionDirectory(workspace, sessionId), 'events.jsonl'))
        .filter((event) => event.event.startsWith('resume.')
          && event.data.stage_id === stageId && event.data.source_execution_id === source)
        .map((event) => detach(event.data));
      return detach({ facts, events });
    },
    acceptsInput: (input): input is ResumeInput & PlainData => inputCheck(input),
    producesOutput: (output): output is ResumeOutput & PlainData => acceptsOutput(output),
    handle(input) {
      const { policy, stageOnExpired } = evaluation;
      const facts = resumeFacts(
        workspace, { sessionId: input.session_id, executionId: input.source_execution_id }, evaluation.clients,
      );
      const result = evaluateResume(policy, { ...facts, now: evaluation.now ?? new Date() });
      if (!result.expired) return Promise.resolve({ kind: 'succeeded', output: { verdict: 'resume', expired: null }, changes: [] });
      const { action, origin } = effectiveOnExpired({ stageOnExpired, policy });
      if (origin === 'human') throw new Error('A human origin cannot come from a policy.');
      const expired: ResumeExpiry = {
        action, origin, policy: policy.name,
        estimate: { ...result.estimate, cacheTtlSec: policy.cacheTtlSec, marginSec: policy.marginSec },
      };
      return Promise.resolve({ kind: 'succeeded', output: detach({ verdict: action, expired }) as ResumeOutput & PlainData, changes: [] });
    },
  };
}

const EDGES: readonly Edge[] = [
  { from: CONVERSATION_RESUME, outcome: 'succeeded', to: { kind: 'end' } },
  { from: CONVERSATION_RESUME, outcome: 'failed', to: { kind: 'end' } },
];

/** One edge to the end. An accepted expiry becomes the `resume.expired` record; anything else writes nothing. */
export const conversationResumeDefinition: Definition<{ readonly input: ResumeInput }, GateChange, ResumeOutput> = {
  edges: EDGES,
  decide(state, _request, outcome) {
    if (outcome.kind !== 'succeeded') return { kind: 'end', result: { verdict: 'resume', expired: null }, changes: [] };
    const output = revive<ResumeOutput>(outcome.output);
    if (output.expired === null) return { kind: 'end', result: output, changes: [] };
    const { expired } = output;
    return {
      kind: 'end', result: output,
      changes: [{
        kind: 'recordResumeExpired',
        record: {
          stageId: state.input.stage_id, sourceExecutionId: state.input.source_execution_id,
          action: expired.action, origin: expired.origin, policy: expired.policy,
          estimate: { ...expired.estimate },
        },
      }],
    };
  },
};
