import type { CliClient, ClientRegistry, StageTarget } from '@nodeint/migent-kernel';
import {
  CommandExecutor,
  DEFAULT_INTERRUPT_POLICY,
  DEFAULT_TIMEOUT_SEC,
  loadAgentTarget,
  sessionOptions,
} from '@nodeint/migent-kernel';
import type { ExecutionContext, SessionStore } from '@nodeint/migent-session';

import { ProviderEventReporter } from './provider-events.js';
import { resolveWorkspace } from './run-setup.js';
import { runProviderTurn, type TurnEvents } from './turn-process.js';
import type { TurnResult } from './turn-types.js';

/** A target bound to its client adapter, with validated options and the session profile. */
export interface ResolvedInvocation {
  readonly client: CliClient;
  readonly clientId: string;
  readonly model: string;
  readonly resolvedOptions: Record<string, string>;
  readonly profile: Record<string, string>;
}

/**
 * Live resolution only: new sessions, `migent agent`, and later plugins. Reads the agent from the given
 * config and folds `effort` into the client's native option. A resume never calls this; it holds a persisted
 * `StageTarget` and goes straight to `bindTarget`.
 */
export function targetFromAgent(
  config: Record<string, unknown>,
  agentRef: string,
  registry: ClientRegistry,
): StageTarget {
  return loadAgentTarget(config, agentRef, { registry });
}

/** Binds a target to its client and validates its options. Shared by the stage runner and `invokeOnce`. */
export function bindTarget(target: StageTarget, registry: ClientRegistry): ResolvedInvocation {
  const resolvedOptions = { ...target.options };
  const client = registry.get(target.client);
  client.validateOptions(resolvedOptions);
  return {
    client,
    clientId: target.client,
    model: target.model,
    resolvedOptions,
    profile: sessionOptions(client, resolvedOptions),
  };
}

export interface InvokeOnceOptions {
  readonly workspace: string;
  readonly cwd?: string;
  readonly timeoutSec?: number | null;
  /** When given, provider events are recorded in this execution through the session event log. */
  readonly recordTo?: { readonly store: SessionStore; readonly context: ExecutionContext };
}

export interface InvokeOnceResult {
  readonly responseText: string;
  readonly usage: TurnResult['usage'];
  readonly invokeError: string | null;
  readonly classification: TurnResult['classification'];
  readonly exitCode: number | null;
}

/**
 * One provider turn with no conversation history, resume, verify, or response protocol. It has no production
 * caller yet; tests exercise it with the fake clients.
 */
export async function invokeOnce(
  resolved: ResolvedInvocation,
  prompt: string,
  options: InvokeOnceOptions,
): Promise<InvokeOnceResult> {
  const { workspace, recordTo } = options;
  const cwd = resolveWorkspace(options.cwd ?? workspace);
  const events: TurnEvents = recordTo
    ? new ProviderEventReporter(recordTo, { client: resolved.clientId, model: resolved.model })
    : { emit: () => undefined };
  const executor = new CommandExecutor(options.timeoutSec === undefined ? DEFAULT_TIMEOUT_SEC : options.timeoutSec);
  const result = await runProviderTurn(
    { executor, interruptPolicy: DEFAULT_INTERRUPT_POLICY },
    {
      client: resolved.client,
      model: resolved.model,
      workspace: cwd,
      prompt,
      agentId: null,
      newSession: null,
      options: resolved.resolvedOptions,
      events,
      onDebug: null,
      onStart: (info) => recordTo?.store.saveProcessMetadata(recordTo.context, info),
    },
  );
  return {
    responseText: result.responseText,
    usage: result.usage,
    invokeError: result.invokeError,
    classification: result.classification,
    exitCode: result.exitCode,
  };
}
