import { createHash,randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  isValid,
  PLUGIN_ACTIVATE_HOOK,
  PLUGIN_DEFAULT_ON_ERROR,
  PLUGIN_DEFAULT_TIMEOUT_SEC,
  PLUGIN_HOOKS,
  PluginEventProposal,
  type PluginHandler,
  type PluginHook,
  type PluginHookInput,
  type PluginOnError,
  type PluginRegistry,
} from '@nodeint/migent-contracts';
import type { ClientRegistry, StageTarget } from '@nodeint/migent-kernel';
import { CancellationRequested, cancellationSignal, loadWorkspaceConfig, logProgress, resolvePluginTarget, utcNow, writeFileAtomic } from '@nodeint/migent-kernel';
import { assertSessionLockHeld, readParsedEvents, sessionEventLog, SessionStore, subscribeSessionEvents } from '@nodeint/migent-session';

import { bindTarget } from '../agent-invocation.js';
import type { InterceptorChain } from '../runtime/interception.js';
import { AgentCaller } from './agent-call.js';
import { buildActivationContext, buildCallContext, emptyRegistrations, type PluginRegistrations } from './context.js';
import { declaresAgent } from './freeze.js';
import { type PluginFailure, recordPluginFailure } from './holds.js';
import { HostInterceptorChain, type InterceptorInvocation, recordHookInvoked, settleInterceptor } from './interception.js';
import { InvocationState } from './invocation.js';
import type { PluginSelection, SelectedPlugin } from './selection.js';

const [HOOK_STARTED, HOOK_FINISHED, HOOK_STOPPED, HOOK_COMPLETED] = PLUGIN_HOOKS;

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
  | { readonly kind: 'ok'; readonly value: unknown }
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
  /** What each plugin registered at activation; `null` when activation failed. Frozen once set. */
  private readonly activations = new Map<string, PluginRegistrations | null>();

  private readonly workspace: string;
  private readonly log: { workspace: string; sessionId: string; directory: string };
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
    this.log = { workspace, sessionId, directory: this.directory };
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
    this.chain = this.chain.then(() => this.activateAll()).catch((error: unknown) => {
      this.errors.push(error);
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
    if (name === 'session.completed') {
      const completedSeq = typeof record.seq === 'number' ? record.seq : null;
      this.enqueue({ hook: HOOK_COMPLETED, seq: completedSeq, record });
      return;
    }
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
      for (const handler of this.activations.get(plugin.id)?.events.get(trigger.hook) ?? []) {
        await this.invoke(plugin, trigger, handler);
      }
    }
  }

  /** Settles once every selected plugin has been activated. Interceptors exist only after this. */
  public async ready(): Promise<void> {
    if (this.unsubscribe !== null) await this.chain;
  }

  /** The interceptors the activated plugins registered, in chain order. Independent of any other run. */
  public interceptors(): InterceptorChain {
    return new HostInterceptorChain(
      this.plugins.map((plugin) => ({ plugin, registrations: this.activations.get(plugin.id)?.interceptors ?? [] })),
      this,
    );
  }

  /**
   * Runs one interceptor under the plugin's deadline and records the result. Returns the accepted value, or null
   * when the invocation failed or its proposal was refused; the caller then keeps the value unchanged. A failure is
   * recorded under `on_error`, so `stop` and `fail` create the plugin hold and no new exit point is added.
   */
  public async invokeInterceptor<T>(plugin: SelectedPlugin, spec: InterceptorInvocation<T>): Promise<T | null> {
    const invocationId = randomUUID();
    recordHookInvoked(this.log, plugin, { hook: spec.hook, triggerSeq: null, invocationId });
    const timeoutSec = resolveTimeoutSec(plugin);
    const controller = new AbortController();
    const invocation = new InvocationState();
    const { stageId } = spec;
    const caller = this.callerFor(plugin, { invocationId, stageId, timeoutSec, signal: controller.signal });
    const outcome = await this.call(
      () => spec.run(buildCallContext(this.sourcesOf(plugin), invocation, caller)),
      { timeoutSec, controller, caller, invocation },
    );
    return settleInterceptor(
      this.log,
      { plugin, invocationId, spec, outcome, caller, notes: invocation.notes, onError: resolveOnError(plugin) },
    );
  }

  /** Activates every selected plugin once, in selection order. A failure leaves that plugin out of the scope. */
  private async activateAll(): Promise<void> {
    for (const plugin of this.plugins) await this.activate(plugin);
  }

  private async activate(plugin: SelectedPlugin): Promise<void> {
    const definition = this.registry.get(plugin.id);
    if (definition === undefined) {
      this.activations.set(plugin.id, null);
      return;
    }
    const invocationId = randomUUID();
    const invocation = new InvocationState();
    const registrations = emptyRegistrations();
    const { context, violation } = buildActivationContext(this.sourcesOf(plugin), invocation, registrations);
    const timeoutSec = resolveTimeoutSec(plugin);
    const outcome = await this.call(
      async () => { await definition.activate(frozenCopy(plugin.config), context); },
      { timeoutSec, controller: new AbortController(), caller: null, invocation },
    );
    const refused = violation();
    const refusal: Extract<Outcome, { kind: 'fail' }> | null =
      refused === null ? null : { kind: 'fail', reason: 'error', error: refused };
    const failure = outcome.kind === 'fail' ? outcome : refusal;
    if (failure === null) {
      this.activations.set(plugin.id, Object.freeze(registrations));
      this.recordActivationNotes(plugin, invocationId, invocation.notes);
      return;
    }
    this.activations.set(plugin.id, null);
    recordPluginFailure(this.workspace, this.sessionId, {
      plugin: plugin.id, hook: PLUGIN_ACTIVATE_HOOK, invocationId, reason: failure.reason, error: failure.error,
      onError: resolveOnError(plugin), notes: invocation.notes,
    });
  }

  /** Notes logged by a successful activation belong to that activation: one empty decision carries them. */
  private recordActivationNotes(plugin: SelectedPlugin, invocationId: string, notes: readonly unknown[]): void {
    if (notes.length === 0) return;
    sessionEventLog.record(this.directory, {
      event: 'plugin.decision',
      timestamp: utcNow(),
      data: { plugin: plugin.id, invocation_id: invocationId, proposed: [], results: [], notes },
    });
    sessionEventLog.commit(this.workspace, this.directory);
  }

  private sourcesOf(plugin: SelectedPlugin) {
    return {
      manifest: plugin.manifest,
      options: plugin.config,
      readCore: (key: string): unknown => loadWorkspaceConfig(this.workspace)[key],
    };
  }

  /** An entry that cannot run records one `unavailable` failure at its first trigger. */
  private reportUnavailable(hook: PluginHook): void {
    const remaining: typeof this.unavailable = [];
    for (const entry of this.unavailable) {
      const manifest = this.registry.get(entry.id)?.manifest;
      if (manifest !== undefined && !manifest.uses.events.includes(hook)) {
        remaining.push(entry);
        continue;
      }
      recordPluginFailure(this.workspace, this.sessionId, {
        plugin: entry.id, hook, invocationId: null, reason: 'unavailable', error: entry.error, onError: 'ignore',
      });
    }
    this.unavailable = remaining;
  }

  private async invoke(plugin: SelectedPlugin, trigger: Trigger, handler: PluginHandler): Promise<void> {
    const { hook } = trigger;
    const invocationId = randomUUID();
    const onError = resolveOnError(plugin);
    recordHookInvoked(this.log, plugin, { hook, triggerSeq: trigger.seq, invocationId });
    const timeoutSec = resolveTimeoutSec(plugin);
    const controller = new AbortController();
    const invocation = new InvocationState();
    const stageId = typeof trigger.record?.stage_id === 'string' ? trigger.record.stage_id : '';
    const caller = this.callerFor(plugin, { invocationId, stageId, timeoutSec, signal: controller.signal });
    const input = this.inputFor(plugin, trigger);
    const callContext = buildCallContext(this.sourcesOf(plugin), invocation, caller);
    const outcome = await this.call(
      () => handler(input, callContext),
      { timeoutSec, controller, caller, invocation },
    );
    const calls = caller?.calls ?? [];
    const {notes} = invocation;
    let failure: Extract<Outcome, { kind: 'fail' }> | null;
    if (outcome.kind === 'ok') failure = this.apply(plugin, invocationId, { raw: outcome.value, calls, notes });
    else if (caller?.unavailable !== null && caller?.unavailable !== undefined && outcome.reason === 'error') {
      failure = { kind: 'fail', reason: 'unavailable', error: caller.unavailable };
    } else failure = outcome;
    if (failure === null) return;
    recordPluginFailure(this.workspace, this.sessionId, {
      plugin: plugin.id, hook, invocationId, reason: failure.reason, error: failure.error, onError,
      agentCalls: calls, notes,
    });
  }

  /** The `invokeAgent` capability: offered only when the manifest declares it and the config has an `agent`. */
  private callerFor(
    plugin: SelectedPlugin,
    context: { invocationId: string; stageId: string; timeoutSec: number; signal: AbortSignal },
  ): AgentCaller | null {
    const { clients } = this;
    if (clients === null || !declaresAgent(plugin.manifest) || plugin.config.agent === undefined) return null;
    const target = this.targetOf(plugin, clients);
    const { stageId } = context;
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

  /**
   * The settle-once invoker shared by activation and event handlers. Runs `run` under its deadline. A timeout or
   * cancellation wins the race; settling closes the invocation's context, and later results are discarded.
   */
  private call(
    run: () => Promise<unknown>,
    context: {
      timeoutSec: number; controller: AbortController; caller: AgentCaller | null; invocation: InvocationState;
    },
  ): Promise<Outcome> {
    const { timeoutSec, controller, caller, invocation } = context;
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
        invocation.close();
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
        .then(run)
        .then(
          (value) => handlerDone({ kind: 'ok', value }),
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
   * Writes the artifact proposal under `plugins/<id>/`. A filesystem failure is a plugin failure, not a host
   * failure, so it goes through the failure policy and the next plugin still runs. Only session-log errors propagate.
   */
  private writeArtifact(
    plugin: SelectedPlugin,
    proposal: Extract<PluginEventProposal, { kind: 'artifact' }>,
    mode: 'create_only' | 'replace',
  ): { readonly result: Record<string, unknown> } | { readonly error: string } {
    assertSessionLockHeld(this.directory);
    const relative = path.posix.join('plugins', plugin.id, proposal.name);
    const target = path.join(this.directory, relative);
    if (mode === 'create_only' && existsSync(target)) {
      return { result: { kind: 'artifact', status: 'rejected', reason: 'exists', path: relative } };
    }
    try {
      mkdirSync(path.join(this.directory, 'plugins', plugin.id), { recursive: true });
      writeFileAtomic(target, proposal.content);
    } catch (caught) {
      return { error: `Could not write ${relative}: ${messageOf(caught)}` };
    }
    return {
      result: {
        kind: 'artifact', status: 'applied', path: relative,
        sha256: createHash('sha256').update(proposal.content).digest('hex'),
      },
    };
  }

  /**
   * Validates every proposal of one invocation. Any invalid entry rejects the whole invocation. At most one
   * artifact is allowed, and it must match a `uses.artifacts` claim.
   */
  private validate(
    plugin: SelectedPlugin,
    raw: unknown,
  ): { readonly proposals: readonly PluginEventProposal[] } | Extract<Outcome, { kind: 'fail' }> {
    const invalid = (error: string): Extract<Outcome, { kind: 'fail' }> =>
      ({ kind: 'fail', reason: 'invalid_intent', error });
    if (!Array.isArray(raw)) return invalid('The hook must return an array of proposals.');
    const proposals: PluginEventProposal[] = [];
    for (const [index, item] of raw.entries()) {
      if (!isValid(PluginEventProposal, item)) return invalid(`Proposal ${index} is not a valid plugin proposal.`);
      if (item.kind === 'artifact') {
        if (proposals.some((earlier) => earlier.kind === 'artifact')) {
          return invalid('An invocation may propose at most one artifact.');
        }
        if (!isSafeOutputName(item.name)) {
          return invalid(`Proposal ${index} has an unsafe artifact name: ${JSON.stringify(item.name)}.`);
        }
        if (!plugin.manifest.uses.artifacts.some((claim) => claim.name === item.name)) {
          return invalid(`Proposal ${index} names artifact "${item.name}", which uses.artifacts does not declare.`);
        }
      }
      proposals.push(item);
    }
    return { proposals };
  }

  /** The recorded form of a proposal: an artifact keeps its name and claimed media type, not its content. */
  private proposedOf(plugin: SelectedPlugin, item: PluginEventProposal): Record<string, unknown> {
    if (item.kind !== 'artifact') return { ...item };
    const claim = plugin.manifest.uses.artifacts.find((entry) => entry.name === item.name);
    return { kind: item.kind, name: item.name, media_type: claim?.media_type ?? '' };
  }

  /**
   * Validates every proposal, then applies them. Nothing is written when any proposal is invalid. Returns the
   * failure, or null once `plugin.decision` is recorded.
   */
  private apply(
    plugin: SelectedPlugin,
    invocationId: string,
    proposal: { raw: unknown; calls: readonly unknown[]; notes: readonly unknown[] },
  ): Extract<Outcome, { kind: 'fail' }> | null {
    const { raw, calls, notes } = proposal;
    const validated = this.validate(plugin, raw);
    if ('kind' in validated) return validated;
    const results: Record<string, unknown>[] = [];
    for (const item of validated.proposals) {
      if (item.kind !== 'artifact') {
        results.push({ kind: item.kind, status: 'applied' });
        continue;
      }
      const claim = plugin.manifest.uses.artifacts.find((entry) => entry.name === item.name);
      const written = this.writeArtifact(plugin, item, claim?.mode ?? 'replace');
      if ('error' in written) return { kind: 'fail', reason: 'error', error: written.error };
      results.push(written.result);
    }
    sessionEventLog.record(this.directory, {
      event: 'plugin.decision',
      timestamp: utcNow(),
      data: {
        plugin: plugin.id,
        invocation_id: invocationId,
        proposed: validated.proposals.map((item) => this.proposedOf(plugin, item)),
        results,
        ...(calls.length === 0 ? {} : { agent_calls: calls }),
        ...(notes.length === 0 ? {} : { notes }),
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
