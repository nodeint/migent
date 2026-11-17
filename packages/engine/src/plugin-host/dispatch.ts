import { createHash,randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  isValid,
  PLUGIN_DEFAULT_ON_ERROR,
  PLUGIN_DEFAULT_TIMEOUT_SEC,
  PLUGIN_HOOKS,
  type PluginCapabilities,
  type PluginHook,
  type PluginHookInput,
  PluginIntent,
  type PluginOnError,
  type PluginRegistry,
} from '@nodeint/migent-contracts';
import type { ClientRegistry, StageTarget } from '@nodeint/migent-kernel';
import { CancellationRequested, cancellationSignal, loadWorkspaceConfig, logProgress, resolvePluginTarget, utcNow, writeFileAtomic } from '@nodeint/migent-kernel';
import { readParsedEvents, sessionEventLog, SessionStore, subscribeSessionEvents } from '@nodeint/migent-session';
import { isRecord } from '@nodeint/migent-workflow';

import { bindTarget } from '../agent-invocation.js';
import { AgentCaller } from './agent-call.js';
import { declaresAgent } from './freeze.js';
import { type PluginFailure, recordPluginFailure } from './holds.js';
import type { PluginSelection, SelectedPlugin } from './selection.js';

const [HOOK_STARTED, HOOK_FINISHED, HOOK_STOPPED] = PLUGIN_HOOKS;

/** One event the host maps to a hook. */
interface Trigger {
  readonly hook: PluginHook;
  readonly seq: number | null;
  readonly record: Readonly<Record<string, unknown>> | null;
}

/** `execution.<status>` events that finish an execution. */
const TERMINAL_EXECUTION_EVENTS: ReadonlySet<string> = new Set([
  'execution.completed',
  'execution.failed',
  'execution.cancelled',
  'execution.skipped',
]);

/** A safe output file name: one path segment, no separators, no leading dot, no `..`. */
const SAFE_OUTPUT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export function isSafeOutputName(name: string): boolean {
  return SAFE_OUTPUT_NAME.test(name) && !name.includes('..');
}

type Outcome =
  | { readonly kind: 'ok'; readonly intents: unknown }
  | { readonly kind: 'fail'; readonly reason: PluginFailure['reason']; readonly error: string };

/** The `on_error` applied to a plugin: config, manifest default, core default. Advisory is always `ignore`. */
export function resolveOnError(plugin: SelectedPlugin): PluginOnError {
  if (plugin.manifest.advisory) return 'ignore';
  const configured = plugin.config.on_error;
  if (configured === 'ignore' || configured === 'stop' || configured === 'fail') return configured;
  return plugin.manifest.defaults?.on_error ?? PLUGIN_DEFAULT_ON_ERROR;
}

/** The invocation deadline in seconds: config, then manifest default, then core default. */
export function resolveTimeoutSec(plugin: SelectedPlugin): number {
  const configured = plugin.config.timeout_sec;
  if (typeof configured === 'number' && configured > 0) return configured;
  return plugin.manifest.defaults?.timeout_sec ?? PLUGIN_DEFAULT_TIMEOUT_SEC;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A detached, deeply frozen copy of plain data. */
function frozenCopy<T>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T);
}

const MS_PER_SECOND = 1000;

/** The provider prompt: the plugin's text, then its configured `responsibilities` and `description`. */
function promptFor(config: Record<string, unknown>, text: string): string {
  const parts = [text];
  if (typeof config.description === 'string') parts.push(`Description: ${config.description}`);
  if (Array.isArray(config.responsibilities) && config.responsibilities.length > 0) {
    parts.push(['Responsibilities:', ...config.responsibilities.map((item) => `- ${String(item)}`)].join('\n'));
  }
  return parts.join('\n\n');
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Runs plugin hooks for one session run. The core owns every effect: a handler only receives detached frozen
 * data and returns intents, which the host validates and applies under the session lock.
 *
 * Invocations run in trigger order, concurrently with scheduling. `drain` settles every pending invocation
 * before the lock is released, and never waits past an invocation's deadline.
 */
export class PluginHost {
  private readonly directory: string;
  private readonly store: SessionStore;
  private readonly registry: PluginRegistry;
  private readonly clients: ClientRegistry | null;
  private readonly plugins: readonly SelectedPlugin[];
  private unavailable: PluginSelection['unavailable'][number][];
  private chain: Promise<void> = Promise.resolve();
  private readonly errors: unknown[] = [];
  private readonly aborters = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private offCancel: (() => void) | null = null;
  private cancelled = false;
  private didWork = false;
  private stopQueued = false;

  private readonly workspace: string;
  private readonly sessionId: string;

  constructor(
    session: { readonly workspace: string; readonly sessionId: string },
    selection: PluginSelection,
    services: { readonly plugins: PluginRegistry; readonly clients: ClientRegistry | null },
  ) {
    this.registry = services.plugins;
    this.clients = services.clients;
    const { workspace, sessionId } = session;
    this.workspace = workspace;
    this.sessionId = sessionId;
    this.directory = path.join(workspace, '.migent', 'sessions', sessionId);
    this.store = new SessionStore(workspace);
    this.plugins = selection.selected;
    this.unavailable = [...selection.unavailable];
  }

  /** Whether any entry can run or report. An inert host subscribes to nothing. */
  public get active(): boolean {
    return this.plugins.length > 0 || this.unavailable.length > 0;
  }

  /** Subscribes to the event log and to cancellation for the run. */
  public start(): void {
    if (!this.active || this.unsubscribe !== null) return;
    this.unsubscribe = subscribeSessionEvents((id, record) => {
      if (id === this.sessionId) this.onRecord(record);
    });
    this.offCancel = cancellationSignal().onCancel(() => {
      this.cancelled = true;
      for (const abort of [...this.aborters]) abort();
    });
  }

  /** Fires `session.started` for a session this run created or activated. */
  public fireSessionStarted(): void {
    if (this.unsubscribe === null) return;
    const events = readParsedEvents(path.join(this.directory, 'events.jsonl'));
    const last = events.filter((event) => event.event === 'session.created' || event.event === 'session.activated').at(-1);
    this.enqueue({ hook: HOOK_STARTED, seq: last?.seq ?? null, record: last === undefined ? null : last.raw });
  }

  /**
   * Fires `session.stopped` when the run did new work, then drains. Cancellation does not change eligibility: a
   * cancelled run that did work still fires it, and the invocation settles as `cancelled`.
   */
  public async finish(options: { fireStopped: boolean }): Promise<void> {
    if (this.unsubscribe !== null && options.fireStopped && this.didWork && !this.stopQueued) {
      this.stopQueued = true;
      this.enqueue({ hook: HOOK_STOPPED, seq: null, record: null });
    }
    await this.drain();
  }

  /** Settles every pending invocation, then stops listening. Rethrows the first host (not plugin) error. */
  public async drain(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.chain;
      await seen;
    } while (seen !== this.chain);
    const [error] = this.errors.splice(0);
    if (error !== undefined) throw error;
  }

  /** Drains, then removes the subscriptions. */
  public async close(): Promise<void> {
    try {
      await this.drain();
    } finally {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.offCancel?.();
      this.offCancel = null;
    }
  }

  // The listener is synchronous and never writes: it only queues.
  private onRecord(record: Readonly<Record<string, unknown>>): void {
    const name = typeof record.event === 'string' ? record.event : '';
    if (name === 'execution.started') this.didWork = true;
    if (!TERMINAL_EXECUTION_EVENTS.has(name)) return;
    this.didWork = true;
    const seq = typeof record.seq === 'number' ? record.seq : null;
    this.enqueue({ hook: HOOK_FINISHED, seq, record });
  }

  private enqueue(trigger: Trigger): void {
    this.chain = this.chain.then(() => this.runTrigger(trigger)).catch((error: unknown) => {
      this.errors.push(error);
    });
  }

  private async runTrigger(trigger: Trigger): Promise<void> {
    this.reportUnavailable(trigger.hook);
    for (const plugin of this.plugins) {
      if (!plugin.manifest.hooks.includes(trigger.hook)) continue;
      const handler = this.registry.get(plugin.id)?.handlers[trigger.hook];
      if (handler === undefined) continue;
      await this.invoke(plugin, trigger);
    }
  }

  /** An entry that cannot run records one `unavailable` failure at its first trigger. */
  private reportUnavailable(hook: PluginHook): void {
    const remaining: typeof this.unavailable = [];
    for (const entry of this.unavailable) {
      const manifest = this.registry.get(entry.id)?.manifest;
      if (manifest !== undefined && !manifest.hooks.includes(hook)) {
        remaining.push(entry);
        continue;
      }
      recordPluginFailure(this.workspace, this.sessionId, {
        plugin: entry.id, hook, invocationId: null, reason: 'unavailable', error: entry.error, onError: 'ignore',
      });
    }
    this.unavailable = remaining;
  }

  private async invoke(plugin: SelectedPlugin, trigger: Trigger): Promise<void> {
    const { hook } = trigger;
    const handler = this.registry.get(plugin.id)?.handlers[hook];
    if (handler === undefined) return;
    const invocationId = randomUUID();
    const onError = resolveOnError(plugin);
    sessionEventLog.record(this.directory, {
      event: 'plugin.hook_invoked',
      timestamp: utcNow(),
      data: {
        plugin: plugin.id, version: plugin.version, hook, trigger_seq: trigger.seq,
        invocation_id: invocationId, advisory: plugin.manifest.advisory,
      },
    });
    sessionEventLog.commit(this.workspace, this.directory);
    const timeoutSec = resolveTimeoutSec(plugin);
    const controller = new AbortController();
    const caller = this.callerFor(plugin, { invocationId, trigger, timeoutSec, signal: controller.signal });
    const outcome = await this.call(handler, this.inputFor(plugin, trigger), {
      timeoutSec, controller, caller,
    });
    const calls = caller?.calls ?? [];
    let failure: Extract<Outcome, { kind: 'fail' }> | null;
    if (outcome.kind === 'ok') failure = this.apply(plugin, invocationId, { raw: outcome.intents, calls });
    else if (caller?.unavailable !== null && caller?.unavailable !== undefined && outcome.reason === 'error') {
      failure = { kind: 'fail', reason: 'unavailable', error: caller.unavailable };
    } else failure = outcome;
    if (failure === null) return;
    recordPluginFailure(this.workspace, this.sessionId, {
      plugin: plugin.id, hook, invocationId, reason: failure.reason, error: failure.error, onError, agentCalls: calls,
    });
  }

  /** The `invokeAgent` capability: offered only when the manifest declares it and the config has an `agent`. */
  private callerFor(
    plugin: SelectedPlugin,
    context: { invocationId: string; trigger: Trigger; timeoutSec: number; signal: AbortSignal },
  ): AgentCaller | null {
    const { clients } = this;
    if (clients === null || !declaresAgent(plugin.manifest) || plugin.config.agent === undefined) return null;
    const target = this.targetOf(plugin, clients);
    const stageId = typeof context.trigger.record?.stage_id === 'string' ? context.trigger.record.stage_id : '';
    return new AgentCaller({
      workspace: this.workspace,
      sessionId: this.sessionId,
      sessionDirectory: this.directory,
      pluginId: plugin.id,
      invocationId: context.invocationId,
      stageId,
      bind: () => bindTarget(target(), clients),
      deadlineAt: Date.now() + context.timeoutSec * MS_PER_SECOND,
      signal: context.signal,
      frame: (text) => promptFor(plugin.config, text),
    });
  }

  /** A non-advisory plugin binds its frozen target; an advisory one resolves the live target at the call. */
  private targetOf(plugin: SelectedPlugin, clients: ClientRegistry): () => StageTarget {
    if (plugin.source === 'frozen') {
      return () => {
        if (plugin.target === null) throw new Error(`Plugin "${plugin.id}" has no frozen agent target.`);
        return plugin.target as unknown as StageTarget;
      };
    }
    const entry = { id: plugin.id, entry: plugin.config };
    return () => resolvePluginTarget(loadWorkspaceConfig(this.workspace), entry, clients);
  }

  /** Runs the handler under its deadline. A timeout or cancellation wins the race; later intents are discarded. */
  private call(
    handler: (input: PluginHookInput, capabilities: PluginCapabilities) => Promise<readonly unknown[]>,
    input: PluginHookInput,
    context: { timeoutSec: number; controller: AbortController; caller: AgentCaller | null },
  ): Promise<Outcome> {
    const { timeoutSec, controller, caller } = context;
    return new Promise<Outcome>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      let settled = false;
      // First settle wins. A timeout or cancellation aborts the provider; the host waits for every started call to
      // stop and closes the capability before it reports. Later intents are discarded.
      const drain = async (outcome: Outcome): Promise<Outcome> => {
        if (caller === null) return outcome;
        await Promise.allSettled(caller.close());
        const { failure } = caller;
        if (outcome.kind === 'ok' && failure !== null) {
          return failure.error instanceof CancellationRequested
            ? { kind: 'fail', reason: 'cancelled', error: 'The run was cancelled.' }
            : { kind: 'fail', reason: 'error', error: messageOf(failure.error) };
        }
        return outcome;
      };
      const settle = (outcome: Outcome): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        this.aborters.delete(cancel);
        if (outcome.kind === 'fail') controller.abort();
        void drain(outcome).then(resolve);
      };
      // The handler returning is not the end: calls it started stay under the deadline and cancellation until they
      // have stopped, then the intents are accepted.
      const handlerDone = (outcome: Outcome): void => {
        if (settled) return;
        // A failure aborts the running calls at once; only a success waits for them.
        if (caller === null || outcome.kind === 'fail') {
          settle(outcome);
          return;
        }
        void drain(outcome).then((final) => settle(final));
      };
      const cancel = (): void => settle({ kind: 'fail', reason: 'cancelled', error: 'The run was cancelled.' });
      if (this.cancelled) {
        cancel();
        return;
      }
      this.aborters.add(cancel);
      timer = setTimeout(() => {
        settle({ kind: 'fail', reason: 'timeout', error: `The hook did not finish within ${timeoutSec}s.` });
      }, timeoutSec * MS_PER_SECOND);
      // After a timeout or cancellation the handler promise is orphaned: settle() is a no-op for the promise, so
      // its late intents are discarded and its rejection is swallowed here.
      Promise.resolve()
        .then(() => handler(input, Object.freeze(caller === null ? {} : { invokeAgent: caller.invokeAgent })))
        .then(
          (intents) => handlerDone({ kind: 'ok', intents }),
          (error: unknown) => handlerDone(error instanceof CancellationRequested
            ? { kind: 'fail', reason: 'cancelled', error: 'The run was cancelled.' }
            : { kind: 'fail', reason: 'error', error: messageOf(error) }),
        );
    });
  }

  private inputFor(plugin: SelectedPlugin, trigger: Trigger): PluginHookInput {
    const status = this.store.readSessionStatus(this.sessionId);
    const base = {
      hook: trigger.hook,
      plugin: { id: plugin.id, version: plugin.version, config: plugin.config },
      session: {
        id: this.sessionId,
        workflow_id: typeof status.workflow_id === 'string' ? status.workflow_id : null,
        task_summary: typeof status.title === 'string' ? status.title : null,
        status,
        trigger: trigger.record ?? {},
      },
    };
    const executionId = typeof trigger.record?.execution_id === 'string' ? trigger.record.execution_id : null;
    if (trigger.hook !== HOOK_FINISHED || executionId === null) return frozenCopy(base as PluginHookInput);
    const snapshot = this.store.executionSnapshots(this.sessionId).find((item) => item.executionId === executionId);
    const artifacts = snapshot !== undefined && existsSync(snapshot.artifactDirectory)
      ? readdirSync(snapshot.artifactDirectory).sort()
      : [];
    const stageId = typeof trigger.record?.stage_id === 'string' ? trigger.record.stage_id : null;
    const outcome = snapshot === undefined
      ? null
      : { status: snapshot.outcomeStatus, decision: snapshot.outcomeDecision, execution_status: snapshot.status };
    const execution = { id: executionId, stage_id: stageId, outcome, artifacts };
    return frozenCopy({ ...base, execution } as PluginHookInput);
  }

  /**
   * Writes the `output` intents under `plugins/<id>/`. A filesystem failure is a plugin failure, not a host failure,
   * so it goes through the failure policy and the next plugin still runs. Only session-log errors propagate.
   */
  private writeOutputs(
    plugin: SelectedPlugin,
    intents: readonly PluginIntent[],
  ): { results: Record<string, unknown>[] } | { error: string } {
    const results: Record<string, unknown>[] = [];
    for (const intent of intents) {
      if (intent.kind !== 'output') {
        results.push({ kind: intent.kind, status: 'applied' });
        continue;
      }
      const relative = path.posix.join('plugins', plugin.id, intent.name);
      try {
        mkdirSync(path.join(this.directory, 'plugins', plugin.id), { recursive: true });
        writeFileAtomic(path.join(this.directory, relative), intent.content);
      } catch (caught) {
        return { error: `Could not write ${relative}: ${messageOf(caught)}` };
      }
      results.push({
        kind: 'output', status: 'applied', path: relative,
        sha256: createHash('sha256').update(intent.content).digest('hex'),
      });
    }
    return { results };
  }

  /**
   * Validates every intent, then applies them. Nothing is written when any intent is invalid or rejected. Returns
   * the failure, or null once `plugin.decision` is recorded.
   */
  private apply(
    plugin: SelectedPlugin,
    invocationId: string,
    proposal: { raw: unknown; calls: readonly unknown[] },
  ): Extract<Outcome, { kind: 'fail' }> | null {
    const invalid = (error: string): Extract<Outcome, { kind: 'fail' }> =>
      ({ kind: 'fail', reason: 'invalid_intent', error });
    const { raw, calls } = proposal;
    if (!Array.isArray(raw)) return invalid('The hook must return an array of intents.');
    const intents: PluginIntent[] = [];
    for (const [index, item] of raw.entries()) {
      if (!isValid(PluginIntent, item)) return invalid(`Intent ${index} is not a valid plugin intent.`);
      if (item.kind === 'output' && !isSafeOutputName(item.name)) {
        return invalid(`Intent ${index} has an unsafe output name: ${JSON.stringify(item.name)}.`);
      }
      intents.push(item);
    }
    const written = this.writeOutputs(plugin, intents);
    if ('error' in written) return { kind: 'fail', reason: 'error', error: written.error };
    const { results } = written;
    sessionEventLog.record(this.directory, {
      event: 'plugin.decision',
      timestamp: utcNow(),
      data: {
        plugin: plugin.id,
        invocation_id: invocationId,
        proposed: intents.map((intent) => (isRecord(intent) && intent.kind === 'output'
          ? { kind: intent.kind, name: intent.name, media_type: intent.media_type }
          : { ...intent })),
        results,
        ...(calls.length === 0 ? {} : { agent_calls: calls }),
      },
    });
    sessionEventLog.commit(this.workspace, this.directory);
    return null;
  }
}

/** Logs a plugin host problem that must not fail the run. */
export function logHostProblem(error: unknown): void {
  logProgress(`migent: plugin host: ${messageOf(error)}`);
}
