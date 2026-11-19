import Type, { type Static, type TSchema } from 'typebox';

import { id, nullable } from './common.js';
import { NonBlankString, RoleAgent } from './config.js';
import { CONFIG_SECTION_KEY_PATTERN,type ConfigSection } from './config-sections.js';
import type { PluginExtension } from './extension-catalog.js';

/**
 * Plugin contracts: manifest, shared LLM-plugin config, hook input, proposals and the invocation contexts, plus
 * the `plugins` config section. Pure data and types. The host and the plugins live elsewhere; nothing here runs.
 */

/** The event kinds a plugin handler can observe. */
export const PLUGIN_HOOKS = ['session.started', 'execution.finished', 'session.stopped', 'session.completed'] as const;
export const PLUGIN_OPERATION_PHASES = ['before', 'after'] as const;
export const PLUGIN_SESSION_READS = ['snapshot', 'resume_facts'] as const;
export const PLUGIN_ARTIFACT_MODES = ['create_only', 'replace'] as const;
/** The `hook` recorded for a failed activation. */
export const PLUGIN_ACTIVATE_HOOK = 'activate';
/** The plugin API version this core supports. A manifest needs the same major and a minor not above this one. */
export const PLUGIN_API_VERSION = { major: 1, minor: 0 } as const;
export const PLUGIN_ON_ERROR = ['ignore', 'stop', 'fail'] as const;
export const PLUGIN_FAILURE_REASONS = ['error', 'timeout', 'invalid_intent', 'unavailable', 'version_changed', 'cancelled', 'stale'] as const;

/** Semver 2.0.0 (semver.org): no leading zeros, dotted pre-release identifiers, optional build metadata. */
export const SEMVER_PATTERN =
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)' +
  '(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?' +
  '(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$';

export const PluginHook = Type.Enum(PLUGIN_HOOKS);
export type PluginHook = (typeof PLUGIN_HOOKS)[number];

export const PluginOnError = Type.Enum(PLUGIN_ON_ERROR, {
  $id: id('plugins/on-error'),
  title: 'Plugin failure policy',
  description: '`ignore` records the failure and continues; `stop` blocks the session; `fail` ends the run with exit 1.',
});
export type PluginOnError = Static<typeof PluginOnError>;

export const PluginFailureReason = Type.Enum(PLUGIN_FAILURE_REASONS, {
  $id: id('plugins/failure-reason'),
  title: 'Plugin failure reason',
});
export type PluginFailureReason = Static<typeof PluginFailureReason>;

/** Core defaults of the failure policy (design D3). */
export const PLUGIN_DEFAULT_ON_ERROR: PluginOnError = 'ignore';
export const PLUGIN_DEFAULT_TIMEOUT_SEC = 120;

export const PluginApiVersion = Type.Object(
  { major: Type.Integer({ minimum: 0 }), minor: Type.Integer({ minimum: 0 }) },
  { title: 'Plugin API version' },
);
export type PluginApiVersion = Static<typeof PluginApiVersion>;

/** Whether this core can host a plugin built for `version`. */
export function isSupportedPluginApiVersion(version: PluginApiVersion): boolean {
  return version.major === PLUGIN_API_VERSION.major && version.minor <= PLUGIN_API_VERSION.minor;
}

export const PluginUses = Type.Object(
  {
    operations: Type.Array(Type.Object({
      target: Type.String({ description: 'An operation id, or a `prefix.*` pattern.' }),
      phases: Type.Array(Type.Enum(PLUGIN_OPERATION_PHASES)),
    })),
    events: Type.Array(PluginHook),
    session: Type.Array(Type.Enum(PLUGIN_SESSION_READS)),
    artifacts: Type.Array(Type.Object({
      name: Type.String(),
      mode: Type.Enum(PLUGIN_ARTIFACT_MODES),
      media_type: Type.String(),
      fresh: Type.Optional(Type.Boolean()),
    })),
    agents: Type.Boolean({ description: 'The plugin calls an agent. Its config entry then needs an `agent`.' }),
    config: Type.Array(Type.String(), { description: 'Core config keys the plugin reads.' }),
  },
  { title: 'Plugin uses', description: 'Static declarations read without activating the plugin. Every context member checks them.' },
);
export type PluginUses = Static<typeof PluginUses>;

export const PluginManifest = Type.Object(
  {
    id: Type.String({ pattern: CONFIG_SECTION_KEY_PATTERN.source }),
    version: Type.String({ pattern: SEMVER_PATTERN, description: 'Semver 2.0.0.' }),
    apiVersion: PluginApiVersion,
    advisory: Type.Boolean(),
    defaultEnabled: Type.Optional(Type.Boolean()),
    uses: PluginUses,
    configSchema: Type.Unsafe<TSchema>(Type.Object({}, { additionalProperties: true })),
    defaults: Type.Optional(Type.Object({
      on_error: Type.Optional(PluginOnError),
      timeout_sec: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    })),
  },
  { $id: id('plugins/manifest'), title: 'Plugin manifest', description: 'Readable without activating the plugin. `configSchema` is a TypeBox schema.' },
);
/** `extensions` is the plugin's catalog entry. It is a type-only field: the generated schema stays unchanged. */
export type PluginManifest = Static<typeof PluginManifest> & { readonly extensions?: PluginExtension };

export const LlmPluginConfig = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean({ description: 'Default `true`.' })),
    agent: RoleAgent,
    responsibilities: Type.Optional(Type.Array(NonBlankString)),
    description: Type.Optional(NonBlankString),
    on_error: Type.Optional(PluginOnError),
    timeout_sec: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  },
  { $id: id('plugins/llm-config'), title: 'LLM plugin config', description: 'Shared fields of a plugin that declares `uses.agents`.' },
);
export type LlmPluginConfig = Static<typeof LlmPluginConfig>;

/** The fields every plugin entry may set, with or without `uses.agents`. */
export const PluginSharedConfig = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    on_error: Type.Optional(PluginOnError),
    timeout_sec: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  },
  { $id: id('plugins/shared-config'), title: 'Plugin entry shared fields' },
);

// ---- proposals and contexts -------------------------------------------------------------------

export const PluginEventProposal = Type.Union(
  [
    Type.Object({ kind: Type.Literal('artifact'), name: Type.String(), content: Type.String() }),
    Type.Object({ kind: Type.Literal('note'), text: Type.String() }),
    Type.Object({ kind: Type.Literal('none') }),
  ],
  { $id: id('plugins/event-proposal'), title: 'Plugin event proposal', description: 'A closed union. The core decides and records every effect. At most one `artifact` per invocation.' },
);
export type PluginEventProposal = Static<typeof PluginEventProposal>;

export const PluginBeforeProposal = Type.Union(
  [
    Type.Object({ kind: Type.Literal('continue') }),
    Type.Object({ kind: Type.Literal('patch'), fields: Type.Record(Type.String(), Type.Unknown()) }),
    Type.Object({ kind: Type.Literal('short_circuit'), output: Type.Unknown() }),
  ],
  { $id: id('plugins/before-proposal'), title: 'Plugin before-interceptor proposal' },
);
export type PluginBeforeProposal = Static<typeof PluginBeforeProposal>;

export const PluginAfterProposal = Type.Union(
  [
    Type.Object({ kind: Type.Literal('continue') }),
    Type.Object({ kind: Type.Literal('patch'), fields: Type.Record(Type.String(), Type.Unknown()) }),
  ],
  { $id: id('plugins/after-proposal'), title: 'Plugin after-interceptor proposal' },
);
export type PluginAfterProposal = Static<typeof PluginAfterProposal>;

export const PluginAgentResult = Type.Object(
  { text: nullable(Type.String()), error: nullable(Type.String()) },
  { $id: id('plugins/agent-result'), title: 'Plugin agent call result', description: 'All a plugin sees of an agent call.' },
);
export type PluginAgentResult = Static<typeof PluginAgentResult>;

/** One turn with usage normalized by the core, the same path the resume facts use. */
export interface PluginSessionTurn {
  readonly execution_id: string;
  readonly client: string | null;
  readonly usage: Readonly<Record<string, number | null>>;
  readonly captured: boolean;
}

/** One parsed session event, ordered by seq. `raw` is the record as stored. */
export interface PluginSessionEvent {
  readonly v: number;
  readonly seq: number | null;
  readonly event: string;
  readonly timestamp: string;
  readonly executionId: string | null;
  readonly stageId: string | null;
  readonly summary: string | null;
  readonly data: Readonly<Record<string, unknown>>;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Detached facts about one session at one moment. `basis_seq` is the last non-`plugin.*` event seq. */
export interface PluginSessionSnapshot {
  readonly basis_seq: number | null;
  readonly status: Readonly<Record<string, unknown>>;
  readonly corrupt: boolean;
  readonly executions: readonly Readonly<Record<string, unknown>>[];
  readonly events: readonly PluginSessionEvent[];
  readonly workflow: Readonly<Record<string, unknown>> | null;
  readonly turns: readonly PluginSessionTurn[];
  /** The client each execution ran with, resolved from its record and legacy evidence. Null when unknown. */
  readonly execution_clients: Readonly<Record<string, string | null>>;
  readonly exit_anomalies: readonly Readonly<Record<string, unknown>>[];
}

/** What the resume gate knows about one execution. Unknown values are null. */
export interface PluginResumeFacts {
  readonly completedAt: string | null;
  /** Last provider activity, from which the resume gate measures cache age; falls back to `completedAt`. */
  readonly lastActivityAt: string | null;
  readonly contextTokens: number | null;
}

/** Thrown by a context member used after its invocation settled, or by a registration after `activate` settled. */
export class PluginContextClosed extends Error {
  constructor(member: string) {
    super(`${member} was used after its invocation settled.`);
    this.name = 'PluginContextClosed';
  }
}

/** Members both contexts share. */
export interface PluginSharedContext {
  readonly config: {
    /** The plugin's own config entry. */
    readonly options: Readonly<Record<string, unknown>>;
    /** A declared core config key, frozen. */
    readonly core: (key: string) => unknown;
  };
  /** Recorded as notes on the invocation's terminal event while the invocation is open; dropped afterwards. */
  readonly log: {
    readonly info: (text: string) => void;
    readonly warn: (text: string) => void;
  };
}

/** The per-invocation context: the second argument of every interceptor and event handler. */
export interface PluginCallContext extends PluginSharedContext {
  readonly agents: {
    readonly invoke: (prompt: string) => Promise<PluginAgentResult>;
  };
  /**
   * Detached, frozen reads, declared in `uses.session`. The core records what each read returned. If it changes
   * before the invocation's proposal takes effect, the core discards the proposal and re-runs once (D10).
   */
  readonly session: {
    readonly snapshot: () => Promise<PluginSessionSnapshot>;
    readonly resumeFacts: (executionId: string) => Promise<PluginResumeFacts>;
  };
  readonly artifacts: {
    /** Builds the proposal for a declared artifact claim. Pure: nothing is written. */
    readonly propose: (name: string, content: string) => PluginEventProposal;
  };
}

/** A plain-data value an interceptor receives: the operation's request or outcome. */
export type PluginOperationData = Readonly<Record<string, unknown>>;

export interface PluginInterceptor {
  readonly before?: (request: PluginOperationData, call: PluginCallContext) => Promise<PluginBeforeProposal>;
  readonly after?: (outcome: PluginOperationData, call: PluginCallContext) => Promise<PluginAfterProposal>;
}

/** The activation context: registration only, valid until `activate` settles. */
export interface PluginActivationContext extends PluginSharedContext {
  readonly operations: {
    readonly intercept: (target: string, interceptor: PluginInterceptor) => void;
  };
  readonly events: {
    readonly on: (kind: PluginHook, handler: PluginHandler) => void;
  };
}

export const PluginHookInput = Type.Object(
  {
    hook: PluginHook,
    plugin: Type.Object({ id: Type.String(), version: Type.String(), config: Type.Unknown() }),
    session: Type.Object({
      id: Type.String(),
      workflow_id: nullable(Type.String()),
      task_summary: nullable(Type.String()),
      status: Type.Record(Type.String(), Type.Unknown()),
      trigger: Type.Record(Type.String(), Type.Unknown()),
    }),
    execution: Type.Optional(Type.Object({
      id: Type.String(),
      stage_id: nullable(Type.String()),
      outcome: nullable(Type.Record(Type.String(), Type.Unknown())),
      artifacts: Type.Array(Type.String()),
    })),
  },
  { $id: id('plugins/hook-input'), title: 'Plugin hook input', description: 'Detached, deeply frozen data: no handles and no writable paths.' },
);
export type PluginHookInput = Static<typeof PluginHookInput>;

export type PluginHandler = (
  input: PluginHookInput,
  call: PluginCallContext,
) => Promise<readonly PluginEventProposal[]>;

/** A manifest plus `activate`, which registers interceptors and handlers once per host scope. */
export interface Plugin {
  readonly manifest: PluginManifest;
  readonly activate: (
    options: Readonly<Record<string, unknown>>,
    migent: PluginActivationContext,
  ) => void | Promise<void>;
}

/** Static registry of plugins, keyed by manifest id. Built by the package that owns the plugins and injected. */
export interface PluginRegistry {
  readonly ids: () => readonly string[];
  readonly get: (id: string) => Plugin | undefined;
}

// ---- config section ---------------------------------------------------------------------------

/**
 * The `plugins` section. Both schemas accept any value so that freezing and resolving never throw on an
 * entry's shape; the host validates entries after classification (design D12).
 */
export const PLUGINS_SECTION: ConfigSection = {
  key: 'plugins',
  schema: Type.Record(Type.String(), Type.Unknown()),
  entrySchema: Type.Unknown(),
  merge: 'deep',
  freeze: 'per_entry',
};
