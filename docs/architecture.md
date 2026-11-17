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

Leaf packages import no other Migent package. `cli` is the only package that imports `adapters`.
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

Internal seams attach to the core mechanisms. They have no production consumer that extends
Migent: `invokeOnce` has one caller, the plugin host's `invokeAgent` capability
(`src/plugin-host/agent-call.ts`). The plugin host in `engine` `src/plugin-host/` is the one subscriber, and
the `plugins` section is the one registered config section. Both act only when a plugin is registered.

| Seam | Location | Rule |
| --- | --- | --- |
| Event log and subscribers | `session` `src/event-log.ts` | Only writer of session events. Subscribers run synchronously inside the lock window. Folding events are delivered after `status.json` is written; heartbeats and item traces are delivered right after their append. |
| Event-kind traits | `contracts` `src/event-kinds.ts` | One read-only registry (`stream`, `folds`, `skipsStatusWrite`, `stderr`) derived from the event catalog. Other packages read traits here. |
| Config sections | `contracts` `src/config-sections.ts` | Static list of namespaced sections; `plugins` is the only one. Kernel merges and validates them, doctor reports them, session freezes them. There is no runtime registration API. |
| Plugin host | `engine` `src/plugin-host/dispatch.ts` | `PluginHost` subscribes to the event log for one run and queues `session.started`, `execution.finished` and `session.stopped`. A handler gets detached frozen data and returns intents. The host validates them against the closed union and applies them under the session lock. It records `plugin.hook_invoked`, then `plugin.decision` or `plugin.failed`, enforces the invocation deadline, and settles every invocation before the lock is released. |
| Agent invocation | `engine` `src/agent-invocation.ts` | `targetFromAgent`, `bindTarget`, and `invokeOnce` run one provider turn with no stage. The stage runner binds targets through `bindTarget`. |
| Operation runtime | `engine` `src/runtime/` | Generic cycle: validate the request, evaluate the policy once, run the handler, validate its output, let the definition decide, authorize the transition against declared edges, apply the changes, continue. It names no operation and imports nothing from `src/execution/`. Exceptions, including cancellation, propagate. |
| Execution layer | `engine` `src/execution/` | Three operations (`agent.turn`, `reply.gate`, `run.verify`), the role and verify-only definitions, and `ExecutionApplier`. `agent.turn` runs the provider and the gates over its fresh reply; `reply.gate` gates a saved reply a resumed execution starts from. Handlers and definitions propose changes; the applier alone writes the conversation, status, progress, turn files, diagnostics, report publication, and verdict events, in list order and synchronously. A handler's own effects are controlled and limited to process metadata, stream events and heartbeats. Pure helpers stay in `src/turn-steps.ts`. |
| Cancellation and crash limit | `engine` `src/execution/cancel.ts` | The session lock and the global cancellation request belong to the session layer (see [Sessions](sessions.md) for the persisted lifecycle). Cancellation is observed only inside the provider and the verify runner, which are the handlers' own awaits. The handler commits the cancelled writes through the applier and rethrows; the runtime never catches it. A commit is one synchronous unit, so a cooperative interruption cannot split it. A process death in the middle of a commit is not covered: the writes already made stay, and recovery of that case is deferred, exactly as before the runtime. |

## Boundary rules

- Plugins never receive internal objects such as `SessionLock`, store handles, or execution state.
  A seam passes detached, frozen data; operation inputs and outputs are plain data.
- Session events are recorded only through the event log, and `status.json` is derived from them by the fold.
  Both run under the session lock. Other session files are written by their owning `session` functions.
- Resume reads the frozen core workflow, `roles`, `targets`, and `resume_policies`, not live files. A registered
  config section follows its own freeze policy (`frozen`, `live`, or `per_entry`).

## Freeze keys

The freeze file keeps resolved core settings at the top level: `roles`, `targets`, and
`resume_policies`. The key `config` holds only registered config sections. See
[Sessions](sessions.md).

## Related documents

- [Documentation map](README.md)
- [Sessions](sessions.md)
- [Workflows](workflows.md)
