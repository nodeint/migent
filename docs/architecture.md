# Architecture and core boundary

Package layout, the mechanisms that only the core owns, and the internal seams that
extend them. Behavior of each mechanism is owned by the linked documents.

## Package dependency direction

Dependencies point down. A package imports only packages below it.

| Layer | Packages |
| --- | --- |
| Entry point | `cli` |
| Execution | `engine`, `doctor`, `registry` |
| State | `session` |
| Foundation | `kernel` |
| Parsing | `workflow` |
| Leaf | `contracts`, `prompts`, `adapters` |

`contracts` and `prompts` import no other Migent package. `adapters` imports only `contracts`.
`cli` is the only package that imports `adapters`.
The client contract types (`CliClient` and its companions) live in `contracts`; `kernel` re-exports them.
Each package README states its own rules.

## Core-only mechanisms

These mechanisms stay inside the core. Nothing outside the owning package reads or writes their
state directly.

| Mechanism | Owner | Symbols | Behavior |
| --- | --- | --- | --- |
| Session lock | `session` | `SessionLock` | [Sessions](sessions.md) |
| Event log | `session` | `sessionEventLog`, `subscribeSessionEvents` | [Sessions](sessions.md) |
| Status fold | `session` | `foldStatus` | [Sessions](sessions.md) |
| Freeze and resume | `session` | `writeWorkflowFreeze`, `loadFrozenWorkflow` | [Sessions](sessions.md) |
| Scheduler and graph | `engine`, `kernel` | `runExecuteLoop`, `schedulableStageIds` | [Workflows](workflows.md) |
| Exit-code catalog | `contracts` | `EXIT_CATALOG` | [CLI](cli.md) |
| Session-status catalog | `contracts` | `SESSION_STATUS_CATALOG` | [Sessions](sessions.md) |

## Seams

Internal seams attach to the core mechanisms. Two first-party plugins consume them. `metrics` runs by default on
`session.completed`, from an automatic completion and from `session complete`, which runs
`completeSessionManually` (`engine` `src/complete-manually.ts`) inside a plugin scope. `prompt_cache_ttl` runs by
default as a `before` interceptor of `conversation.resume`. No third-party plugin extends Migent.
`invokeOnce` has one caller, the plugin host's `agents.invoke` call member (`src/plugin-host/agent-call.ts`). The
plugin host in `engine` `src/plugin-host/` is the one subscriber, and the `plugins` section is the one registered
config section.

| Seam | Location | Rule |
| --- | --- | --- |
| Event log and subscribers | `session` `src/event-log.ts` | Only writer of session events. Subscribers run synchronously inside the lock window. Folding events are delivered after `status.json` is written; heartbeats and item traces are delivered right after their append. |
| Event-kind traits | `contracts` `src/event-kinds.ts` | One read-only registry (`stream`, `folds`, `skipsStatusWrite`, `stderr`) derived from the event catalog. Other packages read traits here. |
| Config sections | `contracts` `src/config-sections.ts` | Static list of namespaced sections; `plugins` is the only one. Kernel merges and validates them, doctor reports them, session freezes them. There is no runtime registration API. |
| Plugin extensions | `contracts` `src/extension-catalog.ts` | Static, core-owned `PLUGIN_EXTENSIONS` catalog (today `prompt_cache_ttl` claims the agent key `policy` and the stage key `on_expired`): each entry claims flat keys on the workflow, stage, agent, or role level. `extensionCatalogIssues` rejects a duplicate plugin, a bad key, a key claimed twice on one level, and a core or legacy key, and the module asserts the catalog when it loads. Contracts and the workflow parser derive their valid keys from the same core property sets plus the catalog. A plugin manifest's `extensions` must equal its catalog entry (`createPluginRegistry`). There is no runtime registration API. |
| Plugin host | `engine` `src/plugin-host/dispatch.ts` | `PluginHost` subscribes to the event log for one run and queues `session.started`, `execution.finished`, `session.stopped` and `session.completed`. `withPluginScope` starts the host, runs an action that holds the session lock, then drains and closes before the caller releases it. Each artifact is written atomically, then recorded; a crash between them leaves an unrecorded file that `session show` reports. A handler must keep no per-invocation state at module scope, because invocations of several stages can run concurrently. The host activates each plugin once per run through a settle-once invoker, closes each invocation's context when it settles, and checks registrations against the manifest's `uses`. A handler's `call.session` reads (snapshot, `resumeFacts`) are captured by the core as evidence, never supplied by the plugin; before applying a result the host repeats the reads, and a changed read discards the result and re-runs once per operation cycle or trigger, then records `plugin.failed: stale`. A handler gets detached frozen data and a per-invocation `call` context, and returns proposals. The host validates them against the closed union (at most one artifact per invocation) and applies them under the session lock. It records `plugin.hook_invoked`, then `plugin.decision` or `plugin.failed`, enforces the invocation deadline, and settles every invocation before the lock is released. |
| Plugin validation | `contracts` `src/plugins.ts`, `kernel` `src/plugin-validation.ts` | Plugin API 1.1 adds an optional pure `Plugin.validate(input)`, which returns problems with a path and a message and does no I/O. Kernel `pluginValidationProblems` runs the `validate` member of every enabled plugin in an injected registry against the config and the workflow's inline agents and stage keys. `migent doctor`, session creation and role creation call it, so an invalid selector stops the run with exit 2 before anything is created. |
| Agent invocation | `engine` `src/agent-invocation.ts` | `targetFromAgent`, `bindTarget`, and `invokeOnce` run one provider turn with no stage. The stage runner binds targets through `bindTarget`. |
| Operation runtime | `engine` `src/runtime/` | Generic cycle: validate the request, evaluate the policy once, run the handler, validate its output, let the definition decide, authorize the transition against declared edges, apply the changes, continue. An optional `InterceptorChain` runs before the handler and after its output check, for the fields an operation declares `interceptable`; the runtime judges each proposal (declared fields only, re-validated, never a core change) and keeps the value unchanged for a refused one. An empty chain makes no extra await. It names no operation or plugin and imports nothing from `src/execution/` or `src/plugin-host/`. Exceptions, including cancellation, propagate. |
| Execution layer | `engine` `src/execution/` | Three operations (`agent.turn`, `reply.gate`, `run.verify`), the role and verify-only definitions, and `ExecutionApplier`. `agent.turn` runs the provider and the gates over its fresh reply; `reply.gate` gates a saved reply a resumed execution starts from. Handlers and definitions propose changes; the applier alone writes the conversation, status, progress, turn files, diagnostics, report publication, and verdict events, in list order and synchronously. A handler's own effects are controlled and limited to process metadata, stream events and heartbeats. Pure helpers stay in `src/turn-steps.ts`. |
| Resume gate | `engine` `src/execution/resume-operation.ts`, `gate-changes.ts`, `src/resume-gate.ts` | The core operation `conversation.resume` decides whether a conversation continues (`resume`), starts fresh (`fresh`) or stops for a human (`ask`), on stage dispatch, reopening of a cancelled execution, and role continuation. A one-use human decision and an existing pending stop are applied first, and a cancellation request is checked after the operation. The operation is interceptable: a plugin may supply its output, which the core validates (an expiry report is required for any verdict but `resume`, and its origin is never `human`). `GateApplier` alone writes `resume.expired`, synchronously, after it checks cancellation and the session lock. |
| Cancellation and crash limit | `engine` `src/execution/cancel.ts` | The session lock and the global cancellation request belong to the session layer (see [Sessions](sessions.md) for the persisted lifecycle). Cancellation is observed only inside the provider and the verify runner, which are the handlers' own awaits. The handler commits the cancelled writes through the applier and rethrows; the runtime never catches it. A commit is one synchronous unit, so a cooperative interruption cannot split it. A process death in the middle of a commit is not covered: the writes already made stay, and recovery of that case is deferred, exactly as before the runtime. |

## Boundary rules

- Plugins never receive internal objects such as `SessionLock`, store handles, or execution state.
  A seam passes detached, frozen data; operation inputs and outputs are plain data.
- Session events are recorded only through the event log, and `status.json` is derived from them by the fold.
  Both run under the session lock. Other session files are written by their owning `session` functions.
- Every plugin read removes plugin-owned extension keys. The only path to extension data is `config.extensions`,
  which returns the calling plugin's own frozen keys. `call.session.snapshot().workflow` drops `extensions` and the
  owned agent keys of inline stage agents, and `config.core('agents' | 'roles')` drops the catalog's agent and role
  keys, both through `withoutOwnedKeys`. A field no plugin owns is returned unchanged. A new plugin read that returns
  workflow or config data must do the same.
- Resume reads the frozen core workflow, `roles`, and `targets`, not live files. A registered
  config section follows its own freeze policy (`frozen`, `live`, or `per_entry`).

## Freeze keys

The freeze file keeps resolved core settings at the top level: `roles` and `targets`.
The key `config` holds only registered config sections. Plugin extensions add three optional keys:
`extensions` (the version and owned keys per level of every plugin with a catalog entry),
`targets.<stage>.extensions`, and `role_extensions`. They are written only when non-empty. Reading a freeze never
consults the current catalog: ownership comes from the recorded `extensions` map. See [Sessions](sessions.md).

## Related documents

- [Documentation map](README.md)
- [Sessions](sessions.md)
- [Workflows](workflows.md)
