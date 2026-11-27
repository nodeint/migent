import {
  type PluginActivationContext,
  type PluginCallContext,
  PluginContextClosed,
  type PluginEventProposal,
  type PluginExtensionReads,
  type PluginHandler,
  type PluginHook,
  type PluginInterceptor,
  type PluginManifest,
  type PluginResumeFacts,
  type PluginSessionArtifacts,
  type PluginSessionSnapshot,
} from '@nodeint/migent-contracts';

import type { AgentCaller } from './agent-call.js';
import { hashFacts, type SessionReads } from './evidence.js';
import type { InvocationState } from './invocation.js';

/** What an activation registered. Kept only when `activate` settles successfully. */
export interface PluginRegistrations {
  readonly events: Map<PluginHook, PluginHandler[]>;
  readonly interceptors: { readonly target: string; readonly interceptor: PluginInterceptor }[];
}

export const emptyRegistrations = (): PluginRegistrations => ({ events: new Map(), interceptors: [] });


interface ContextSources {
  readonly manifest: PluginManifest;
  readonly options: Readonly<Record<string, unknown>>;
  /** Reads one core config key. Called only for keys the manifest declares. */
  readonly readCore: (key: string) => unknown;
  /** The calling plugin's frozen extension keys. */
  readonly extensionReads: PluginExtensionReads;
  /** The core's session reads. Absent means `call.session` rejects. */
  readonly reads?: SessionReads;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const detached = <T>(value: T): T => (value === undefined ? value : deepFreeze(JSON.parse(JSON.stringify(value)) as T));

function sharedMembers(sources: ContextSources, invocation: InvocationState) {
  const { manifest, options, readCore, extensionReads } = sources;
  const open = <T>(member: string, read: () => T): T => {
    if (!invocation.open) throw new PluginContextClosed(member);
    return detached(read());
  };
  const frozenOptions = detached(options);
  return {
    config: Object.freeze({
      options: frozenOptions,
      core: (key: string): unknown => {
        if (!manifest.uses.config.includes(key)) {
          throw new Error(`Plugin "${manifest.id}" did not declare core config key "${key}" in uses.config.`);
        }
        return detached(readCore(key));
      },
      extensions: Object.freeze({
        workflow: () => open('config.extensions.workflow', () => extensionReads.workflow()),
        stage: (stageId: string) => open('config.extensions.stage', () => extensionReads.stage(stageId)),
        agent: (stageId: string) => open('config.extensions.agent', () => extensionReads.agent(stageId)),
        role: (name: string) => open('config.extensions.role', () => extensionReads.role(name)),
      }),
    }),
    log: Object.freeze({
      info: (text: string): void => { invocation.note('info', text); },
      warn: (text: string): void => { invocation.note('warn', text); },
    }),
  };
}

/**
 * One `call.session` read. It is declared in `uses.session`, rejected once the invocation settled (without
 * reading), and recorded as evidence by `read`. The result is detached and deeply frozen.
 */
async function readSession<T>(
  bound: { readonly sources: ContextSources; readonly invocation: InvocationState },
  kind: 'snapshot' | 'resume_facts' | 'artifacts',
  read: (reads: SessionReads) => T,
): Promise<T> {
  const { sources, invocation } = bound;
  const { manifest, reads } = sources;
  if (!manifest.uses.session.includes(kind)) {
    throw new Error(`Plugin "${manifest.id}" did not declare "${kind}" in uses.session.`);
  }
  if (!invocation.open) throw new PluginContextClosed('session.' + kind);
  if (reads === undefined) throw new Error(`Plugin "${manifest.id}" has no session to read.`);
  const value = read(reads);
  // The read is synchronous, but the plugin may await long after; a read that lands after settlement is refused.
  await Promise.resolve();
  if (!invocation.open) throw new PluginContextClosed('session.' + kind);
  return detached(value);
}

/** The per-invocation context: a new, frozen object for every interceptor and handler call. */
export function buildCallContext(
  sources: ContextSources,
  invocation: InvocationState,
  caller: AgentCaller | null,
): PluginCallContext {
  const { manifest } = sources;
  return Object.freeze({
    ...sharedMembers(sources, invocation),
    agents: Object.freeze({
      invoke: (prompt: string) => {
        if (!manifest.uses.agents) {
          return Promise.reject(new Error(`Plugin "${manifest.id}" did not declare uses.agents.`));
        }
        if (!invocation.open) return Promise.reject(new PluginContextClosed('agents.invoke'));
        if (caller === null) return Promise.reject(new Error(`Plugin "${manifest.id}" has no agent configured.`));
        return caller.invokeAgent(prompt);
      },
    }),
    session: Object.freeze({
      snapshot: (): Promise<PluginSessionSnapshot> => readSession({ sources, invocation }, 'snapshot', (reads) => {
        const snapshot = reads.snapshot();
        invocation.recordRead({ kind: 'snapshot', basisSeq: snapshot.basis_seq });
        return snapshot;
      }),
      artifacts: (): Promise<PluginSessionArtifacts> => readSession({ sources, invocation }, 'artifacts', (reads) => {
        const artifacts = reads.artifacts();
        invocation.recordRead({ kind: 'snapshot', basisSeq: artifacts.basis_seq });
        return artifacts;
      }),
      resumeFacts: (executionId: string): Promise<PluginResumeFacts> =>
        readSession({ sources, invocation }, 'resume_facts', (reads) => {
          const facts = reads.resumeFacts(executionId);
          invocation.recordRead({ kind: 'resume_facts', executionId, hash: hashFacts(facts) });
          return facts;
        }),
    }),
    artifacts: Object.freeze({
      propose: (name: string, content: string): PluginEventProposal => {
        if (!manifest.uses.artifacts.some((claim) => claim.name === name)) {
          throw new Error(`Plugin "${manifest.id}" did not declare artifact "${name}" in uses.artifacts.`);
        }
        return { kind: 'artifact', name, content };
      },
    }),
  });
}

/**
 * The activation context. Registration works until the activation invocation closes. A registration the manifest
 * does not declare throws and fails the activation, even when the plugin swallows the error.
 */
export function buildActivationContext(
  sources: ContextSources,
  invocation: InvocationState,
  registrations: PluginRegistrations,
): { readonly context: PluginActivationContext; readonly violation: () => string | null } {
  const { manifest } = sources;
  let violation: string | null = null;
  const refuse = (message: string): never => {
    violation ??= message;
    throw new Error(message);
  };
  const context: PluginActivationContext = Object.freeze({
    ...sharedMembers(sources, invocation),
    operations: Object.freeze({
      intercept: (target: string, interceptor: PluginInterceptor): void => {
        if (!invocation.open) throw new PluginContextClosed('operations.intercept');
        const declared = manifest.uses.operations.find((entry) => entry.target === target);
        if (declared === undefined) {
          refuse(`Plugin "${manifest.id}" did not declare operation target "${target}" in uses.operations.`);
        }
        for (const phase of ['before', 'after'] as const) {
          if (interceptor[phase] !== undefined && declared?.phases.includes(phase) !== true) {
            refuse(`Plugin "${manifest.id}" did not declare the ${phase} phase for "${target}" in uses.operations.`);
          }
        }
        registrations.interceptors.push({ target, interceptor });
      },
    }),
    events: Object.freeze({
      on: (kind: PluginHook, handler: PluginHandler): void => {
        if (!invocation.open) throw new PluginContextClosed('events.on');
        if (!manifest.uses.events.includes(kind)) {
          refuse(`Plugin "${manifest.id}" did not declare event "${kind}" in uses.events.`);
        }
        registrations.events.set(kind, [...(registrations.events.get(kind) ?? []), handler]);
      },
    }),
  });
  return { context, violation: () => violation };
}
