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
Migent: nothing subscribes, nothing registers a config section, and `invokeOnce` has no caller.

| Seam | Location | Rule |
| --- | --- | --- |
| Event log and subscribers | `session` `src/event-log.ts` | Only writer of session events. Subscribers run synchronously inside the lock window. Folding events are delivered after `status.json` is written; heartbeats and item traces are delivered right after their append. |
| Event-kind traits | `contracts` `src/event-kinds.ts` | One read-only registry (`stream`, `folds`, `skipsStatusWrite`, `stderr`) derived from the event catalog. Other packages read traits here. |
| Config sections | `contracts` `src/config-sections.ts` | Static list of namespaced sections, empty today. Kernel merges and validates them, doctor reports them, session freezes them. There is no runtime registration API. |
| Agent invocation | `engine` `src/agent-invocation.ts` | `targetFromAgent`, `bindTarget`, and `invokeOnce` run one provider turn with no stage. The stage runner binds targets through `bindTarget`. |
| Turn-pipeline steps | `engine` `src/turn-flow-steps.ts`, `src/turn-persist-steps.ts`, `src/turn-steps.ts` | Named steps with typed inputs and results. `TurnLoop` keeps the state and the step order. There is no step registry. |

## Boundary rules

- Plugins never receive internal objects such as `SessionLock`, store handles, or `TurnLoop` state.
  A seam passes detached, frozen data or typed step inputs.
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
