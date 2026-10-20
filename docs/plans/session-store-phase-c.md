# Plan: Session store phase C

Scope: freeze the workflow and config a session started with, stop writing session status into schema 2 manifests, and split session rules out of `SessionStore`. This is phase C of [session-store-hardening.md](session-store-hardening.md).

In scope:

- `packages/kernel/src/session-records.ts`, `session-store.ts`, `session-fold.ts`, `session-events.ts`, `config.ts`, `workflow.ts`, `execute.ts`, `dispatch.ts`, `agent-runner.ts`
- a new `packages/kernel/src/session-freeze.ts` and, in the second pull request, `packages/kernel/src/session-ledger.ts`
- `packages/cli/src/program.ts` and the execute command that forwards flags
- `docs/sessions.md`, `docs/cli.md`, `CHANGELOG.md`, and `packages/cli/src/templates/migent/SKILL.md`
- the kernel tests named in each task

Out of scope is listed at the end. Do not add parallel stages, per-stage state, or a scheduler.

Claims were checked against the current tree. Paths below are current.

## Current behavior

### Sessions do not pin the workflow or the model

`createWorkflowSession` (`session-records.ts:87-127`) and `createPreparedSession` (`129-173`) write `manifest.yaml` and `session.created`. The event's `hash` is the sha256 of the workflow source file (`workflowSourceHash`, `303-310`). Nothing reads that field.

Later loads read the live files:

- `SessionStore.loadWorkflow` (`session-store.ts:621-642`) tries `status.workflow_path`, then `loadNamedWorkflow`.
- `loadSessionWorkflow` (`session-fold.ts:599-620`) does the same for the v1 fold.
- `executeLocked` loads with `loadNamedWorkflow` (`execute.ts:154` and `:162`).
- `dispatchExecuteStage` resolves the model with `resolveStageTarget(workspace, workflowId, stageId)` (`execute.ts:351`) and reads role instructions from live `config.yaml` (`362-365`).
- `dispatchNamedStage` loads the live workflow and calls `resolveStageTarget` again (`dispatch.ts:59-65`).
- `loadRunStage` (`agent-runner.ts:443-459`) loads the live stage. That stage supplies decision values, the artifact name, and verify commands (`agent-runner.ts:129-133`).

`resolveStageTarget` (`config.ts:46-66`) returns the provider and model immediately when both overrides are set. Otherwise it loads the live workflow and `config.yaml` and merges model, role, and stage options in `resolveStageSpec` (`68-83`).

An edit to a workflow file, a role's `instructions`, or `config model` changes the next dispatch of an existing session.

### Manifest status is a second copy

New manifests include a `status` line: `running` for workflow and agent sessions (`session-records.ts:111`, `:210`), `prepared` for a prepared session (`:158`).

These writes replace that line when it is present:

- `replaceManifestStatus` after activate (`session-records.ts:189`, `:319-330`)
- `rewriteManifestStatus` when a blocked session resumes (`session-store.ts:394`), when a save runs while the session was `completed` (`:474-476`), and when the session becomes `completed`, `blocked`, or `cancelled` (`:546-548`, `:608-619`)

Both replacers return without writing when the line is absent. `createSessionFiles` (`session-store.ts:723-736`) writes a manifest only when the file is missing. New sessions already have one, so that path does not run for them.

No runtime branch reads the manifest status except the fold. `initialStatus` maps it through `manifestStatusToSession` (`session-fold.ts:464-489`): `prepared` stays `prepared`; `running` becomes `active`; `completed`, `blocked`, and `cancelled` pass through. `foldV1` uses the same map when the session has no executions (`:156`). `docs/sessions.md:37-39` calls the line the terminal status. `task-file.test.ts:50` expects `status: prepared`, and `:64` expects `status: running` after activate.

`status.json` is the snapshot `session show` and `session list` read. Its status values are `active`, `prepared`, `completed`, `blocked`, and `cancelled`.

### Schema 2 is read, and new sessions still omit it

`sessionSchemaVersion` (`session-fold.ts:59-66`) treats a missing or invalid `schema_version` as 1. `documentVersion` (`config.ts:115-133`) treats a missing version as 0 and throws on an invalid one. The fold already branches on `schemaVersion >= 2` (`session-fold.ts:69`).

`createWorkflowSession`, `createPreparedSession`, and `createAgentSession` do not write `schema_version`. `migent migrate` rewrites `.migent/config.yaml` and `.migent/workflows/*.yaml` only (`packages/cli/src/migrate.ts:135-198`). It does not open `.migent/sessions/`.

Tests that want schema 2 patch the manifest after creation and still expect a status line (`session-fold.test.ts:248`, `:395-401`; `verify.test.ts:207-210`).

For schema 2, the fold copies `data.session_status` off the latest execution event and then sets `latest_decision` and the terminal fields (`session-fold.ts:295-315`). It does not recompute completion. The v1 fold recomputes with `sessionStatusAfterExecution` (`:343-362`). `session.created` does not change status. A prepared session is prepared only because the manifest says so.

### The store still applies session rules

`saveExecutionUnlocked` (`session-store.ts:456-551`) checks immutability, reads the previous status, loads the workflow, copies completion outputs (`publishedOutputs`, `:784-818`), writes `execution.json`, appends `execution.*`, `stage.*`, `outputs.published`, and `session.*`, rewrites the manifest, and commits the fold.

`sessionStatusAfterExecution`, `shouldPublishOutputs`, and `publishOutputFiles` live in `outputs.ts:34-123` and `:173-190`. Terminal fields and `latest_decision` are applied in the fold, not written directly by the save. The parent plan's line numbers for those fields are from before the fold landed.

## Decisions already fixed

These come from the parent plan. This phase does not reopen them.

- stdout JSON and exit codes of `session run`, `continue`, `show`, and `list` stay as they are. Warnings go to stderr.
- The on-disk layout only grows. The new file is `workflow.frozen.yaml`.
- v1 sessions stay readable. Their manifests keep the status line and keep being updated. Repair does not rewrite them into schema 2.
- Event first, then `status.json`, for a state change the fold records.
- No per-stage record. `selection.ts` stays on execution order.
- Phase C is two pull requests. The freeze, the schema 2 manifest, and `schema_version` land together. The ledger split is the next pull request and changes no behavior.

## Decisions for this phase

1. **Freeze file.** A workflow session writes `.migent/sessions/<id>/workflow.frozen.yaml` once, inside the create lock, before `session.created`. Agent sessions do not. The wrapper is:

   ```yaml
   source_sha256: <sha256 of the workflow source file, or null>
   workflow:
     schema_version: 1
     id: plan
     constraints: []
     stages: []
     completion: null
     requires: null
   roles:
     planner:
       instructions: []
   targets:
     plan:
       provider: grok
       model: grok-4
       options: {}
   ```

   `workflow` is the mapping `loadWorkflowDocument` already accepts, rebuilt from the parsed document so ignored source keys are dropped. `roles` holds `loadRoleInstructions` for each role a stage names, including an empty list. `targets` holds `resolveStageSpec` for every stage with no CLI override: the merged provider, model, and options. Stage `options` inside `workflow` stay the stage's declared options. Resolved options live only under `targets`.

   Write it with `stringify` from `yaml` and `writeFileAtomic`. Key order is the order above. `source` on the loaded `WorkflowDocument` is the frozen file path.

2. **Hash.** `session.created` `data.hash` becomes the sha256 of the frozen file bytes. Nothing reads the old source-file hash. `source_sha256` inside the freeze is what the warning compares. `workflow.refreshed` carries `hash`, `previous_hash`, and `source_sha256`. The fold ignores `workflow.refreshed`. Repair does not rebuild a missing freeze file.

3. **Which loader wins.** If `workflow.frozen.yaml` exists, session loads use it: `loadWorkflow`, `loadSessionWorkflow`, the workflow load in `executeLocked`, `dispatchNamedStage`, `loadRunStage`, and the role-instruction read in `dispatchExecuteStage`. A session with no freeze file keeps today's live loaders. Deleting the file is that fallback, not a corrupt session.

4. **Overrides.** `resolveFrozenStageTarget` matches `resolveStageTarget`. Both `--provider` and `--model` replace the frozen target and use only the override options. Passing one of the two is the same configuration error as today. An options-only override merges onto the frozen options. `execute.ts` passes no override. `dispatchNamedStage` still honors the request override on top of the frozen target.

5. **Warn, do not switch.** `session continue` and `session run --session` warn on stderr when an existing freeze differs from the live files, then use the freeze. A creating `session run` does not warn. Compare:

   - the workflow source file bytes with `source_sha256`
   - each stage's live `resolveStageSpec` provider, model, and options with `targets`
   - each frozen role's live instructions with `roles`

   A missing or unreadable workflow file warns and still uses the freeze. A comment-only source edit warns because the file bytes differ. Option maps compare with sorted keys.

   Stderr lines, through `log`:

   ```text
   [migent] session <id> is using its frozen workflow. The workflow file differs.
   [migent] session <id> is using its frozen workflow. The workflow file is missing.
   [migent] session <id> is using its frozen workflow. The workflow file cannot be loaded.
   [migent] session <id> is using its frozen workflow. Stage <stage> model differs.
   [migent] session <id> is using its frozen workflow. Role <role> instructions differ.
   ```

6. **`--refresh-workflow`.** Accepted by `session continue` and by `session run` only when `--session` is set. A creating run that passes it exits 2: `--refresh-workflow requires an existing session.` On a session with no freeze file, including every v1 session and every agent session, it exits 2: `Session <id> has no frozen workflow.` On `completed` or `cancelled`, it exits 2 and names the status. It does not adopt the live files into a v1 session.

   When the session is `active`, `blocked`, or `prepared`, the flag runs under the session lock after repair and before dispatch. The live workflow must load. A failure leaves the old freeze in place and exits 2. Success writes the new freeze, appends `workflow.refreshed`, then commits the fold. No warning is printed on that command. The resumed stage uses the new freeze. `session continue` of a prepared session keeps today's rejection; refresh is not a way to start it.

7. **Schema 2 manifests have no status line and are not rewritten.** `schema_version: 2` is written by `createWorkflowSession`, `createPreparedSession`, and `createAgentSession`. Identity fields stay. `replaceManifestStatus` and `rewriteManifestStatus` return immediately when `sessionSchemaVersion` is 2 or more, even if a status line is present. v1 manifests keep today's rewrite. `createSessionFiles` stays a v1 manifest: it runs only when the file is missing, and those sessions are not new schema 2 sessions.

8. **Prepared is an event.** Schema 2 `initialStatus` starts at `active` and does not read the manifest status. `session.created` for a prepared session sets `data.prepared` to `true`. The fold sets `prepared` from that flag. `session.activated` still sets `active`. v1 folds keep reading the manifest status.

9. **Ledger is a move.** The second pull request moves the session-rule decisions into `session-ledger.ts`. Event names, payloads, `status.json`, and manifest rules stay as the first pull request left them. Existing tests pass without new cases.

## Pull requests

These are pull requests 5 and 6 in the parent plan.

1. Schema 2 manifest, frozen workflow, `--refresh-workflow`. Tasks C4, C2, and C1, in that order.
2. `session-ledger.ts`. Task C3. After the first pull request is merged.

## Pull request 1

### C4. Write schema_version 2

`sessionSchemaVersion` already exists. Do not add another helper and do not call `documentVersion`.

- `createWorkflowSession`, `createPreparedSession`, and `createAgentSession` write `schema_version: 2` as the last manifest line.
- A missing or invalid version still reads as 1.
- Add a migrate test that a session directory is unchanged. `migrate.ts` does not grow a session walk.
- Update the schema 2 test patches that look for `status: running` or `status: blocked` in the manifest (`session-fold.test.ts` `markSchema2` and the replace at `:248`; `verify.test.ts:207-210`). New sessions are already schema 2. Those tests keep their status.json assertions.

### C2. Manifest identity only

Do this in the same change as C4. A schema 2 manifest that still has a status line would keep two sources of truth.

- Drop the `status:` line from the three create paths.
- `appendSessionCreated` sets `prepared: true` for `createPreparedSession` only.
- In `applySharedEvent`, `session.created` with `data.prepared === true` sets `status` to `prepared`. Other `session.created` payloads do not change status.
- `initialStatus` uses `active` when `schemaVersion >= 2`. Pass the schema version in, or branch in `foldSchema2` before it fills status from the manifest. `foldV1` still calls `manifestStatusToSession`.
- `replaceManifestStatus` and `rewriteManifestStatus` load the manifest with `readSessionManifest` and return when `schemaVersion >= 2`.
- `docs/sessions.md:37-39`: schema 2 `manifest.yaml` is identity only (`session_id`, workflow id and path, task label, `created_at`, optional `prior_session_id` or `role`, `schema_version`). It has no status. Session status lives in `status.json`. v1 manifests still have the status line and are still updated.
- `task-file.test.ts`: a new prepared manifest contains `schema_version: 2` and does not contain `status:`. After activate, the manifest is byte-for-byte the create text, and `status.json` is `active`. The activate test at `:64` stops expecting `status: running`.

A v1 fixture whose manifest says `prepared` and whose events have no `prepared` flag still folds to `prepared`.

### C1. Frozen workflow and config

Add `session-freeze.ts`. Keep the parser change in `workflow.ts` small.

- Extract `parseWorkflowMapping(data, source)` from `loadWorkflowDocument` (`workflow.ts:154-179`). `loadWorkflowDocument` reads the file and calls it. The freeze loader calls it on the `workflow` mapping. Extra wrapper keys are not passed in.
- `writeWorkflowFreeze(sessionDirectory, workspace, workflow)` resolves roles and targets from the current config, writes `workflow.frozen.yaml`, and returns the file sha256. Call it from `createWorkflowSession` and `createPreparedSession` inside the existing lock, before `appendSessionCreated`. Pass that digest as `hash`.
- `readWorkflowFreeze(sessionDirectory)` returns null when the file is missing. A parse failure throws `ConfigurationError` and names the file. A session that has a broken freeze stops. A session that has no freeze does not.
- `loadFrozenWorkflow` returns the `WorkflowDocument`. `frozenStageTarget(freeze, stageId, override)` implements decision 4. `frozenRoleInstructions(freeze, role)` returns the stored list. An unknown stage or role is the same `Stage not found` or `Missing or invalid roles.<role>` error the live loaders throw.
- Replace the live loads listed in decision 3. `dispatchExecuteStage` takes role instructions from the freeze when the file exists, and passes that workflow into `dispatchNamedStage` so the second load cannot see a newer file. `dispatchNamedStage` takes an optional already-loaded workflow and target. When the caller passes them, it does not load again. When the caller does not, it reads the freeze if present and otherwise keeps today's live load.
- `executeLocked` loads the session workflow after the refresh and warning steps, not before. The object it passes into selection, prompts, and dispatch is the frozen document when the file exists.
- Warning and `--refresh-workflow` follow decisions 5 and 6. Add the flag in `addDispatchOptions` (`program.ts:538-549`) and plumb it through `ExecuteRequest`. Document it in `docs/cli.md` next to `session continue`, in `CHANGELOG.md`, and in the skill template: an edit during a session does not change that session; `--refresh-workflow` adopts the current workflow, models, and role instructions.
- `docs/sessions.md` lists `workflow.frozen.yaml` in the layout. Say that repair does not rebuild it, and that a missing file means the session uses the live workflow and config.

`selection.ts` is unchanged. It already takes a `WorkflowDocument`.

## Pull request 2

### C3. Store and ledger

No behavior change. Do not change event names, event payloads, `status.json` fields, freeze files, or the schema 2 manifest rule.

Add `session-ledger.ts`. Move these decisions there:

- `sessionStatusAfterExecution` for one save (`outputs.ts:34-62` stays the function; the ledger calls it)
- whether the save publishes, and the call to `publishOutputFiles` (`session-store.ts:784-818`)
- the `outputs.published` payload and the `session.<status>` payload, including `sessionChangeReason`
- the manifest status to write, or null when schema 2 or when the v1 line would not change
- `applyTerminal` and the `latest_decision` choice now in `publishLatestExecution` and `applyExecutionSnapshot` (`session-fold.ts:295-315`, `:343-362`, `:386-408`)

`saveExecutionUnlocked` keeps this order:

1. Reject an execution that is already `completed`, `failed`, or `cancelled`.
2. Require the session lock.
3. Read `status.json`.
4. Ask the ledger to publish, when this save publishes, before writing `execution.json`. Publishing still selects sources with `execution_order` strictly below this execution.
5. Write `execution.json`.
6. Append `execution.<status>` and `stage.*`.
7. Append the ledger's `outputs.published` and `session.<status>` events.
8. Rewrite the manifest only when the ledger returns a status.
9. `commitFoldedStatus`.

The fold keeps walking events. It calls the ledger for the session status, terminal fields, and `latest_decision` instead of inlining those assignments. Schema 2 still trusts `data.session_status` on the execution event. v1 still recomputes with `sessionStatusAfterExecution`. Those two results stay equal to today's fold for the existing fixtures.

`SessionStore` keeps locks, atomic writes, synced appends, reads, the freeze read, the fold commit, and the immutability check. Do not export the ledger from `index.ts`.

The existing kernel, CLI, and integration tests pass unchanged. Do not add a behavior test in this pull request.

## Tests

Pull request 1:

- A session whose workflow file and `config.yaml` model change after create still routes and dispatches the frozen stage, provider, model, and role instructions. Stderr contains the workflow-file line and the stage-model line.
- `--refresh-workflow` on that session dispatches the edited route and model, appends `workflow.refreshed`, and leaves `status.json` equal to the fold.
- A session with no freeze file, built as a v1 manifest, still follows the edited workflow.
- `--refresh-workflow` on that v1 session exits 2 and does not write a freeze file.
- `--refresh-workflow` while creating a session exits 2.
- A prepared schema 2 session has no manifest status line, `status.json` is `prepared`, activate leaves the manifest unchanged, and `status.json` becomes `active`.
- `migent migrate` does not modify a session directory.
- Fold equality still holds for the workflow fixtures after a create, a stage, and a refresh.

Pull request 2: the suite above, plus the current kernel and integration suites, with no assertion edits.

## Risks

- `dispatchExecuteStage` and `dispatchNamedStage` both resolve the workflow today. Passing the loaded document into the dispatch stops the second call from observing a file edited mid-command.
- Schema 2 tests that patch `status: running` or `status: blocked` in the manifest fail their setup once those lines are gone. Update the setup in this pull request.
- A refresh that commits the fold must not change `status.json`. `workflow.refreshed` has to be ignored by `applySharedEvent` and `applySchema2Execution`, including `updated_at`.
- The ledger move can drift if schema 2 stops copying `data.session_status` or v1 stops calling `sessionStatusAfterExecution`. Keep both calls. The fold-equality fixtures are the guard.
