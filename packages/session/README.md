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
- Files from any past Migent version must stay readable; a schema change needs a read path for old sessions.

## Key symbols

| Symbol | File | Purpose |
|---|---|---|
| `createSessionDirectory` | `src/session-records.ts` | New session |
| `appendLifecycleEvent`, `EVENT_VERSION` | `src/session-events.ts` | Event log |
| `foldStatus`, `commitFoldedStatus`, `readSessionManifest` | `src/session-fold.ts` | Status fold |
| `SessionLock`, `requestSessionCancel` | `src/session-lock.ts` | Locking and cancel |
| `sessionLockState`, `withNumberingLock` | `src/session-lock.ts` | Read-only lock state; workspace numbering lock |
| `retireSessionNumber`, `readLastIdMark` | `src/session-id.ts` | `.last-id` high-water mark so deleted numbers are never reissued |
| `loadFrozenWorkflow`, `writeWorkflowFreeze` | `src/session-freeze.ts` | Frozen configuration |
| `repairSession` | `src/session-repair.ts` | Repair broken state |
| `selectRunWorkflow`, `selectSessionWorkflow` | `src/session-selection.ts` | Resolve workflow for a run |
| `publishNextSuggestions`, `resolveHandoff` | `src/next-handoff.ts` | Downstream handoff |
| metrics exports | `src/metrics.ts` | `metrics.json` |
