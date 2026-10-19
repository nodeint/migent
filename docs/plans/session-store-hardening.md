# Plan: Session store hardening

Scope: `packages/kernel/src/session-store.ts`, `session-records.ts`, `task-file.ts`, `query.ts`, `file-lock.ts`, `outputs.ts`, `process-ownership.ts`, the workflow and config loads in `execute.ts`, `dispatch.ts`, `config.ts` and `agent-runner.ts`, and `packages/cli/src/commands/watch.ts`, `sessions.ts` and `display.ts`.

This wave fixes how sessions are stored before parallel stages are built. It does not add parallel execution, `matrix`, instance IDs, per-stage state, or a DAG scheduler. `selection.ts` keeps routing by execution order.

Mark a task `[x]` when it is merged. This version was revised after two reviews that checked the drafts against the code (session `20261019-091644--agent--review-session-store-hardening-plan`, executions 0001 and 0002). Claims below were checked against the code unless marked **(verify)**.

## Goals

1. A crash or kill never leaves a session that cannot be read or resumed.
2. Only one process writes a session at a time.
3. `status.json` can be rebuilt from what the session directory holds.
4. A session runs against the workflow and config it started with.
5. Status computation and output publishing move out of the store.

## Current state

### High: state can be lost or corrupted today

1. **No JSON or manifest write is atomic.** `writeJson` is a plain `writeFileSync` (`session-store.ts:911`, a second copy at `session-records.ts:281`). `task-file.ts:85` writes `status.json` the same way. `prompt.md`, `response.md` (`session-store.ts:457-462`) and `createSessionFiles` (`749-764`) are plain writes too. Manifest status is a regex rewrite (`session-store.ts:617-627`, `session-records.ts:261-271`). `atomicCopy` in `outputs.ts` renames but does not fsync. A kill during a write leaves a truncated file:
   - `readJsonObject` (`session-store.ts:905`) throws, so `continue` fails closed;
   - `readStatusFile` (`query.ts:6`) returns `{}`, so `listSessionRows` skips the session (`query.ts:93-94`) and it disappears from `session list` with no error. `watchSnapshot` shows `unknown`, and `resolvePriorSessionId` says the session was not found (`session-records.ts:218-223`);
   - `freezeSessionTask` reads a corrupt `status.json` as `{}` (`task-file.ts:111-118`) and, with no stored hash, overwrites it with a file that holds only the hash (`task-file.ts:82-85`).
2. **Files are written before their events, and appends are not synced.** `saveExecutionUnlocked` writes `status.json`, then appends the event (`session-store.ts:524-538`), and `markSessionTerminal` runs after that status write (`540`). `createExecution` writes `execution.json` (`724`) before it appends `execution.started` (`740-745`). `appendFileSync` (`861-862`) has no fsync, so a crash can tear the last line of `events.jsonl`.
3. **No session-level lock.** Only an existing `execution.json` is locked (`withExecutionLock`, `session-store.ts:582-585`). `status.json` is read, modified and rewritten without a lock by `recordProviderEvent` (`366-382`), `saveExecutionUnlocked` (`465-524`), `resetRevisionCounts` (`414-425`), `freezeSessionTask` (`task-file.ts:82-85`) and `activatePreparedSession` (`session-records.ts:142-151`). The only guard is `reapOrphanedExecutions(…, "raise")`, which raises only for an execution whose status is `running` and whose endpoint is alive (`process-ownership.ts:175-196`). Between stages nothing is running, so two `session continue` calls on an idle session both pass `execute.ts:125` and `:270` and both call `createExecution`. The role-session equivalent is two resumes of one agent session, both entering `loadOrCreate` (`session-store.ts:216`). `session follow` is also a writer: it reaps with `"ignore"` (`watch.ts:47`) and can fail a dead execution (`session-store.ts:558-579`).
4. **Execution and session IDs can collide.** `nextExecutionOrder` and `nextStageAttempt` scan the executions directory (`session-store.ts:767-778`). `createExecution` checks `existsSync`, then calls `mkdirSync(..., { recursive: true })` (`716-717`), which succeeds when the directory exists. Two processes can get the same `0005-…` and share a directory. Session directories have the same pattern: `allocateSessionId` only picks an id (`session-records.ts:31-38`), and the recursive mkdir is in `createWorkflowSession` (`71-73`), `createPreparedSession` (`112-114`) and `createAgentSession` (`160-162`).
5. **`status.json` is rebuilt from key allowlists.** `providerStatusFields` (`session-store.ts:675-692`) copies only `RUNNING_STATUS_KEYS` or `SETTLED_STATUS_KEYS` (`57-88`). A field missing from the list used for a save is dropped. The branch taken when `current_stage.execution_id` differs from the saving execution keeps only `current_stage`, `outputs`, `workspace_id`, `revision_baselines` and `task_sha256`, and drops `workflow_id`, `workflow_path`, `task`, `created_at`, `prior_session_id`, `role` and `latest_provider_event`. A single sequential runner never reaches that branch: heartbeats come before the terminal save of the same execution. Two writers do reach it, and so will parallel stages. Without `workflow_id`, `loadWorkflow` returns `null` (`630-650`), the session lists as `legacy/unknown`, and outputs are not published (`807-808`).

### Medium: state cannot be rebuilt and drifts from its inputs

6. **`status.json` cannot be rebuilt.** Events have no `seq` and no version. Several state changes emit no event: `task_sha256`, `revision_baselines`, published outputs, and prepared-session activation. Session identity (`workflow_id`, `workflow_path`, `task`, `created_at`, `prior_session_id`, `role`) lives only in `manifest.yaml` and the first `status.json` (`session-records.ts:76-96`). Output provenance lives only in `status.json` (`session-store.ts:504-524`). A missing `task_sha256` makes the next freeze seal whatever `task.md` holds then (`task-file.ts:61-85`). A missing baseline counts as `1` (`selection.ts:150-152`). Outcome fields are spread last into lifecycle events (`session-store.ts:532-537`, `660-665`). Today they are only `status`, `blocker` and `decision` (`stage-outcome.ts:10-14`), but a future field named `event` or `timestamp` would overwrite the envelope.
7. **Provider items dominate the log.** In the latest `implement` session, 422 of 447 lines (94%) are `provider.item_started` or `provider.item_completed`. They are appended and do not touch `status.json` (`session-store.ts:368-369`). Every event in `STATUS_PROVIDER_EVENTS` (`event-kinds.ts`), including `provider.heartbeat` and `verify.heartbeat`, reads and rewrites the whole `status.json` (`366-382`).
8. **Workflow and config are not frozen.** The task is frozen by `task_sha256`, but the workflow is reread from the live file by `loadWorkflow` (`session-store.ts:630`), `loadRunStage` (`agent-runner.ts:443`), `execute.ts:123` and `dispatchNamedStage` (`dispatch.ts:59`, used for dispatch and resume at `96-127`). The model comes from `resolveStageTarget` reading `config.yaml` (`config.ts:61`, called at `dispatch.ts:61` and `execute.ts`). Role instructions are read again at `execute.ts:323`. Editing a workflow, or running `config model`, during a session changes its routing, completion, outputs, model or prompt, and nothing detects it.
9. **Two sources of truth for session status.** `manifest.yaml` has `status` (`running`, `prepared`, `completed`, `blocked`, `cancelled`) and `status.json` has `status` (`active`, `prepared`, `completed`, `blocked`, `cancelled`). No TypeScript code branches on the manifest status. `docs/sessions.md` describes it, and `packages/kernel/test/task-file.test.ts:60` expects `status: running` after activate.
10. **No session schema version.** Only `execution.json` has `schema_version` (`session-store.ts:736`).

### Design: not bugs, but they block parallel stages

11. **The store applies session rules.** `saveExecutionUnlocked` (`session-store.ts:465`) writes files, loads the workflow (`481`), publishes outputs (`485-488`), computes the session status (`497-503`), sets terminal fields (`597-614`) and `latest_decision` (`517-522`), and rewrites the manifest (`653-659`).
12. **Routing is inferred from global execution order.** `selection.ts:187-221` uses `executionOrder`. No per-stage record exists. This wave does not change it.

## Resolved questions

- **Who reads `provider.item_*` from `events.jsonl`?** Not the skill template (it tells agents not to follow, `templates/migent/SKILL.md:94`) and not the registry. The readers are `session follow`, `docs/cli.md:80`, `integration/execute.test.ts` and `packages/cli/test/dx.test.ts:104-108`.
- **Does `proper-lockfile`'s `lockSync` refresh?** Yes. It calls the same `lock()` (`proper-lockfile/index.js:12-15`), and `update` defaults to `stale / 2` through a `setTimeout`. With `STALE_MS = 10_000` (`file-lock.ts:5`) that is 5 s. The lock is an empty directory with no pid, host or heartbeat, and `onCompromised` is a no-op (`file-lock.ts:24`), so a holder whose lock was taken keeps writing. It is not the lock A2 needs.
- **What can block the event loop while a session lock is held?** Verify commands await `waitForExit` and do not block (`verify-runner.ts:117-137`). `withFileLockSync` can block for up to `FILE_LOCK_TIMEOUT_MS` (30 s) in `Atomics.wait` (`file-lock.ts:7`, `:32-37`). `probeEndpointSync` blocks for up to 3 s (`process-ownership.ts:19`, `:96-102`). A 30 s block equals the planned stale limit, so A2 must recheck the lock after those calls.
- **When does `follow` reap?** Once, at start (`watch.ts:47`). `--until` and `--exit-when-done` then read stored status only (`watch.ts:76-91`). Without that reap, a dead owner leaves the execution `running` and `follow` waits forever.
- **Error type of the live-owner check.** `raiseReapDecision` throws a plain `Error` (`process-ownership.ts:151-158`). `executeWorkflow` turns a plain `Error` into the workflow JSON with exit 2 (`execute.ts:169-180`). A `ConfigurationError` is rethrown (`execute.ts:168`) and the CLI prints stderr only.

## Decisions

1. **CLI contracts do not change.** `session run`, `continue`, `show` and `list` keep their stdout JSON and exit codes. `session follow` keeps its printed fields (`event`, `timestamp`, `stage_id`, `summary`) and event names. The one change is in B3 and is listed in the changelog.
2. **The layout only grows.** New files: `session.lock`, `workflow.frozen.yaml`, `executions/<id>/stream.jsonl`. No existing file moves.
3. **v1 sessions stay readable and are not rewritten in place.** Their manifests keep being updated as today. A repair of a v1 session never removes a field it cannot rebuild.
4. **Event first, then status.** Every state change appends and syncs an event, then writes `status.json`. A crash between the two is repaired by folding again.
5. **No per-stage state in this wave.** `revision_baselines` stays the only revision record.

## Order

Phases A, B, C in order. Phase A is independent and should merge first. Phase B needs the session lock from A2 to assign `seq`. Phase C needs the fold from B4.

---

## Phase A: Data safety

### A1. Atomic writes and synced appends
- [ ] Add `writeFileAtomic(path, data)`: write a temp file in the same directory, `fsync`, `rename`. On Windows, retry `rename` on `EPERM` and `EBUSY` with a short backoff.
- [ ] Use it for `status.json`, `execution.json`, `conversation.json`, `manifest.yaml`, `task.md`, `prompt.md` and `response.md`, and in `createSessionFiles`. Add the fsync to `atomicCopy`.
- [ ] Add `appendLineSynced(path, line)`: one write of a complete line, then `fsync`.
- [ ] Order of writes:
  - `createExecution`: write and fsync `execution.json` first, then append `execution.started` built from that file. `executionContexts` skips a directory with no `execution.json` (`session-store.ts:788`), so an event written first would point at an execution that allocation cannot see.
  - `saveExecutionUnlocked`: write `execution.json`, then append `execution.*`, `stage.*` and `session.*`, then write `status.json` (today at `session-store.ts:524`, before `markSessionTerminal` at `:540`).
  - `markSessionTerminal` keeps only the manifest update.
- [ ] Remove the duplicate `writeJson` in `session-records.ts` and the inline write in `task-file.ts`.
- [ ] Tests: a write interrupted before `rename` leaves the old file intact. Readers ignore leftover temp files.

### A2. Session lock
- [ ] Hold `sessions/<id>/session.lock` for every writer of a session: `session run`, `session continue`, and `session run --role --session`. Take it before activate, revision reset, task freeze, reap and `createExecution`.
- [ ] Implement it as a file created with `wx` that holds `pid`, `host`, `started_at`, `heartbeat_at` and a random `nonce` the holder keeps in memory. Do not reuse `withFileLockSync`.
- [ ] Refresh `heartbeat_at` every 10 s with an atomic replace (A1), so a reader never parses a torn file. Treat a lock as stale after 30 s without a heartbeat. On the same host, also treat it as stale when the pid is gone. Do not trust the pid alone, because pids are reused (`CONTRIBUTING.md:71-74`).
- [ ] Every refresh writes the same `nonce` the holder stored.
- [ ] Take over a stale lock in this order: read the file and remember its `nonce` and `heartbeat_at`; read it again; `unlink` only when the second read shows the same `nonce` and the same stale `heartbeat_at`; then create a new file with `wx`. If either value changed, the lock is held. `EEXIST` on the `wx` means another process won, and the lock counts as held.
- [ ] A race between the second read and `unlink` is still possible. It needs a holder that missed three refreshes and then refreshed within that window. The nonce check below makes that case fail safe: the old holder stops before its next write.
- [ ] The refresh is a timer on the event loop. `withFileLockSync` and `probeEndpointSync` can block it (see Resolved questions). The holder checks that the lock file still has its `nonce` after every `withFileLockSync` call and before every session write.
- [ ] When the nonce check fails, the holder stops writing and exits with the lock error.
- [ ] `session follow` reaps only when it can take the session lock. At start it tries the lock once. If it gets the lock, it reaps as today and releases the lock before tailing. If the lock is held, it tails read-only. A live holder keeps today's wait. An owner that died with no live lock holder is failed at follow start, as today.
- [ ] `show` and `list` never write.
- [ ] Error when the lock is held: `Session <id> is being run by pid <n> on <host>.` Throw a plain `Error`, so the workflow path keeps today's JSON output and exit 2.
- [ ] Keep `reapOrphanedExecutions` for provider-process cleanup. It runs under the lock.
- [ ] Tests: two `continue` calls on an idle session, where exactly one runs. Two resumes of one agent session. Takeover of a stale lock. A holder whose lock was taken stops.

### A3. Safe ID allocation
- [ ] In `createWorkflowSession`, `createPreparedSession` and `createAgentSession`, create the session directory with a non-recursive `mkdirSync` (parents created first). On `EEXIST`, pick the next id and retry. A prepared session with a manual id fails on `EEXIST`, as it does today.
- [ ] Allocate execution order and attempt while holding the session lock. Create the execution directory non-recursively, so `EEXIST` is an error.
- [ ] Tests: concurrent session creation with the same task never shares a directory. Execution allocation under contention never produces duplicate IDs.

### A4. Corrupt status files
- [ ] Leave `readStatusFile` as it is, because it is a public kernel export. Add a reader that reports `missing`, `corrupt` or `ok`.
- [ ] `session list` uses the new reader and shows a corrupt session with status `corrupt`. Add `corrupt` to the `--status` allowlist (`commands/sessions.ts:7`, `program.ts:299`) and its help text.
- [ ] `session show` exits 2 and names the corrupt file. `--prior` reports a corrupt `status.json` instead of "not found".
- [ ] `freezeSessionTask` and `activatePreparedSession` fail on a corrupt `status.json` instead of overwriting it.
- [ ] Until B4, `continue` on a corrupt session keeps failing. The error names the corrupt file.
- [ ] Tests: a truncated `status.json` lists as `corrupt`, `show` reports it, and freeze does not overwrite it.

---

## Phase B: Event log as source of truth

### B1. Event envelope v2
- [ ] Each line in `events.jsonl` keeps today's top-level keys and adds `v` and `seq`:
  ```json
  {"v":2,"seq":17,"event":"execution.completed","timestamp":"…","execution_id":"0003-…","stage_id":"implement","data":{}}
  ```
- [ ] `event`, `timestamp`, `stage_id`, `execution_id` and `summary` keep their names and meaning, so `printWatchEvent` (`display.ts:113-119`) and `follow --json` consumers are unchanged. Event names do not change (`execution.running`, `execution.completed`, `stage.complete`, `session.completed`, and so on; `verify.test.ts:115` asserts `execution.running`).
- [ ] New payload goes in `data`. The outcome also goes in `data`. On `stage.*` and `session.*` events, which spread it today (`session-store.ts:531-537`, `660-665`), it is also copied at the top level, before the envelope keys so it cannot overwrite them. `execution.*` events do not carry it at the top level, as today.
- [ ] `seq` is assigned under the session lock and increases by one per line.
- [ ] Lines without `v` are read as v1. The fold ignores a trailing partial line.

### B2. Lifecycle events carry the full state change
- [ ] `session.created` with workflow ID, path, hash, task label, `prior_session_id` and role.
- [ ] `session.activated` for prepared sessions.
- [ ] `task.frozen` with `sha256`.
- [ ] `execution.started` with order, attempt, provider, model and `resumes_execution_id`.
- [ ] `execution.<status>` with outcome, `failure_reason` and error in `data`.
- [ ] `revisions.reset` with the baselines.
- [ ] `outputs.published` with name, path, source execution and publishing execution.
- [ ] `session.<status>` with `from` and reason in `data`.

### B3. Provider stream per execution
- [ ] Move only `provider.item_*` and `provider.heartbeat` to `executions/<id>/stream.jsonl`.
- [ ] Keep every other event in `events.jsonl`, including `provider.stage_started`, `provider.turn_completed`, `provider.turn_failed`, `provider.cancelled`, `provider.error`, `provider.warning` and all `verify.*` events.
- [ ] Heartbeats never rewrite `status.json`. `provider.heartbeat` moves to the stream. `verify.heartbeat` stays in `events.jsonl` (`event-kinds.ts`, `verify-runner.ts:137`), but it is appended without a fold or status write.
- [ ] `session follow` merges `events.jsonl` with every execution's `stream.jsonl` in timestamp order:
  - no `--cursor`: print the snapshot, then tail `events.jsonl` and every stream from their current end, as today;
  - `--cursor 0`: replay all of `events.jsonl` merged with every stream, matching today's "0 replays the whole log" (`program.ts:355`);
  - any other `--cursor N`: replay `events.jsonl` from byte `N`, and stream lines whose timestamp is at or after the first complete event at or after byte `N`. When no complete event exists at or after `N` (a cursor at end of file), replay no old stream lines and tail every stream from its end.
- [ ] On each poll, `follow` opens any `stream.jsonl` created after it started and reads it from offset 0, so stages that start later are shown.
- [ ] Every merged line goes through `emitWatchEvent`, so `--execution` keeps filtering by `execution_id` (`watch.ts:129`).
- [ ] `--cursor` stays a byte offset into `events.jsonl`. Update `docs/cli.md`, the changelog, `integration/execute.test.ts` and `packages/cli/test/dx.test.ts` to state that stream lines are matched by timestamp.

### B4. Fold and repair
- [ ] Add a pure `foldStatus(inputs) → status`.
- [ ] For schema 2 sessions, the inputs are `manifest.yaml` and `events.jsonl`. Before folding, reconcile in both directions:
  - for every `execution.json` with no matching `execution.started` or terminal event, build the missing events from that file and append them (synced);
  - an `execution.started` whose `execution.json` is absent is ignored by the fold, and its id is reserved so allocation never reuses it.
- [ ] For v1 sessions, the inputs are `manifest.yaml` (identity), every `execution.json`, `task.md`, `outputs/`, and every field that still parses in the old `status.json`:
  - keep `task_sha256`, `revision_baselines` and `outputs` from the old file when they exist;
  - derive the session status from the executions, not from the manifest. The manifest says `running` where `status.json` says `active` (`session-records.ts:82` and `:91`), and copying it would make `runnableViolation` reject the session. Manifest `prepared` maps to `prepared`. Manifest `running` with no terminal execution maps to `active`;
  - use `outputs/` only to report that files exist. Never invent `source_execution_id` or `published_by_execution_id`.
- [ ] `repair` and `continue` refuse to replace `status.json` when:
  - the fold has no `workflow_id`;
  - the old `status.json` does not parse, because the hash can then not be kept, even when `outputs/` is empty;
  - a parsed `status.json` has a `task_sha256` or an `outputs` entry that the fold would drop.
  
  The error names the missing fields and points to `repair --accept-task`. That flag is the only way past an unparseable `status.json`.
- [ ] A file in `outputs/` that the kept map does not name is not a refusal. `publishOutputFiles` copies the file before its provenance is recorded (`outputs.ts:181-188`, called at `session-store.ts:485-488`, status written at `:524`), so a kill there leaves such a file. `repair` and `continue` keep the map and add a path-only row for that file.
- [ ] Every write path appends the event, then writes `status.json` from the fold.
- [ ] Remove `RUNNING_STATUS_KEYS`, `SETTLED_STATUS_KEYS` and `providerStatusFields`.
- [ ] Add `migent session repair <id>` to rebuild `status.json`. It takes the session lock.
- [ ] `session show` prints drift between `status.json` and the fold on stderr, for schema 2 sessions only. The stdout snapshot object (`query.ts:59-72`) does not change. `doctor` does not compare folds, because `diagnose` has three fixed checks and a failure exits 1 for `config --json` too (`doctor.ts:45-62`, `commands/doctor.ts:16`, `commands/config.ts:467-471`).
- [ ] Document the limit: when a v1 `status.json` is destroyed, the task hash and output provenance cannot be recovered. `repair --accept-task` is the only way past that. It stores the hash of the current `task.md` and appends `task.frozen`. It keeps any provenance map that parsed, and adds path-only rows only for files in `outputs/` that the map lacks. It never leaves `task_sha256` empty. `continue` does not accept the flag.
- [ ] Tests: for every workflow fixture, the fold equals the written `status.json` after each step. A kill between an event and its file, in either order, is repaired by `continue`. A v1 fixture repaired from a partial `status.json` keeps its identity, hash and outputs. A v1 fixture with a destroyed `status.json` is refused by `continue` and `repair`, and is accepted by `repair --accept-task` with a stored hash.

---

## Phase C: Freezing and structure

### C1. Frozen workflow and config
- [ ] On workflow session create, write `workflow.frozen.yaml`: the resolved workflow, the role instructions it uses, and each stage's resolved provider, model and options. Record its `sha256` in `session.created`.
- [ ] Every load for that session uses the frozen copy: `session-store.ts:loadWorkflow`, `agent-runner.ts:loadRunStage`, `execute.ts`, `dispatch.ts:dispatchNamedStage`, and the role-instruction read at `execute.ts:323`.
- [ ] `resolveStageTarget` loads the live workflow itself (`config.ts:61`) and is called with a workflow id (`execute.ts:312`, `dispatch.ts:61`). Add a variant that takes the frozen document and the frozen stage target, and use it for session dispatch. The id-based form stays for commands outside a session.
- [ ] Agent (role) sessions have no workflow and are not frozen.
- [ ] `continue` warns when the workflow file, a stage's resolved model, or role instructions differ from the frozen copy, and uses the frozen copy. `--refresh-workflow` adopts the current definition and appends `workflow.refreshed`.
- [ ] Sessions with no frozen file keep the live loaders.
- [ ] Tests: editing the workflow, or `config model`, during a session changes neither its routing nor its model. `--refresh-workflow` does.

### C2. One source of truth for session status
- [ ] For schema 2 sessions, `manifest.yaml` holds identity only and is never rewritten. It has no `status` line.
- [ ] v1 manifests keep being updated as today.
- [ ] Session status for schema 2 lives only in `status.json`.
- [ ] Update `docs/sessions.md` and `packages/kernel/test/task-file.test.ts:60` in the same PR.

### C3. Store and ledger
- [ ] Move session status computation (`sessionStatusAfterExecution`, terminal fields, `latest_decision`) and output publishing out of `saveExecutionUnlocked` into a new `session-ledger.ts`.
- [ ] `SessionStore` keeps locking, atomic writes, appends, reads, the fold and the immutability check.
- [ ] No behavior change. The existing tests pass unchanged.

### C4. Schema version
- [ ] New sessions write `schema_version: 2` in `manifest.yaml`.
- [ ] Read it with a session-specific helper where a missing version means 1. Do not reuse `documentVersion` in `config.ts`, which maps a missing version to 0. `migent migrate` does not touch sessions.

---

## Required tests

- [ ] **Crash injection.** Kill the process between each pair of writes in the A1 order: `execution.json` then `execution.started`; `execution.json` then the lifecycle events; the lifecycle events then `status.json`; an output copy then `status.json`. After `repair` or `continue`, the session is consistent and no execution is lost.
- [ ] **Concurrent writers.** Two `continue` calls on an idle session, and two resumes of one agent session. Exactly one runs, and no execution IDs are duplicated.
- [ ] **Lock loss.** A holder blocked longer than the stale limit, whose lock was taken over, stops at its next nonce check without writing. A waiter does not unlink a lock whose nonce or heartbeat changed between its two reads.
- [ ] **Event without file.** A crash after a directory is created and before `execution.json` is written leaves no event. A forged `execution.started` with no file is ignored by the fold and its id is not reused.
- [ ] **Follow after a dead owner.** With no live lock holder, `follow --exit-when-done` and `follow --until` end after the owner dies. With a live holder, they wait as today.
- [ ] **Fold equality.** The fold equals the written `status.json` for every workflow fixture.
- [ ] **Corrupt file.** A truncated `status.json` lists as `corrupt`, freeze does not overwrite it, and `repair` rebuilds it.
- [ ] **Compatibility.** Fixtures copied from real v1 sessions work with `show`, `list`, `follow`, `continue` and `repair`.
- [ ] **Follow output.** For one fixture session, `follow` and `follow --json` print the same sequence before and after B3, compared on `event`, `timestamp`, `stage_id`, `execution_id` and `summary` (B1 adds `v`, `seq` and `data`). Cover no cursor, `--cursor 0`, a cursor in the middle of the log, a cursor at end of file, a stage that starts after follow does, and `--execution`.
- [ ] **Frozen definition.** A session keeps its workflow, model and role instructions after the files change, and prints a warning.

## Pull requests

1. A1 and A4: atomic writes, synced appends, corrupt-file handling.
2. A2 and A3: session lock and ID allocation.
3. B1, B2 and B4: event v2, lifecycle events, fold and `repair`.
4. B3: provider stream and the `follow` merge.
5. C1, C2 and C4: frozen workflow and config, schema 2 manifest, schema version.
6. C3: store and ledger split. Refactor only.

## Risks

- Long-held locks on Windows: heartbeat timing and stale-lock takeover.
- The `follow` merge in B3 changes where lines come from. The follow-output test is the guard.
- The v1 fold disagreeing with a hand-built `status.json` on an edge case. Repair never drops a field it cannot rebuild, and the fold equality tests cover every fixture.
