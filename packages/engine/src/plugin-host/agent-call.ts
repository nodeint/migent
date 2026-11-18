import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { PluginAgentResult } from '@nodeint/migent-contracts';
import { writeFileAtomic } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';

import { invokeOnce, type InvokeOnceResult, type ResolvedInvocation } from '../agent-invocation.js';
import type { ChangeApplier, Definition, HandlerResult, Operation } from '../runtime/operation.js';
import { OperationRuntime } from '../runtime/operation-runtime.js';
import type { PlainData } from '../runtime/plain-data.js';
import type { Policy } from '../runtime/policy.js';

/** The one operation a plugin agent call runs as. */
export const INVOKE_AGENT_OPERATION = 'plugin.invoke_agent';

/** The only change a call proposes: store the raw response. The host applier is its single writer. */
interface StoreResponse {
  readonly path: string;
  readonly content: string;
}

/** One call as listed under `agent_calls` in the invocation's terminal event. */
export interface AgentCallRecord {
  readonly index: number;
  readonly client: string;
  readonly model: string;
  readonly duration_ms: number;
  readonly usage: unknown;
  readonly exit_code: number | null;
  readonly classification: string | null;
  readonly outcome: 'succeeded' | 'failed' | 'denied';
  readonly output_path: string | null;
}

interface CallInput {
  readonly [key: string]: PlainData;
  readonly prompt: string;
  readonly timeout_sec: number;
  readonly output_path: string;
}

interface CallOutput {
  readonly [key: string]: PlainData;
  readonly text: string;
  readonly usage: PlainData;
  readonly exit_code: number | null;
  readonly classification: string | null;
  readonly duration_ms: number;
}

/** What the definition ends with: the call's record plus the result the plugin sees. */
interface CallResult {
  readonly outcome: AgentCallRecord['outcome'];
  readonly output: CallOutput | null;
  readonly error: string | null;
}

const DEFINITION: Definition<null, StoreResponse, CallResult> = {
  edges: (['succeeded', 'failed', 'denied'] as const).map((outcome) => ({
    from: INVOKE_AGENT_OPERATION, outcome, to: { kind: 'end' as const },
  })),
  decide: (_state, _request, outcome) => {
    switch (outcome.kind) {
      case 'succeeded':
        return { kind: 'end', changes: outcome.changes, result: { outcome: 'succeeded', output: outcome.output as CallOutput, error: null } };
      case 'failed':
        return { kind: 'end', changes: outcome.changes, result: { outcome: 'failed', output: null, error: outcome.error } };
      default:
        return { kind: 'end', changes: [], result: { outcome: 'denied', output: null, error: outcome.reason } };
    }
  },
};

const toPlain = (value: unknown = null): PlainData => JSON.parse(JSON.stringify(value)) as PlainData;

/** Provider facts of one call. Kept beside the runtime so a failed call still records them. */
interface TurnFacts {
  readonly usage: PlainData;
  readonly exit_code: number | null;
  readonly classification: string | null;
  readonly duration_ms: number;
}

function operationFor(
  resolved: ResolvedInvocation,
  context: { workspace: string; signal: AbortSignal; facts: { value: TurnFacts | null } },
): Operation<CallInput, CallOutput, StoreResponse> {
  return {
    id: INVOKE_AGENT_OPERATION,
    acceptsInput: (input): input is CallInput =>
      isRecord(input) && typeof input.prompt === 'string' && typeof input.timeout_sec === 'number' && typeof input.output_path === 'string',
    producesOutput: (output): output is CallOutput => isRecord(output) && typeof output.text === 'string',
    async handle(input): Promise<HandlerResult<CallOutput, StoreResponse>> {
      const started = Date.now();
      // The signal reaches the kernel through the construction of this handler, never through the request.
      const result: InvokeOnceResult = await invokeOnce(resolved, input.prompt, {
        workspace: context.workspace, timeoutSec: input.timeout_sec, signal: context.signal,
      });
      const changes = [{ path: input.output_path, content: result.responseText }];
      const facts: TurnFacts = {
        usage: toPlain(result.usage),
        exit_code: result.exitCode,
        classification: result.classification?.kind ?? null,
        duration_ms: Date.now() - started,
      };
      context.facts.value = facts;
      if (result.invokeError !== null) return { kind: 'failed', error: result.invokeError, changes };
      const output: CallOutput = { text: result.responseText, ...facts };
      return { kind: 'succeeded', changes, output };
    },
  };
}

export interface AgentCallerOptions {
  readonly workspace: string;
  readonly sessionId: string;
  readonly sessionDirectory: string;
  readonly pluginId: string;
  readonly invocationId: string;
  /** Calls an earlier attempt of this invocation already issued, so a retry never reuses an index or file. */
  readonly firstIndex?: number;
  readonly stageId: string;
  /** Binds the agent target. Called for every call, so an advisory plugin resolves its live target at the call. */
  readonly bind: () => ResolvedInvocation;
  /** The invocation's `Date.now()` deadline in milliseconds. */
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  /** Builds the provider prompt from the plugin's text. */
  readonly frame?: (text: string) => string;
  readonly policy?: Policy;
}

const MS_PER_SECOND = 1000;
const NOT_STARTED_ENDED = 'The invocation ended; the agent call was not started.';
const NOT_STARTED_NO_TIME = 'No time is left in the invocation; the agent call was not started.';

/**
 * The `invokeAgent` capability of one invocation. Every call runs as `plugin.invoke_agent` on an
 * `OperationRuntime`. After `close` a call fails at once and starts no process.
 */
export class AgentCaller {
  private readonly recorded: AgentCallRecord[] = [];
  /** Set when the target could not be bound: the invocation is an `unavailable` failure. */
  public unavailable: string | null = null;
  private readonly inflight = new Set<Promise<unknown>>();
  private closed = false;
  private rejection: { readonly error: unknown } | null = null;
  private reserved: number;

  constructor(private readonly options: AgentCallerOptions) {
    this.reserved = options.firstIndex ?? 0;
  }

  /** The highest call index issued so far, counting earlier attempts. */
  public get issued(): number {
    return this.reserved;
  }

  /** The capability handed to the plugin. It only ever returns `{ text, error }`. */
  public readonly invokeAgent = (prompt: string): Promise<PluginAgentResult> => {
    // The identity is reserved before any asynchronous work, so overlapping calls never share an index or file.
    this.reserved += 1;
    const pending = this.run(prompt, this.reserved);
    this.inflight.add(pending);
    const forget = (): void => { this.inflight.delete(pending); };
    void pending.then(forget, forget);
    return pending;
  };

  /** The first runtime failure of any call, kept even after the call has left `inflight`. */
  public get failure(): { readonly error: unknown } | null {
    return this.rejection;
  }

  /** The calls made so far, in call order. */
  public get calls(): readonly AgentCallRecord[] {
    return [...this.recorded].sort((a, b) => a.index - b.index);
  }

  /** Later calls fail at once and start no process. Returns the calls still running. */
  public close(): readonly Promise<unknown>[] {
    this.closed = true;
    return [...this.inflight];
  }

  private bound(): ResolvedInvocation {
    try {
      return this.options.bind();
    } catch (caught) {
      this.unavailable = caught instanceof Error ? caught.message : String(caught);
      // Kept like any runtime failure, so a call the plugin never awaited still fails the invocation.
      this.rejection ??= { error: caught };
      throw caught;
    }
  }

  private async run(prompt: string, index: number): Promise<PluginAgentResult> {
    const { options } = this;
    if (this.closed || options.signal.aborted) return { text: null, error: NOT_STARTED_ENDED };
    const remainingMs = options.deadlineAt - Date.now();
    if (remainingMs <= 0) return { text: null, error: NOT_STARTED_NO_TIME };
    const resolved = this.bound();
    const outputPath = path.posix.join('plugins', options.pluginId, 'calls', `${options.invocationId}-${index}.txt`);
    const applier: ChangeApplier<StoreResponse> = {
      apply: (changes) => {
        for (const change of changes) {
          const target = path.join(options.sessionDirectory, change.path);
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileAtomic(target, change.content);
        }
      },
    };
    const facts: { value: TurnFacts | null } = { value: null };
    const runtime = new OperationRuntime<StoreResponse>({
      operations: [operationFor(resolved, { workspace: options.workspace, signal: options.signal, facts }) as never],
      applier,
      ...(options.policy === undefined ? {} : { policy: options.policy }),
    });
    const started = Date.now();
    const record = (result: CallResult): AgentCallRecord => ({
      index, client: resolved.clientId, model: resolved.model,
      duration_ms: facts.value?.duration_ms ?? Date.now() - started,
      usage: facts.value?.usage ?? null,
      exit_code: facts.value?.exit_code ?? null,
      classification: facts.value?.classification ?? null,
      outcome: result.outcome,
      output_path: result.outcome === 'denied' ? null : outputPath,
    });
    try {
      const result = await runtime.run({
        scope: { sessionId: options.sessionId, stageId: options.stageId, role: `plugin:${options.pluginId}` },
        definition: DEFINITION,
        state: null,
        request: {
          identity: { executionId: options.invocationId, operationId: INVOKE_AGENT_OPERATION, attempt: index },
          input: {
            prompt: options.frame?.(prompt) ?? prompt,
            timeout_sec: remainingMs / MS_PER_SECOND,
            output_path: outputPath,
          },
        },
      });
      this.recorded.push(record(result));
      return { text: result.output?.text ?? null, error: result.error };
    } catch (caught) {
      // A cancellation propagates out of the runtime; the call is recorded as failed and the host records `cancelled`.
      this.recorded.push(record({ outcome: 'failed', output: null, error: null }));
      this.rejection ??= { error: caught };
      throw caught;
    }
  }
}
