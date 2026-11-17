import Type, { type Static, type TSchema } from 'typebox';

import { id, nullable } from './common.js';
import { NonBlankString, RoleAgent } from './config.js';
import { CONFIG_SECTION_KEY_PATTERN,type ConfigSection } from './config-sections.js';

/**
 * Plugin contracts: manifest, shared LLM-plugin config, hook input, intents and capabilities, plus the
 * `plugins` config section. Pure data. The host and the plugins live elsewhere; nothing here runs.
 */

export const PLUGIN_HOOKS = ['session.started', 'execution.finished', 'session.stopped'] as const;
export const PLUGIN_CAPABILITIES = ['invokeAgent'] as const;
export const PLUGIN_ON_ERROR = ['ignore', 'stop', 'fail'] as const;
export const PLUGIN_FAILURE_REASONS = ['error', 'timeout', 'invalid_intent', 'unavailable', 'version_changed', 'cancelled'] as const;

/** Semver 2.0.0 (semver.org): no leading zeros, dotted pre-release identifiers, optional build metadata. */
export const SEMVER_PATTERN =
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)' +
  '(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?' +
  '(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$';

export const PluginHook = Type.Enum(PLUGIN_HOOKS);
export type PluginHook = (typeof PLUGIN_HOOKS)[number];

export const PluginCapability = Type.Enum(PLUGIN_CAPABILITIES);
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

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

export const PluginManifest = Type.Object(
  {
    id: Type.String({ pattern: CONFIG_SECTION_KEY_PATTERN.source }),
    version: Type.String({ pattern: SEMVER_PATTERN, description: 'Semver 2.0.0.' }),
    advisory: Type.Boolean(),
    hooks: Type.Array(PluginHook),
    capabilities: Type.Array(PluginCapability),
    configSchema: Type.Unsafe<TSchema>(Type.Object({}, { additionalProperties: true })),
    defaults: Type.Optional(Type.Object({
      on_error: Type.Optional(PluginOnError),
      timeout_sec: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    })),
  },
  { $id: id('plugins/manifest'), title: 'Plugin manifest', description: 'Readable without activating the plugin. `configSchema` is a TypeBox schema.' },
);
export type PluginManifest = Static<typeof PluginManifest>;

export const LlmPluginConfig = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean({ description: 'Default `true`.' })),
    agent: RoleAgent,
    responsibilities: Type.Optional(Type.Array(NonBlankString)),
    description: Type.Optional(NonBlankString),
    on_error: Type.Optional(PluginOnError),
    timeout_sec: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  },
  { $id: id('plugins/llm-config'), title: 'LLM plugin config', description: 'Shared fields of a plugin that declares `invokeAgent`.' },
);
export type LlmPluginConfig = Static<typeof LlmPluginConfig>;

/** The fields every plugin entry may set, with or without `invokeAgent`. */
export const PluginSharedConfig = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    on_error: Type.Optional(PluginOnError),
    timeout_sec: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  },
  { $id: id('plugins/shared-config'), title: 'Plugin entry shared fields' },
);

// ---- intents and capabilities -----------------------------------------------------------------

export const PluginIntent = Type.Union(
  [
    Type.Object({ kind: Type.Literal('output'), name: Type.String(), content: Type.String(), media_type: Type.String() }),
    Type.Object({ kind: Type.Literal('note'), text: Type.String() }),
    Type.Object({ kind: Type.Literal('none') }),
  ],
  { $id: id('plugins/intent'), title: 'Plugin intent', description: 'A closed union. The core decides and records every effect.' },
);
export type PluginIntent = Static<typeof PluginIntent>;

export const PluginAgentResult = Type.Object(
  { text: nullable(Type.String()), error: nullable(Type.String()) },
  { $id: id('plugins/agent-result'), title: 'Plugin agent call result', description: 'All a plugin sees of an `invokeAgent` call.' },
);
export type PluginAgentResult = Static<typeof PluginAgentResult>;

/** What the host offers a handler; each member exists only when the manifest declares it. */
export interface PluginCapabilities {
  readonly invokeAgent?: (prompt: string) => Promise<PluginAgentResult>;
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
  capabilities: PluginCapabilities,
) => Promise<readonly PluginIntent[]>;

/** A manifest plus one handler per declared hook. */
export interface Plugin {
  readonly manifest: PluginManifest;
  readonly handlers: Partial<Record<PluginHook, PluginHandler>>;
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
