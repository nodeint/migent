# Plan: Concurrent stages

Scope: let a workflow run independent branches at the same time, so one task finishes sooner. A workflow declares `concurrency`, the maximum number of executions that run at once. The default is 1. A decision may start several stages, and the session completes when every branch has stopped, not when one named stage decides.

Target example:

```text
implement -> review -+- test -> review-test (revise -> test)
                     +- docs -> review-docs (revise -> docs)
```

`review-test` starts as soon as `test` completes, even while `docs` runs. A `revise` from `review-test` reruns `test` without waiting for the docs branch. The session completes when both reviews approve and nothing runs.

```yaml
schema_version: 2
id: implement
concurrency: 2
stages:
  - id: implement
    role: developer
    depends_on: []
  - id: review
    role: reviewer
    depends_on: [implement]
    decision:
      values: [approved, revise]
      routes:
        approved: [test, docs]
        revise: implement
  - id: test
    role: developer
    depends_on: [review]
  - id: docs
    role: writer
    depends_on: [review]
  - id: review-test
    role: reviewer
    depends_on: [test]
    decision:
      values: [approved, revise]
      routes: { approved: complete, revise: test }
  - id: review-docs
    role: reviewer
    depends_on: [docs]
    decision:
      values: [approved, revise]
      routes: { approved: complete, revise: docs }
outputs:
  - name: implementation
    from_stage: implement
    artifact: implementation.md
```

In scope:

- `packages/kernel/src/workflow.ts`, `selection.ts`, `execute.ts`, `dispatch.ts`, `prompt.ts`, `command-executor.ts`, `verify-runner.ts`, `agent-runner.ts`, `session-store.ts`, `session-fold.ts`, `session-ledger.ts`, `session-repair.ts`, `session-records.ts`, `session-freeze.ts`, `outputs.ts`, `query.ts`, `migration.ts`
- `packages/cli/src/signals.ts`, `display.ts`, `migrate.ts`, `commands/init.ts`, `commands/watch.ts`
- `.migent/config.yaml`, `.migent/workflows/*.yaml`, the `init` presets, `docs/workflows.md`, `docs/sessions.md`, `docs/providers.md`, `CHANGELOG.md`, both copies of `schema-workflow.yaml` and `schema-config.yaml` (`.agents/skills/migent/references/` and `packages/cli/src/templates/migent/references/`)
- the kernel and integration tests named below

`doctor.ts` needs no change: it already reports catalog load errors (`doctor.ts:171-172`). `follow-log.ts` needs no behavior change: it already lists every `executions/*/stream.jsonl` (`follow-log.ts:77-96`), and watch picks up streams created later (`watch.ts:210-215`).

Out of scope is listed at the end.

## Current behavior

### Selection picks exactly one stage

`nextStage` (`selection.ts:24-48`) returns `NextStageError("an execution is still running")` when any snapshot is `running` (`:28-30`). After a routed decision it follows the route of the single latest snapshot (`routedNextStage`, `:203-219`) and returns `Stop("completed")` for a route to `complete` (`:216`). Otherwise it collects `candidateStageIds` (`:221-242`) in declaration order and fails with `ambiguous next stage` (`:45-46`). The assertions are `selection.test.ts:226` and `dispatch.test.ts:321`.

`candidateStageIds` treats a stage with no complete snapshot as eligible (`:230-233`). That includes a stage whose execution is `running`, and a stage whose latest execution is `completed` with `outcomeStatus: "blocked"`, because `latestCompleteByStage` keeps only `complete` outcomes (`:88-99`). Today `nextStage` never reaches that case: it errors on a running snapshot, and a blocked session stops first (`:31`).

The "latest failed -> retry" branch (`:33`), `verifyExhaustedExecution` (`:112-126`), and `revisionStop` (`:181-201`, whole-session read at `:189`) read the latest snapshot of the session.

`stageDispatchError` (`:50-83`) keeps one incoming router, the one with the greatest `executionOrder` (`:72-81`), and refuses a stage that has incoming routers, none completed, and dependencies: "waiting for a routing decision" (`:66-69`). In the example `test` has an incoming route from `review-test`, so `depends_on: [review]` alone never makes it eligible. A route destination is one stage id or `complete` (`StageSpec.routes: Record<string, string>`, `workflow.ts:23`). `latestRouteTo`, `hasLaterRouteTo` (`selection.ts:266`, `:282`), and `prompt.ts:133-144` compare `routes[decision] === stageId`.

Order comparisons treat `executionOrder` as time. Order is assigned when an execution starts (`session-store.ts:724`).

### The execute loop awaits one dispatch at a time

`runExecuteLoop` (`execute.ts:361-405`) reaps orphans, selects, checks `failedStageCount`, `revisionStop`, and `maxDispatches`, then awaits `dispatchExecuteStage`. `runExecuteOnce` (`:319-359`) dispatches the single stage `nextStage` picked. A new session with `--stage` calls `requireEligibleStage` (`:184`). `continue` resets revision baselines only when `nextStage` returns a stage (`:192-202`).

### Orphan reaping raises on a live execution

`loadOrCreate` (`session-store.ts:184`) and the loop (`execute.ts` inside `runExecuteLoop`) call `reapOrphanedExecutions(sessionId, "raise")`. `classifyOrphanedExecution` returns `still-running` when the execution's endpoint is alive (`process-ownership.ts:195-196`), and `raiseReapDecision` throws (`:151-154`). Today reap runs only after the previous dispatch finished.

### Cancellation is consumed by the first reader and returns early

`raiseCancellation` (`command-executor.ts:32-36`) stores one pending error. `throwIfCancelled` takes and clears it (`:38-42`, `:59-62`). `cancelWaiters` already broadcasts the wake-up. `executeLocked` returns as soon as it catches `CancellationRequested` (`execute.ts:268-270`), and `executeNamedWorkflow` releases the session lock in `finally`. Each runner marks its own execution cancelled (`agent-runner.ts:331-338`). The CLI unbind clears only its own flag (`packages/cli/src/signals.ts:21-25`).

### Session status follows the highest-order execution

`saveExecutionUnlocked` stores the session status computed at save time on the execution event (`session-store.ts:572`) and appends `session.<status>` on that execution id when it changes. `planExecutionSave` receives the snapshot list from before this save (`:558`; `execution.json` is written at `:560`) and the session manifest version (`:556`). `publishLatestExecution` (`session-fold.ts:313-335`) copies the highest-order execution's stored status. `foldV1` (`:160-180`) recomputes from the latest execution only. `applyBlockedResume` (`:375-390`) honors a resume event only for that latest execution. `applyTerminalFields` stores one `blocked_by_execution_id` (`session-ledger.ts:128-132`).

`resumeBlockedSession` (`session-store.ts:372-397`) reopens that one id. `reopenCancelledExecution` (`:404-460`) reopens `latestExecution` only. `executeLocked` continues one execution (`execute.ts:221-226`).

`reconcileDrafts` (`session-repair.ts:124-178`) replays executions by order and calls `sessionStatusAfterExecution` with no notion of a sibling still running. `executeLocked` repairs before every run (`execute.ts:139`).

`latest_decision` is the decision of the highest `execution_order` (`session-ledger.ts:88-100`). Watch shows one execution, `latest_execution_id` (`query.ts:74-80`, `packages/cli/src/display.ts:91-98`). Nothing outside the fold reads `current_stage` (`session-fold.ts:238-245`, `:337-344`).

### Completion is one stage and one decision

`completion.stage` and `completion.decision` (`workflow.ts:515-540`) decide completion through `isCompletionDecision` (`outputs.ts:82-100`). `completion.decision: null` accepts any decision of that stage (`:95-98`). `missingCompletionOutputs` (`agent-runner.ts:405-409`) fails the completing execution when an output is missing, through `shouldPublishOutputs` (`outputs.ts:110-122`). `selectSourceExecution` takes sources ordered strictly below the saving execution (`outputs.ts:133`).

`requires.decision` must equal the required workflow's `completion.decision` at load (`workflow.ts:262-283`) and the prior session's decision at run time (`session-records.ts:248-276`). `validateVerifyPaths` (`workflow.ts:612`) checks verify stages against `completion.stage`.

### Schema versions

Config and workflow files share `SCHEMA_VERSION = 1` (`migration.ts:13`), and `requireCurrentSchema` (`packages/cli/src/migrate.ts:28-41`) refuses when any of them differs. `migrateWorkflow` only runs adapter stage steps (`migration.ts:54-58`). `patchWorkflowText` only inserts `schema_version` and rewrites changed stage bodies (`:62-70`). `init` writes config `schema_version: 1` (`commands/init.ts:245`). The session manifest has its own version, already 2 for new sessions (`session-records.ts:113`, `session-fold.ts:76`). `writeWorkflowFreeze` writes `schema_version: 1` and a `completion` block (`session-freeze.ts:245-257`) and round-trips through `parseWorkflowMapping`.

The store writes synchronously inside one process that holds `SessionLock`, so concurrent async runners cannot interleave a file write.

## Decisions

1. **`concurrency`.** Workflow top level, a positive integer. Missing means 1. It is frozen with the workflow. No CLI flag.
2. **Document version 2.** Config and workflow files move together from 1 to 2. The config step changes nothing but the version. The session manifest version is unrelated and stays 2. Every new rule below branches on the frozen workflow's document version, never on the manifest version. Version 1 workflows and the sessions frozen with them keep today's behavior, including the ambiguous-root error.
3. **Fan-out routes.** A route destination is a stage id, `complete`, or a non-empty list of stage ids. `complete` is never in a list. Every listed stage becomes routed by that decision.
4. **Routing per router.** Each incoming router contributes its own latest completed decision. A stage with incoming routers is routed when every router that completed since this stage last completed lists it. `depends_on` stays an additional requirement and is the join list: a stage that depends on two routed branches waits until both completed and both latest decisions list it. This rule replaces the single-router comparison in `stageDispatchError`, `hasLaterRouteTo`, `latestRouteTo`, and `prompt.ts`. A route is not an ordering edge: authors who need a routed stage to wait for its router keep `depends_on`.
5. **Ready set.** `readyStages` returns stages that may run now, in declaration order. It omits a stage whose latest execution is `running`, `blocked`, or verify-exhausted, until `continue` records `session.active` for that execution. A retry-exhausted or revisions-exhausted stage is not startable for the rest of the run.
6. **Start rule.** The scheduler walks the ready set in declaration order against a working set that starts as the running set:
   - a ready stage with another ready stage in its dependency closure is suspended. A suspended stage does not count as ready when deciding whether its upstream stage starts;
   - a stage does not start while a running stage is in its dependency closure, or while it is in a running stage's closure. Running downstream stages finish; they are not cancelled;
   - a stage with `session.resume_from` starts only when the working set is empty, and nothing starts after it in that turn;
   - a started stage joins the working set; the walk stops at `concurrency`.

   A stage that continues its own agent on a later visit is not limited by this rule. Under it, two stages whose order is compared are causally ordered, so `executionOrder` stays a valid clock for them.
7. **In-flight executions are not orphans.** While this run holds the session lock, reap skips executions in the run's in-flight set, in `loadOrCreate` and in the loop.
8. **Session status from the latest execution of each stage.** Older executions of a stage never affect session status. At fold time: any execution `running` -> `active`. Otherwise a stage whose latest execution is blocked -> `blocked`; cancelled -> `cancelled`; otherwise the completion rule (decision 10 for version 2, `isCompletionDecision` for version 1); otherwise `active`. `applyBlockedResume` clears `blocked` when every currently blocked stage has a `session.active` event with `data.from: blocked`. Repair builds its events with the same computation.
9. **Status vocabulary.** `status.json` becomes `blocked`, `cancelled`, or `completed` only through decision 8. `retry_exhausted`, `revisions_exhausted`, `verify_exhausted`, and `dispatch_limit` are stop reasons and exit codes only; the session stays `active`, as today.
10. **Completion is quiescence (version 2).** The session completes when nothing runs, nothing is ready or suspended, no stage is blocked or exhausted, at least one execution completed, and every output resolves. A route to `complete` ends that branch only. A stage with no dependents and no routes ends its branch. `completion` is removed.
11. **Outputs.** `completion.outputs` moves to top-level `outputs`. At completion each output takes the latest complete execution of `from_stage`. The publish snapshot includes the saving execution as `completed` when this save completes it. A missing output at quiescence fails the run with exit 2, leaves the session `active`, and publishes nothing. `continue` reruns the producer.
12. **`requires`.** Only `requires.workflow` remains. It requires a prior session whose status is `completed`. A declining decision that must not satisfy `requires` blocks, or routes to a stage that does not end the branch.
13. **`latest_decision`** stays in the status and CLI output as the decision of the highest-order execution. It is not the session outcome, and docs say so.
14. **Per-branch stop.** A branch that blocks, exhausts verify, exhausts retries, or exhausts revisions stops. Other branches keep starting and finishing stages, and they may keep editing the workspace. The run ends when nothing runs and nothing can start. The exit code and `stop_reason` take the first reason in this order: `blocked`, `verify_exhausted`, `retry_exhausted`, `revisions_exhausted`. `dispatch_limit` stops starting, waits for in-flight stages, then returns. `session list --status blocked` shows the session only after the run settles.
15. **Cancellation.** Ctrl-C signals every runner. The run waits for every in-flight dispatch to settle (`Promise.allSettled`), then returns `cancelled` and releases the lock. `continue` reopens every cancelled execution and continues them with `allSettled`. `continue --once` reopens all of them; `--once` limits only later dispatches.
16. **`--once` and `--stage`.** `--once` dispatches the first ready stage. `--stage` accepts any member of `readyStages`. `continue` resets revision baselines whenever any stage is startable.
17. **`--max-dispatches` counts started executions.**
18. **Workspace conflicts are the workflow author's concern.** Migent does not serialize stages that edit the same files or run `verify` at the same time. When more stages are ready than slots, declaration order is the schedule. Docs say both.
19. **Two roots.** In version 2 they run in declaration order. Version 1 keeps `ambiguous next stage`.

## Tasks

### PR 1: multi-execution plumbing, no behavior change

1. `command-executor.ts`: replace the take-once pending error with a cancelled flag that stays set until reset. `throwIfCancelled` throws without clearing. Reset it in `executeNamedWorkflow`'s `finally` and in `bindCancellationSignals`'s unbind (`signals.ts`). `verify-runner.ts` keeps its calls.
2. `session-store.ts`, `execute.ts`: decision 7. `reapOrphanedExecutions` takes the in-flight set; the store keeps it for `loadOrCreate`.
3. `session-fold.ts`, `session-ledger.ts`, `outputs.ts`: decision 8 for version 1 rules. `planExecutionSave` passes the snapshot list including this save. Replace `current_stage` with `running_stages`, a list in execution order. Keep `blocked_by_execution_id` as the first blocked execution and add `blocked_by_execution_ids`.
4. `session-repair.ts`: build repaired `session.*` events with the decision 8 computation.
5. `session-store.ts`: `resumeBlockedSession` reopens every stage whose latest execution is blocked. `reopenCancelledExecution` becomes `reopenCancelledExecutions`. `execute.ts:221-226` continues them with `allSettled`.
6. `execute.ts`: decision 15's settle-before-return around the catch at `:268-270`.
7. `selection.ts`: add `readyStages` (decision 5). Make retry, `verifyExhaustedExecution`, and `revisionStop` per stage. `nextStage` becomes a wrapper over `readyStages` that keeps today's errors, so behavior does not change.
8. `query.ts`, `display.ts`, `watch.ts`: show every entry of `running_stages`.

### PR 2: document version 2, sequential only

9. `migration.ts`: `SCHEMA_VERSION = 2`. Config step: version only. Workflow step: move `completion.outputs` to `outputs`; drop `completion` and `requires.decision`. Refuse a workflow where a route to `complete` comes from a stage other than `completion.stage`, or, when `completion.decision` is set, uses another decision. Add patch operations to `patchWorkflowText` for a removed top-level key, a new top-level key, and a removed nested key.
10. `workflow.ts`: for version 2 parse `concurrency`, route values as a string or a list, top-level `outputs`, and `requires` without `decision`. `validateVerifyPaths` checks every route to `complete` and every leaf stage. Reject a list route and `concurrency > 1` at load until PR 3.
11. `session-freeze.ts`: freeze the document version, `concurrency`, route lists, and top-level `outputs`. A version 2 workflow round-trips.
12. `selection.ts`, `prompt.ts`: decision 4. The sequential loop follows a one-target route and stops on `complete`.
13. `outputs.ts`, `session-ledger.ts`, `agent-runner.ts`: decisions 10 and 11 for version 2, branching on the frozen workflow's version. `missingCompletionOutputs` checks outputs when this save would complete the session.
14. `session-records.ts`: decision 12.
15. `commands/init.ts`, presets, `.migent/config.yaml`, `.migent/workflows/plan.yaml` and `implement.yaml` in this repository, both copies of `schema-workflow.yaml` and `schema-config.yaml`, `docs/providers.md`.

### PR 3: the scheduler

16. `workflow.ts`: lift the PR 2 load rejection of list routes and `concurrency > 1`.
17. `selection.ts`: add `runnableNow(workflow, ready, running, concurrency): string[]` for decision 6. It is pure.
18. `execute.ts`: replace the body of `runExecuteLoop` with a pool:
    - a map from `executionId` to the dispatch promise, shared with reap (decision 7);
    - each turn: reap, read snapshots, compute `readyStages`, drop stages of stopped branches (decision 14), start `runnableNow`, then `await Promise.race`;
    - when nothing runs and nothing can start, return `completed` (decision 10) or the first stop reason. Suspended or blocked-by-overlap stages are never quiescence;
    - `stages` in the result are in completion order.
19. `execute.ts`: decision 16 in `runExecuteOnce`, `requireEligibleStage` (`:184`), and the baseline reset (`:192-202`).

### Docs

20. `docs/workflows.md`: concurrency, fan-out routes, routing per router and joins, completion by quiescence, top-level `outputs`, `requires`, per-branch stop, declaration order as the schedule, and workspace conflicts. Replace the completion example. `docs/sessions.md`: `running_stages`, `blocked_by_execution_ids`, and what `latest_decision` means. `CHANGELOG.md`.

## Tests

PR 1:
- two concurrent `CommandExecutor` runs both throw after one `raiseCancellation`; the flag is clear after unbind.
- reap with an in-flight sibling does not throw.
- fold: a blocked latest execution of one stage plus a later sibling completion folds to `blocked`; a later complete execution of the blocked stage folds to `active`.
- repair with two overlapping terminal executions and a missing event appends the decision 8 status.
- two blocked stages both resume; two cancelled executions are both reopened.
- every existing test passes unchanged.

PR 2:
- `migration.test.ts`: `plan.yaml` and `implement.yaml` migrate; config migrates to version 2 with no other change; a route to `complete` from another stage or decision is refused.
- `workflow.test.ts`: string and list routes, `complete` inside a list refused, list routes and `concurrency > 1` refused until PR 3, version 1 still loads.
- `session-freeze.test.ts`: a version 2 workflow round-trips.
- migrated `plan` workflow runs to `completed` with the same outputs as today; version 2 two roots run in declaration order; version 1 two roots still error.
- a missing output at quiescence exits 2, publishes nothing, and leaves the session `active`.
- `requires` accepts a `completed` prior session and refuses an `active` one.

PR 3:
- `selection.test.ts`: `runnableNow` suspends a downstream stage when its upstream is ready; runs a `resume_from` stage only alone; does not start a stage twice; `stageDispatchError` with two routers where one decides `fail`.
- `cancel-resume.test.ts`: one SIGINT cancels two runners, both settle before the lock is released; `continue` resumes both.
- `integration/execute.test.ts` with the example workflow, `concurrency: 2`, and a fake provider delay:
  - `test` and `docs` overlap; `review-test` starts while `docs` runs;
  - `review-test: revise` reruns `test` while the docs branch continues;
  - completion only after both reviews approve; outputs published once;
  - `docs` blocks: the test branch completes, exit 1, outputs empty, `continue` runs only `docs`;
  - same turn: `test` completes and `review-docs` routes to `implement`; `review-test` is suspended, `implement` runs, both branches rerun, and the session does not complete early;
  - `--stage` accepts the second ready stage; `continue` with two ready stages does not throw.
- `integration/fixtures/fake-provider.mjs`: a delay knob for the overlap tests.

## Out of scope

- Detecting or preventing file conflicts between stages, including concurrent `verify`.
- Per-provider or per-model limits, and a CLI override of `concurrency`.
- Per-stage `parallel` groups or an explicit `join` key.
- Git worktrees or any per-stage workspace isolation.
- Concurrency across sessions.
