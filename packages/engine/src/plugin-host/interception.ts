import type { PluginCallContext } from '@nodeint/migent-contracts';
import { isValid, PluginAfterProposal, PluginBeforeProposal } from '@nodeint/migent-contracts';
import { utcNow } from '@nodeint/migent-kernel';
import { sessionEventLog } from '@nodeint/migent-session';

import type {
  InterceptionCall, InterceptionResult, InterceptorChain, InterceptPhase, InterceptProposal,
} from '../runtime/interception.js';
import type { PlainData } from '../runtime/plain-data.js';
import type { AgentCaller } from './agent-call.js';
import type { PluginRegistrations } from './context.js';
import { type PluginFailure, recordPluginFailure } from './holds.js';
import type { SelectedPlugin } from './selection.js';

export type InterceptorOutcome =
  | { readonly kind: 'ok'; readonly value: unknown }
  | { readonly kind: 'fail'; readonly reason: PluginFailure['reason']; readonly error: string };


/** The host's verdict on one interceptor's raw result, recorded as `plugin.decision`. */
export type InterceptorVerdict<T> =
  | { readonly kind: 'accepted'; readonly value: T; readonly proposed: Record<string, unknown>[]; readonly result: Record<string, unknown> }
  | { readonly kind: 'rejected'; readonly reason: string; readonly proposed: Record<string, unknown>[]; readonly result: Record<string, unknown> };

type PluginInterceptor = Entry['registrations'][number]['interceptor'];

type StepEntry = { plugin: SelectedPlugin; interceptor: PluginInterceptor };

type Step = { value: PlainData; shortCircuit: boolean };

export type InterceptorInvocation<T> = {
  readonly hook: string;
  readonly stageId: string;
  run(call: PluginCallContext): Promise<unknown>;
  judge(raw: unknown): InterceptorVerdict<T>;
};

type Runner = {
  invokeInterceptor<T>(plugin: SelectedPlugin, spec: InterceptorInvocation<T>): Promise<T | null>;
};

type Entry = { readonly plugin: SelectedPlugin; readonly registrations: PluginRegistrations['interceptors'] };

/** A registered target is an operation id, or a `prefix.*` pattern. */
function matches(target: string, operationId: string): boolean {
  return target.endsWith('.*') ? operationId.startsWith(target.slice(0, -1)) : target === operationId;
}

const recorded = (proposal: InterceptProposal): Record<string, unknown> =>
  proposal.kind === 'patch' ? { kind: 'patch', fields: Object.keys(proposal.fields) } : { kind: proposal.kind };

/**
 * Adapts the registered interceptors into the runtime's chain. Plugins run in frozen chain order and each one sees
 * the value the previous accepted proposal produced. A failed or refused interceptor leaves the value unchanged.
 */
export class HostInterceptorChain implements InterceptorChain {
  constructor(private readonly entries: readonly Entry[], private readonly host: Runner) {}

  public has(operationId: string, phase: InterceptPhase): boolean {
    return this.steps(operationId, phase).length > 0;
  }

  public async run(call: InterceptionCall): Promise<InterceptionResult> {
    const { phase, identity, scope } = call;
    let {value} = call;
    for (const { plugin, interceptor } of this.steps(identity.operationId, phase)) {
      const seen = value;
      const accepted = await this.host.invokeInterceptor<Step>(plugin, {
        hook: `operation:${identity.operationId}:${phase}`,
        stageId: scope.stageId,
        run: (context) => callInterceptor(interceptor, { phase, seen }, context),
        judge: (raw) => judgeProposal(call, seen, raw),
      });
      if (accepted === null) continue;
      value = accepted.value;
      if (accepted.shortCircuit) return { value, shortCircuit: true };
    }
    return { value, shortCircuit: false };
  }

  private steps(operationId: string, phase: InterceptPhase): StepEntry[] {
    const found: StepEntry[] = [];
    for (const { plugin, registrations } of this.entries) {
      for (const { target, interceptor } of registrations) {
        if (matches(target, operationId) && interceptor[phase] !== undefined) found.push({ plugin, interceptor });
      }
    }
    return found;
  }
}

function callInterceptor(
  interceptor: PluginInterceptor,
  point: { phase: InterceptPhase; seen: PlainData },
  context: PluginCallContext,
): Promise<unknown> {
  const frozen = deepFreeze(JSON.parse(JSON.stringify(point.seen)) as Readonly<Record<string, unknown>>);
  const hook = point.phase === 'before' ? interceptor.before : interceptor.after;
  if (hook === undefined) throw new Error(`The interceptor has no ${point.phase} hook.`);
  return hook(frozen, context);
}

function judgeProposal(call: InterceptionCall, seen: PlainData, raw: unknown): InterceptorVerdict<Step> {
  const schema = call.phase === 'before' ? PluginBeforeProposal : PluginAfterProposal;
  if (!isValid(schema, raw)) {
    return {
      kind: 'rejected', reason: 'The interceptor returned an invalid proposal.',
      proposed: [], result: { kind: 'none', status: 'rejected', reason: 'invalid proposal' },
    };
  }
  const verdict = call.judge(seen, raw);
  if (verdict.kind === 'rejected') {
    return {
      kind: 'rejected', reason: verdict.reason, proposed: [recorded(raw)],
      result: { kind: raw.kind, status: 'rejected', reason: verdict.reason },
    };
  }
  return {
    kind: 'accepted', value: { value: verdict.value, shortCircuit: verdict.shortCircuit },
    proposed: [recorded(raw)], result: { kind: raw.kind, status: 'applied' },
  };
}

/**
 * Records what one settled interceptor invocation decided. Returns the accepted value, or null when the invocation
 * failed or its proposal was refused, so the caller keeps its value unchanged.
 */
export function settleInterceptor<T>(
  log: { workspace: string; sessionId: string; directory: string },
  settled: {
    plugin: SelectedPlugin;
    invocationId: string;
    spec: InterceptorInvocation<T>;
    outcome: InterceptorOutcome;
    caller: AgentCaller | null;
    notes: readonly unknown[];
    onError: PluginFailure['onError'];
  },
): T | null {
  const { plugin, invocationId, spec, outcome, caller, notes, onError } = settled;
  const calls = caller?.calls ?? [];
  let failure: Extract<InterceptorOutcome, { kind: 'fail' }>;
  if (outcome.kind === 'ok') {
    const verdict = spec.judge(outcome.value);
    sessionEventLog.record(log.directory, {
      event: 'plugin.decision',
      timestamp: utcNow(),
      data: {
        plugin: plugin.id, invocation_id: invocationId, proposed: verdict.proposed, results: [verdict.result],
        ...(calls.length === 0 ? {} : { agent_calls: calls }),
        ...(notes.length === 0 ? {} : { notes }),
      },
    });
    sessionEventLog.commit(log.workspace, log.directory);
    if (verdict.kind === 'accepted') return verdict.value;
    failure = { kind: 'fail', reason: 'invalid_intent', error: verdict.reason };
  } else if (caller?.unavailable !== null && caller?.unavailable !== undefined && outcome.reason === 'error') {
    failure = { kind: 'fail', reason: 'unavailable', error: caller.unavailable };
  } else failure = outcome;
  recordPluginFailure(log.workspace, log.sessionId, {
    plugin: plugin.id, hook: spec.hook, invocationId, reason: failure.reason, error: failure.error, onError,
    agentCalls: calls, notes,
  });
  return null;
}

/** Records `plugin.hook_invoked` before a plugin runs, so the invocation is visible even if the run ends. */
export function recordHookInvoked(
  log: { workspace: string; directory: string },
  plugin: SelectedPlugin,
  hook: { hook: string; triggerSeq: number | null; invocationId: string },
): void {
  sessionEventLog.record(log.directory, {
    event: 'plugin.hook_invoked',
    timestamp: utcNow(),
    data: {
      plugin: plugin.id, version: plugin.version, hook: hook.hook, trigger_seq: hook.triggerSeq,
      invocation_id: hook.invocationId, advisory: plugin.manifest.advisory,
    },
  });
  sessionEventLog.commit(log.workspace, log.directory);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
