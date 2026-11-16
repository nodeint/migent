# @nodeint/migent-session

> For installation and usage, see [the Migent CLI on npm](https://www.npmjs.com/package/@nodeint/migent).

Stored session state for Migent: store, events, fold, ledger, lock, freeze, repair, query, metrics, and
diagnostics. Depends on the kernel. Internal; no stable public API. Behavior:
[docs/sessions.md](../../docs/sessions.md).

## Rules

- `status.json` is derived: fold it from events (`foldStatus`) and write it atomically; record changes as
  events first.
- Mutate a session only while holding `SessionLock`.
- Resume reads the frozen workflow and config (`session-freeze`), not live files.
- Write session events only through `sessionEventLog` (`src/event-log.ts`): `record` for lifecycle events,
  `recordProviderEvent` for provider and verify events, `commit` to fold and write `status.json`. The operation
  that owns a fold boundary calls `commit`; a multi-event operation commits once. The raw append functions in
  `session-events.ts` are internal to the log.
  Every log write (`record`, `recordStream`, `recordProviderEvent`, `commit`, `commitFolded`) throws unless this
  process holds the session lock; a failed write appends and notifies nothing.
- Subscribers (`subscribeSessionEvents`) are notified after `commit` (or `commitFolded`, which repair uses for its
  validated status) has written `status.json`, in sequence order. Kinds that never fold (heartbeats, item traces)
  are delivered right after their append, without waiting for a commit. Each notification is a detached, frozen
  copy of the record as serialized.
  They run synchronously inside the lock window, so keep them fast. A throwing listener is logged and never fails
  the write. A listener that writes events throws. Records still undelivered when the lock is released are dropped;
  a refold delivers nothing. Notifications are an in-process signal: the log is the durable truth.
- Files from any past Migent version must stay readable; a schema change needs a read path for old sessions.

## Key symbols

| Symbol | File | Purpose |
| --- | --- | --- |
| `createSessionDirectory` | `src/session-records.ts` | New session |
| `sessionEventLog`, `SessionEventLog`, `subscribeSessionEvents` | `src/event-log.ts` | Only writer of session events; subscribers |
| `EVENT_VERSION`, `eventRecord` | `src/session-events.ts` | Event envelope |
| `foldStatus`, `readSessionManifest` | `src/session-fold.ts` | Status fold |
| `SessionLock`, `requestSessionCancel` | `src/session-lock.ts` | Locking and cancel |
| `sessionLockState`, `withNumberingLock` | `src/session-lock.ts` | Read-only lock state; workspace numbering lock |
| `retireSessionNumber`, `readLastIdMark` | `src/session-id.ts` | `.last-id` high-water mark so deleted numbers are never reissued |
| `loadFrozenWorkflow`, `writeWorkflowFreeze` | `src/session-freeze.ts` | Frozen configuration |
| `repairSession` | `src/session-repair.ts` | Repair broken state |
| `selectRunWorkflow`, `selectSessionWorkflow` | `src/session-selection.ts` | Resolve workflow for a run |
| `publishNextSuggestions`, `resolveHandoff` | `src/next-handoff.ts` | Downstream handoff |
| metrics exports | `src/metrics.ts` | `metrics.json` |
