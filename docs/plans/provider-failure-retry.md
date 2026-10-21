# Plan: Provider failure handling

Scope: classify a finished provider process, stop a failed stage instead of retrying it immediately, and wait in the owning process only when that classification includes an absolute resume time. The decisions below are fixed.

In scope:

- `packages/kernel/src/adapter.ts`, `agent-runner.ts`, `execute.ts`, `selection.ts`, `command-executor.ts`, `dispatch.ts`, `event-kinds.ts`, `provider-events.ts`, `index.ts`, `session-store.ts`, `session-ledger.ts`
- `packages/adapters/src/claude-adapter.ts`, `codex-adapter.ts`, `grok-adapter.ts`, `agy-adapter.ts`, and a Claude fixture under `packages/adapters/test/`
- `packages/cli/src/exits.ts`, `packages/cli/src/program.ts`, `packages/cli/src/commands/execute.ts`, `packages/cli/src/commands/agent.ts`
- `docs/cli.md`, `docs/workflows.md`, `docs/backlogs.md` (the sentence that names `--attempts` as a brake), `CHANGELOG.md`
- both skill copies and both `references/sessions.md` copies: `.agents/skills/migent/` and `packages/cli/src/templates/migent/`
- `.agents/skills/migent/.migent-template.json`, whose `content_sha256` must be regenerated the way `packages/cli/src/commands/skill.ts:113-121` records the bundle digest. Editing `SKILL.md` or `references/sessions.md` without that digest leaves the installed skill stale.
- the tests named in each task

`packages/kernel/src/metrics.ts` is not modified. Decision 12 is covered by a test of the existing capture path.

Out of scope is at the end.

Claims were checked against the current tree. Paths below are current.

## Current behavior

### A non-zero exit is one string

`CommandExecutor.run` returns a pair. Exit 0 is `[stdout, null]`. A non-zero exit is `[stdout, "CLI exited with code N."]` (`command-executor.ts:164-165`). Timeout returns `["", "Sub-agent timed out…"]` with no status (`command-executor.ts:168-170`). Spawn failures return an error string and no status (`command-executor.ts:85`, `:95-98`, `:104-106`). The provider's stderr is inherited by the wrapper (`process-wrapper.ts:179`) and is not stored. `parseResponse` returns only text and an agent id (`adapter.ts:50`).

`runTurn` returns `[responseText, parsedProviderId, invokeError, argv, usage]` (`agent-runner.ts:654`). Stdout and the process status exist only inside `runTurn` (`agent-runner.ts:623-654`). The caller (`agent-runner.ts:375-438`) never sees them. It marks the execution `failed`, appends the text to history, and emits `provider.turn_failed`. A parse failure, a missing artifact, and missing completion outputs take the same `invokeError` path (`agent-runner.ts:407-426`). A verify infra error fails the execution with that error string and no verify reason (`agent-runner.ts:492-496`). Verify exhaustion and a verify-only failure set `failure_reason` to `verify_exhausted` or `verify_failed`.

### The loops never see `RunResult`

`dispatchNamedStage` resumes the latest execution of the stage (`dispatch.ts:62`, `:87-91`). `resultFromRun` copies a fixed field list into `StageDispatchResult` (`dispatch.ts:166-178`). The v1 loop (`execute.ts:653-671`), the v2 pool (`execute.ts:750-775`), and `runExecuteOnce` (`execute.ts:502-545`) read that object. A field left off `resultFromRun` is invisible to them.

### Failed executions are retried immediately

`--attempts` defaults to 3 (`execute.ts:145`). `failedStageCount` counts every `failed` execution of the stage except the two verify reasons (`selection.ts:207-214`). `readyStages` hides a stage once that count reaches the budget (`selection.ts:128`). `stoppedStageIds` does the same (`selection.ts:688-690`). The v1 loop returns `retry_exhausted` (`execute.ts:641-642`). The v2 idle reason does the same (`selection.ts:660-663`). Exit 3 is that stop (`execute.ts:62-71`, `exits.ts:4`). An unknown stop reason falls through to exit 2 (`execute.ts:1060`).

The retry is not a new agent. `dispatchNamedStage` resumes the latest execution of the stage (`dispatch.ts:62`, `:87-91`). `loadOrCreate` copies the conversation into a new execution (`session-store.ts:242-250`). The next prompt is `Continue this stage.` (`selection.ts:263-271`, `prompt.ts:62-71`). There is no backoff. `session continue` does not clear the count.

v1 selection does not know about a resume marker. `nextStage` returns `NextStage` for any failed latest execution and takes no `resumes` argument (`selection.ts:28-38`). The v1 loop is the attempts check after `selectedStage` (`execute.ts:639-642`).

The flag is also read in `packages/cli/src/program.ts:500`, `:532`, `:581`, `:630`, `:714-716`, and `:741-744`. `packages/cli/src/commands/execute.ts:47` passes `maxAttempts`, `:59-66` prints the resume hint for `retry_exhausted`, and `:70` puts exit 3 in `INSPECT_EXIT_CODES`. `failedStageCount` is exported from `packages/kernel/src/index.ts:109`.

### Claude quota is invisible to that loop

`ClaudeAdapter.parseResponse` reads `session_id` at `claude-adapter.ts:243-244`, then assistant text and `result`. It never reads `rate_limit_event`. On `result.is_error` it returns `resultError` text. `parseProgressEvent` turns that into `provider.turn_failed` unless `classifyProviderError` calls it a warning (`claude-adapter.ts:290-294`). `classifyProviderError` only distinguishes the control-plane warning marker (`provider-events.ts:33-41`).

A real `claude` 2.1.306 run on 2026-10-21 exited 1 with empty stderr. The fixture is these three stdout lines, with the `system`/`init` line omitted. `resetsAt` `1792560600` is `2026-10-21T05:30:00.000Z`.

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1792560600,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":1,"resetsAt":1792560600},"seven_day":{"utilization":0.45,"resetsAt":1792947600}}},"session_id":"37a685f1-59ec-44a9-9530-0f66e1098c02"}
{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"You've hit your session limit · resets 12:30pm (Asia/Saigon)"}],"usage":{"input_tokens":0,"output_tokens":0}},"session_id":"37a685f1-59ec-44a9-9530-0f66e1098c02","error":"rate_limit","api_error_status":429,"api_error":"usage_limit_reached"}
{"type":"result","is_error":true,"subtype":"success","api_error_status":429,"api_error":"usage_limit_reached","terminal_reason":"api_error","num_turns":1,"total_cost_usd":0,"result":"You've hit your session limit · resets 12:30pm (Asia/Saigon)","session_id":"37a685f1-59ec-44a9-9530-0f66e1098c02","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}
```

### Cancel, lock, and reap

SIGINT and SIGTERM call `raiseCancellation` (`execute.ts:279-293`). The kernel signal wakes `cancelWaiters` (`command-executor.ts:29-36`, `:43-54`). A cancellation during a provider turn marks that execution `cancelled` (`agent-runner.ts:340-344`). The fold then sets the session to `cancelled` (`outputs.ts:42`). The execute catch returns stop reason `cancelled`, exit 130 (`execute.ts:439-443`). `session continue` on a cancelled session calls `reopenCancelledExecutions` (`execute.ts:321`, `session-store.ts:485-509`). A `failed` execution is not reopened. After the reopen, a non-`--once` continue enters `runExecuteLoop` (`execute.ts:372-379`).

A `failed` workflow execution folds to `active` (`outputs.ts:41-61`). The session lock heartbeat is `unref` (`session-lock.ts:140-142`) and the lock is stale after 30 seconds (`session-lock.ts:10`). `reapOrphanedExecutions` fails an execution that is still `running` after its provider is gone (`session-store.ts:724-736`).

The blocked-resume marker is `session.active` with `data.from: "blocked"` on that execution id. `blockResumed` reads it (`selection.ts:140-148`). The fold applies it in `applyBlockedResume` (`session-fold.ts:409-424`).

Role runs do not use the execute loop. `dispatchAgent` calls `runner.run` once and returns 0, 1, or 6 (`agent.ts:112-128`, `:149-155`). A cancelled role session uses `reopenCancelledExecutions` (`agent.ts:78-107`). The role catch returns 130 (`agent.ts:131-134`).

## Decisions

1. **The adapter classifies one finished process.** `classifyFailure(stdout, exitCode)` returns `quota`, `provider`, or `null`. `quota` carries `message`, `resetAt` (UTC ISO instant or `null`), and `window` (or `null`). `provider` carries `message`. `null` means the process is not a provider failure. The method is optional on `AgentAdapter`. If it is absent, the runner uses the fallback in decision 2. The adapter does not wait, resume, or choose a stop reason.

2. **Who classifies what.** The runner calls `classifyFailure` only when `exitCode` is a number. A numeric non-zero exit uses the adapter result. Exit 0 uses it too, and a `null` result means success. Timeout, a missing executable, a wrapper that did not start, and an unpassable argument have `exitCode: null`. Those are `provider` with the existing error string. The runner does not call `classifyFailure` for them.

   Claude: `rate_limit_info.status === "rejected"` is `quota`. `resetAt` is `resetsAt` of `rateLimitType`, converted from Unix seconds. A later `unifiedWindows` entry is ignored. The human sentence is `message`. `result.is_error === true` with `subtype: "success"` is still a failure, including when the process exit code is 0. A non-null classification on exit 0 sets `invokeError` to that message, so the execution is `failed` rather than `completed`. `session_id` is stored as the agent id (`claude-adapter.ts:243-244`, `agent-runner.ts:391`). Codex, Grok, and Antigravity implement the method and return `provider` with their current error text on a numeric failure, and `null` on exit 0. No quota prose parsing. The kernel stubs in `adapter.ts` use the same fallback as a missing method.

3. **`classifyProviderError` stays a progress label.** It is not the policy input.

4. **Contract failures stay contract failures.** An unparseable outcome, a missing artifact, missing completion outputs, and a verify infra error (`agent-runner.ts:492-496`) are still detected in the runner. They do not arm a wait. Verify red runs, `blocked`, and in-place resume of a cancelled provider turn stay as they are. `failure_reason` remains a reason code. `quota` is the only new code. The CLI message stays in the `error` argument of `saveExecution` (`agent-runner.ts:438`). It is not copied into `failure_reason`.

5. **There is one waiter, and it is not a retry budget.** It runs only when the classification just returned is `quota` with a `resetAt`. It does not scan old executions for a stored time. Before sleeping it persists `failure_reason: quota` and `retry_at` on that execution, status `failed`. The execution must not stay `running`.

6. **The owning process sleeps, then dispatches.** `waitUntil(retryAt, hooks)` lives beside `cancellationSignal` in `command-executor.ts`. `hooks.now` defaults to `Date.now`. `hooks.sleep` defaults to a referenced timer. The default sleep is 30 seconds, matching `PROGRESS_INTERVAL_SEC`. Each slice checks the clock. `cancellationSignal().onCancel` settles the current slice immediately (`command-executor.ts:43-54`). Tests pass a `now` and a `sleep` that resolve without waiting. The lock heartbeat stays `unref`. No cron, no detached process, and `migent service` is not involved.

   `retryAt` is a UTC ISO string. `waitUntil` returns `{ promise, replace(retryAt) }`. `promise` resolves `"reached"` when `Date.now()` is at or past the instant, and `"replaced"` when `replace` is called. `replace` does not throw. Cancellation still throws `CancellationRequested`. On `"replaced"` the caller starts one wait at the new instant for that provider. On `"reached"` it dispatches.

   The v2 pool treats each armed wait as a flight. The idle exits (`execute.ts:780-806`) do not run while a wait flight is unsettled. The pool races wait flights with provider flights (`execute.ts:808`). When a wait's promise fulfills with the instant reached, the pool calls `dispatchExecuteStage` for that stage. It does not consult `readyStages` and it does not write the continue marker.

   The v2 ceiling check is `execute.ts:732-734`. The wait-for-all is `:780-781`. v1 checks the ceiling at `:647`, after `selectedStage` at `:639-640`. If no dispatch remains at the moment quota is classified, the command does not arm a wait. v1 returns `dispatch_limit` before the `Stop("stage_failed")` at `:640`. v2 returns `dispatch_limit` before `version2IdleReason` at `:799`. The quota execution is already saved. Leaving this until the idle reason would report `stage_failed`, because the unmarked quota stage is not schedulable.

   Wait flights are not part of the ceiling's wait-for-all. If a wait is already armed and a later provider flight uses the last dispatch, the command settles each armed wait with `replace` (the promise resolves `"replaced"`, it does not sleep and it does not throw) and returns `dispatch_limit` after the provider flights settle. It does not dispatch the parked stage in that command.

   The v1 loop does the same direct dispatch, with the same ceiling check. The prompt for a stage dispatch is the ordinary one (`stagePromptAlreadyDelivered` / `buildStageResumePrompt`). The dispatch increments `--max-dispatches`. The wait does not.

   The role command loops. While the latest result is `quota` with a `reset_at` that passes the decision 7 guard, it waits, then calls `runner.run` again. `resumeExecutionId` is that quota execution's id. The prompt is the original role prompt (`agent.ts:116-123`). A quota without `reset_at`, a `provider` failure, or the tight-loop guard returns 1. A non-quota completion returns 0. This path does not return 6. Exit 6 stays the existing `resumedMany` path only (`agent.ts:149`). A single result stays 0 or 1 (`agent.ts:155`).

7. **A new failure is classified from the start.** The resumed call does not inherit the previous `retry_at`. A new `quota` with a `resetAt` strictly later than the armed instant replaces that provider's wait. A later quota from a different provider arms a second wait. One provider has at most one wait. A `quota` without `resetAt` stops the branch and the command prints the CLI message. Anything else does not arm a wait.

   The first quota whose `resetAt` is already past does not sleep. It dispatches once. If that dispatch returns quota again and the new `resetAt` is not strictly later, the branch stops with `stage_failed` (a role run returns 1). That is the guard against a tight loop. A strictly later instant arms the wait.

8. **`--attempts` and `retry_exhausted` go away.** A `failed` execution is not ready again inside the command that recorded it, except the direct dispatch after a wait (decision 6).

   The continue marker is one lifecycle event: `session.active`, `executionId` of that failed execution, `data.from: "failed"`. It is the same shape as the blocked marker (`selection.ts:140-148`). `failedResumed` is true when the session is `active` and that event exists for that execution id. `readyStages`, `stoppedStageIds`, `version2IdleReason`, and the v1 selector treat a `failed` latest execution as ready only when `failedResumed` is true for it. Verify reasons stay stopped. A new execution of the stage does not match the old execution id, so the marker does not authorize a second dispatch.

   `resetRevisions` is true only for `action === "continue"` (`packages/cli/src/commands/execute.ts:51`). `session continue --once` and `session continue --stage` go through `action: "stage"` (`packages/cli/src/program.ts:562-573`), so `resetRevisions` is false on those commands. Add `continueFailed` to `ExecuteWorkflowOptions` (`packages/cli/src/commands/execute.ts:12-27`) and to `ExecuteRequest` (`execute.ts:76-90`). `executeWorkflow` copies it at `commands/execute.ts:39-54`. It cannot be derived from `action`, because `session run --once` also uses `action: "stage"` (`commands/execute.ts:31`). `continueSession` sets it at `program.ts:563-573` and `:577-586`. A `session run` leaves it false. The marker write is gated on `continueFailed`, not on `resetRevisions`. `--once` continue does not start resetting revisions.

   The write runs after the revision-reset block (`execute.ts:251-277`) and before the cancelled reopen (`execute.ts:321`). The reset block therefore cannot see the marker and cannot reset `max_revisions` because of it. The existing reset stays.

   When `stageId` is null, continue writes one event per failed non-verify stage. When `stageId` is set, it writes the event only for that stage, and only if its latest execution is that failure.

   `selectedStage` (`execute.ts:491-500`) gains a `resumes` argument and passes it to `nextStage` at `:496`. `version1OnceStage` (`execute.ts:547-552`) and the reset-block call at `:275` gain `workspace` and `sessionId`, and call `blockResumes(workspace, sessionId)` to build that argument. A failed latest execution that is not a verify reason and fails `failedResumed` makes `nextStage` return `Stop("stage_failed")` instead of `NextStage` (`selection.ts:38`). The callers at `execute.ts:275`, `:553`, and `:639` pass resumes from `blockResumes`. The caller at `:483` is inside `requireEligibleStage` (`execute.ts:470-489`), which runs only before a session exists (`execute.ts:244`, empty snapshots). The new `resumes` parameter defaults to empty, and `:483` relies on that default. After the marker write, those callers see the stage as next. `--once` and `--stage` on continue therefore dispatch that stage once and still do not wait.

   For an existing v2 session, `--stage` is checked in `version2OnceStage` (`execute.ts:578-582`), which throws `ConfigurationError` today. It does not go through `requireEligibleStage` (`execute.ts:244` and `:478` run only when a session is created). Before that throw, `version2OnceStage` returns `executeFinal(status, "stage_failed", [])` when the latest execution of the requested stage is `failed`, is not a verify reason, and has no marker. A non-continue `--once` or `--stage` therefore returns `stage_failed` and does not call the agent. With the marker, the stage is schedulable and the command dispatches it.

   A role session has no stage selector. The next `session run --role --session` calls the agent immediately through the existing resume of the latest execution (`agent.ts:81-82`). It does not use the marker and it does not sleep.

9. **Cancel disarms the live wait.** `waitUntil` throws `CancellationRequested`. The quota execution stays `failed` with its recorded `retry_at`. That value is history.

   If no other provider turn is in flight, nothing writes a `cancelled` execution. The session stays `active` (`outputs.ts:41-61`). The execute catch still returns exit 130 (`execute.ts:439-443`). The role catch returns 130 (`agent.ts:131-134`).

   If another provider's turn is in flight, that turn keeps today's rule: the runner marks it `cancelled` (`agent-runner.ts:340-344`) and the fold sets the session to `cancelled` (`outputs.ts:42`). The quota execution is still not rewritten. The next continue reopens the cancelled execution in place, writes the `from: failed` marker for the quota stage, and then dispatches that stage once. It does not sleep until the old `retry_at`.

   A `kill -9` or a reboot leaves the files as they were. After the lock is stale, continue follows the same marker rule and does not sleep.

10. **`--once` and `--stage` do not wait.** A normal single dispatch reaches `runExecuteOnce` (`execute.ts:502-545`, `program.ts:711-716`). A cancelled session never reaches it. `--once` and `--stage` return at `execute.ts:366-371`, which today sets stop reason `stage` and code 1 when any outcome is not complete. After the `VERIFY_FAILED` and `VERIFY_EXHAUSTED` checks at `:359-364`, that site returns stop reason `quota` and exit 8 when any `continued` result has `failure_kind === "quota"`. It does not call `waitUntil`. A non-quota failure there keeps stop reason `stage` and exit 1.

    A blocked continue with `--once` or `--stage` does not call `runExecuteOnce` either. `runExecuteOnce` does not gain a wait-list parameter. When any reopened `continued` item is quota, the command returns `executeFinal(status, "quota", stageJsons)` immediately after the reopen block. It does not dispatch the blocked stage.

    On a non-once command the same list also carries quota from two earlier branches. A blocked continue sets `resumeCancelled` and `reopenLatestCancelled` (`execute.ts:226-227`). Its `continueCancelled` results do not enter the `!reopenLatestCancelled` call at `:372-389`. They fall through to the second `runExecuteLoop` at `:411-437`, and that call receives the wait list. `runExecuteOnce` is not called on this path when the command is `--once` or `--stage`, because those already returned exit 8. A reply dispatch (`execute.ts:304-319`) that returns quota exits 8 at `:398-404` when the command is `--once` or `--stage`. On a non-once command that result is an entry in the wait list passed at `:411-437`. A quota stage has no `from: failed` marker yet, so without that list the loop would stop at `stage_failed`.

    On a non-once command, a quota result from `continueCancelled` (`execute.ts:322-392`) is passed into `runExecuteLoop` (`execute.ts:372-389`) as a new parameter, a list of `{ stageId, provider, resetAt }`. `runVersion2Pool` takes the same list (`execute.ts:600-614` is the current parameter list). The pool starts each entry as a wait flight before selecting stages, so the idle exits stay closed and decision 11's filter applies. The v1 loop waits on that list before its first `selectedStage`. It does not sleep before calling the loop, because that would block stages on other providers. The role command uses the same loop as decision 6 and does not use this parameter.

    A non-continue `--once` or `--stage` whose only eligible stage is a failed execution with no marker does not call the agent. It returns `stage_failed`.

    When a non-once command stops because a stage failed and no wait is armed, the stop reason is `stage_failed` and the exit is 3. `EXECUTE_EXIT_CODES` gains `quota: 8` and `stage_failed: 3`, and loses `retry_exhausted`. Exit 130 stays cancellation. Session status stays `active` for `quota` and `stage_failed`.

    A role run does not use exit 8 or exit 3. The single-result path stays 0 or 1 (`agent.ts:155`). Exit 6 stays the existing `resumedMany` path only (`agent.ts:149`). A role `quota` without `reset_at`, a role `provider` failure, and the tight-loop guard return 1.

11. **One wait per parked provider.** The pool keeps the set of parked provider keys. Before `runnableNow` (`execute.ts:737`) it drops any candidate whose resolved provider is in that set. `runnableNow`'s signature stays unchanged. A stage's provider comes from `frozenStageTarget` or `resolveStageTarget`, the same calls as `execute.ts:876-878`. A stage with no role (`execute.ts:863`) is never parked and is never dropped. Other providers may start, and each may arm its own wait. The pool races those waits. An in-flight stage is not cancelled by the park. A later quota from an in-flight stage on an already parked provider calls `replace` with the later instant. Two sessions on one account do not coordinate.

12. **The quota turn is recorded and adds no usage.** The runner still emits one turn event and still attaches `captureUsage` when it returns a value. A Claude quota turn captures zeros, so totals do not move and `uncaptured_turns` does not increase (`metrics.ts:359-362`). No change to `metrics.ts`.

13. **The wait is visible.** The execute loop and `dispatchAgent`, not the runner, emit `provider.quota` after the execution is saved and before `waitUntil`. They load the execution context with `SessionStore.executionContext(sessionId, executionId)` and call `new ProviderEventReporter(store, context, providerKey, model).emit("provider.quota", summary, { retry_at, provider })`. `emit` writes the record through `ProviderEvent.toJson` (`provider-events.ts:45-91`) and prints to stderr only when the name is in `STDERR_EVENTS` (`provider-events.ts:8-19`, `:95-112`). Add `provider.quota` to `STATUS_PROVIDER_EVENTS` and to `STDERR_EVENTS`. `provider-events.ts` is in scope. The summary includes the UTC ISO instant. `recordProviderEvent` (`session-store.ts:378-384`) only appends and folds. It is not the call that prints. Session status during the wait stays `active`. Do not add a session status.

14. **Do not edit `.migent/workflows/plan.yaml`.** `packages/cli/test/init.test.ts` pins `review-plan` options to `reasoning-effort: high`.

## Tasks

### 1. Return the exit status

Change `CommandExecutor.run` so each return carries `exitCode: number | null` beside the stdout and the error string. The number is the process status at `command-executor.ts:163-165`. It is `null` for timeout (`:168-170`) and for the spawn failures at `:85`, `:95-98`, and `:104-106`. Update the runner's destructure and every test double of `CommandExecutor`.

### 2. Adapter result

Add the result type and optional `classifyFailure(stdout, exitCode: number)` to `AgentAdapter` in `packages/kernel/src/adapter.ts`. The kernel stubs (`adapter.ts` grok and codex stand-ins) do not implement it. The runner fallback covers them.

Implement it on `ClaudeAdapter`, `CodexAdapter`, `GrokAdapter`, and `AgyAdapter`. Claude follows decision 2. The other three return `provider` with the error text they already parse when `exitCode !== 0`, and `null` when `exitCode === 0`.

Inside `runTurn`, after `parseResponse` (`agent-runner.ts:644`), if `exitCode` is a number and `classifyFailure` exists, call it and add the result to the tuple returned at `:654`. If the method is absent and `exitCode` is a non-zero number, the result is `provider` with `CLI exited with code N.` A zero exit with no method is `null`. An `exitCode` of `null` is `provider` with the executor's error string, and the method is not called. When `exitCode` is 0 and the classification is not `null`, set `invokeError` to the classification's `message` before the caller records the turn. Exit 0 with a `null` classification leaves `invokeError` null.

### 3. Persist and surface the result

`extraFields` returns `null` when the stage has no verify (`agent-runner.ts:348-349`), so it cannot carry quota. On `quota`, pass one object `{ ...(extraFields() ?? {}), failure_reason: "quota", retry_at }` to `saveExecution`. A stage with verify keeps `turns` and `verify`. A stage without verify still gets the two quota fields. `extraFields` itself stays null when there is no verify (`agent-runner.ts:348-349`). On `provider` and on contract failures, do not set `failure_reason` from the message. The error argument remains the message, as today.

Add `failure_kind` (`quota`, `provider`, or empty), `reset_at` (string or empty), and `provider` to `RunResult` (`agent-runner.ts:30-41`) and set them on the object returned at `:562-573`. When the classification is `quota`, set the local `failureReason` (`agent-runner.ts:337`) to `"quota"` so `RunResult.failure_reason` matches the saved code. `runResultJson`, the function that ends at `execute.ts:1052`, copies the three fields onto the stage JSON. The continue-cancelled path reads that JSON (`execute.ts:322-392`). The role path reads `RunResult` directly (`agent.ts:101`).

Add the same three values to the `StageDispatchResult` constructor (`dispatch.ts:32-44`) and to `toJson` (`:46-58`). `resultFromRun` (`dispatch.ts:166-178`) copies them from `RunResult`. `dispatch.ts` is in scope for the class and that copy.

### 4. Remove the attempt budget

Delete the `--attempts` option and `attemptsOf`. In `packages/cli/src/program.ts` remove `:500`, `:532`, `:546`, `:568`, `:581`, `:630`, `:714-716`, and `:741-744`. In `packages/cli/src/commands/execute.ts` remove the option read at `:18` and `:35`, and stop passing `maxAttempts` at `:47`.

Remove the `maxAttempts` parameter, not only its uses, from `readyStages` (`selection.ts:108`), `readyOutsideStoppedBranches` and `schedulableStageIds` (`selection.ts:585-611`), `version2IdleReason` (`:635`), and `stoppedStageIds` (`:676`). Removing it shifts `resumes` one position earlier in every caller. In `execute.ts` remove the request field (`:82`), the guard (`:148-149`), the passes at `:269`, `:379`, `:429`, `:606`, `:622`, `:634`, `:681`, `:692`, `:726`, `:793`, `:799`, and `:804`, the comment at `:739`, and the literal `3` at `:575`, `:576`, and `:590` in `version2OnceStage`. Delete the `retry_exhausted` branches (`selection.ts:128`, `:660-663`, `:688-690`). Replace the comments at `session-ledger.ts:98-99` and `selection.ts:66-67`. Both currently describe an attempt cap. The new wording is: a failed stage stays stopped until continue writes `from: failed` for that execution.

Keep `failedStageCount` and its export (`index.ts:109`). No scheduler reads it.

A `failed` latest execution that is not a verify reason is unready unless `failedResumed` is true. Implement `failedResumed` next to `blockResumed`. `stoppedStageIds` adds that stage when the marker is absent. `version2IdleReason` returns `stage_failed` for that stage. It does not take a wait flag. `selectedStage` follows decision 8. Verify reasons still return `verify_exhausted` and `verify_failed`.

The marker write follows decision 8, including `session continue --once` and `session continue --stage`. Add a store method that only appends the `session.active` event with `data.from: "failed"`. It does not rewrite the manifest, does not commit the fold, and does not require the session to be `active`. `resumeBlockedSession` (`session-store.ts:427-463`) is the wrong helper: it throws unless the status is `blocked` (`:431`), then commits the fold and throws unless that fold is `active`. The marker is written while a cancelled session is still `cancelled`. `version2IdleReason` does not learn about waits. Decision 6 already keeps its idle exits from running while a wait flight is open.

`EXECUTE_EXIT_CODES` (`execute.ts:62-71`) replaces `retry_exhausted: 3` with `stage_failed: 3` and adds `quota: 8`. In `packages/cli/src/exits.ts` replace `EXIT_ATTEMPTS` with `EXIT_STAGE_FAILED = 3` and add `EXIT_QUOTA = 8`.

### 5. The waiter

Implement `waitUntil` as decision 6 states. Call it from the v1 loop, the v2 pool, and `dispatchAgent` only for `failure_kind === "quota"` with a non-empty `reset_at`. Then dispatch as decision 6 states.

Before the call, emit `provider.quota` as decision 13 states.

In the v2 pool, each armed wait is a flight, so the idle exits do not fire while one is unsettled. The provider filter is the one in decision 11, applied before `runnableNow`. A later quota from that same provider calls `replace`. A quota from a different provider arms a second wait. One provider has at most one wait.

A `quota` result with an empty `reset_at` does not call `waitUntil`. The branch stops with `stage_failed`, or with `quota` and exit 8 when the command is `--once` or `--stage`.

### 6. Cancel, exits, and the role command

`waitUntil` throws `CancellationRequested` into the existing catches. Do not add a write that sets the quota execution or the session to `cancelled`.

`--once` and `--stage` return from `runExecuteOnce` without `waitUntil`. Quota there is exit 8. Other failures there stay exit 1 and stop reason `stage`. A non-continue `--once` or `--stage` on a failed stage with no marker returns exit 3. A cancelled session's `--once` or `--stage` uses the exit at `execute.ts:366-371`, not `runExecuteOnce`: after the verify checks at `:359-364`, quota in `continued` returns exit 8. A blocked continue with `--once` or `--stage` returns exit 8 from the reopen block when a reopened item is quota, and does not call `runExecuteOnce` or dispatch the blocked stage.

`packages/cli/src/exits.ts`: change the exit 3 sentence in `LOOP_EXITS` to `stage_failed`. Add exit 3 to `STAGE_EXITS` as well: a non-continue `--once` or `--stage` whose failed stage has no marker returns `stage_failed`. Add exit 8 to `LOOP_EXITS` and to `STAGE_EXITS`: `--once` or `--stage` hit quota and did not wait. `packages/cli/src/commands/execute.ts`: the resume hint (`:59-66`) includes `stage_failed` and `quota` instead of `retry_exhausted`. Add 8 to `INSPECT_EXIT_CODES` (`:70`) so the JSON includes `latest_execution_id` and `response_path`.

`dispatchAgent` resolves the prompt once, before any provider call, on the path that has a prompt (`agent.ts:116-123`). Stdin is not read again. The quota re-run calls `runner.run` with that same string and `resumeExecutionId` of the quota execution.

On the `continueCancelled` path (`agent.ts:95-110`) there is no new prompt. Do not call `resolvePrompt`. The re-run calls `runner.run` with `resumeExecutionId` of the quota execution and the content of the last `role: "user"` entry in that execution's conversation (`conversationReadPath`). After the quota turn the history ends with the assistant message, so the prompt is not the last entry. `continueCancelled` reads the last history entry (`agent-runner.ts:216-222`). This re-run does not. Each entry of `resumedMany` (`agent.ts:144-150`) that is quota with `reset_at` enters that same per-execution loop. One wait per provider. Entries that are not quota return as they do today.

On quota without `reset_at`, on `provider`, and on the tight-loop guard, return 1. Do not return 8 or 3. Cancellation from `waitUntil` still returns 130. A single result does not gain an exit 6.

### 7. Docs

Update `docs/cli.md`, `docs/workflows.md`, the `--attempts` brake sentence in `docs/backlogs.md`, `CHANGELOG.md`, both `SKILL.md` copies, and both `references/sessions.md` copies. Remove `--attempts` and `retry_exhausted`. Document exit 3 as `stage_failed`, exit 8 as `quota` for `--once` and `--stage`, and exit 130 during a wait as a disarmed timer. State that continue then runs the stage and does not sleep until the old `retry_at`. State that a single role result uses 0, 1, and 130, and that exit 6 remains only the existing `resumedMany` path.

## Tests

Temporary directories. No real provider CLI.

- Claude fixture in `packages/adapters/test/`, copied from the three lines in Current behavior. Assert `resetAt` `2026-10-21T05:30:00.000Z` and `window` `five_hour`. A non-zero exit without `rate_limit_event` is `provider`. An exit-0 fixture with `is_error: true` and no `rate_limit_event` is `provider`, and the runner records the execution `failed`. Codex, Grok, and Agy: numeric failure is `provider`, exit 0 is `null`. A stage with no verify still persists `failure_reason: quota` and `retry_at`.
- `waitUntil` with an injected `now` and `sleep`: a past instant resolves `"reached"` without a delay; a future instant plus cancellation throws `CancellationRequested`; `replace` resolves `"replaced"` and does not throw. The stderr line from `provider.quota` contains the ISO instant.
- A `provider` failure does not call `waitUntil` and does not dispatch that stage again. Continue writes `from: failed` and dispatches once. A second failure stops with `stage_failed` and exit 3.
- A quota `reset_at` in the past dispatches once more in the same command, and that dispatch counts toward `--max-dispatches`. The wait does not. A second quota whose `reset_at` is not later stops with `stage_failed` and does not dispatch again. A quota with an empty `reset_at` stops with `stage_failed`.
- The parked stage is the only remaining work: the command does not return `stage_failed` while the wait flight is unsettled, and it dispatches after the injected clock passes.
- No dispatches remain when quota is classified: the command returns `dispatch_limit` and does not call `waitUntil`. A wait already armed, followed by a provider flight that uses the last dispatch, settles the wait with `replace` and returns `dispatch_limit` without sleeping and without dispatching the parked stage.
- `--once` and `--stage` on quota exit 8, write `retry_at`, include `response_path`, and do not call `waitUntil`. `session continue --once` and `session continue --stage` on a failed stage dispatch once and do not wait. A non-continue `--once` or `--stage` on that failed stage does not call the agent and returns `stage_failed`.
- Provider B returns quota while A is parked: two waits, and a stage on B does not start until B's instant. An in-flight stage on A that returns a later `resetAt` calls `replace`.
- `continueCancelled` returning quota with `reset_at` on a non-once v2 command passes that wait into the pool. A ready stage on another provider starts during the wait. On v1 the loop waits before its first selection. On `--once` or `--stage` the command exits 8 and does not wait.
- A reply dispatch that returns quota exits 8 on `--once` and `--stage`. On a non-once command it is a wait flight, and the loop does not stop at `stage_failed` first.
- A blocked continue whose reopened sibling returns quota passes that wait into the call at `execute.ts:411-437` when the command is not `--once` or `--stage`. On `--once` or `--stage` the command returns exit 8 from the reopen block and does not call `runner.run` for the blocked stage. The fold does not treat `from: failed` as a blocked resume (`session-fold.ts:420-421`), so the marker does not change session status. Selection reads the event itself.
- Cancel during `waitUntil` with nothing else in flight: exit 130, session `active`, execution `failed`. The next continue dispatches and does not call `reopenCancelledExecutions`.
- Cancel during `waitUntil` while another provider's stage is in flight: that stage's execution is `cancelled`, the session is `cancelled`, the quota execution stays `failed`. Continue reopens the cancelled execution and dispatches the quota stage once, and does not call `waitUntil`.
- Two ready stages on the parked provider: the second does not start. A ready stage on another provider may start. An in-flight stage on the parked provider that returns a later `resetAt` moves the armed instant. One `waitUntil` is in force.
- The quota execution has one runner turn event whose captured usage is zeros, and the metrics row's `uncaptured_turns` does not include it. `provider.quota` is in `STATUS_PROVIDER_EVENTS` and names that execution.
- A verify infra failure (`agent-runner.ts:492-496`) and a timeout end as `stage_failed` with no `waitUntil`.
- Role: quota with a future `reset_at` waits and calls `runner.run` again with that execution id and the original prompt. A second quota whose `reset_at` is not later returns 1 without another call. Quota without `reset_at` and a `provider` failure return 1. Cancel during the role wait returns 130. A quota result from `continueCancelled` re-runs with the last `role: "user"` history entry, and the test asserts `runner.run` received that string. A single verify-exhausted role result still returns 1, not 6.
- Replace the old budget assertions. Do not leave a test that passes `--attempts` or expects `retry_exhausted`:
  - `packages/cli/test/run.test.ts:491-495` expects `stage_failed` after one provider failure. `:498-505` (`session continue --once`) dispatches that stage once and does not wait. `:517-525` expects the same one-failure stop, and a continue that dispatches once.
  - `run.test.ts:533-538` and `:612-617` expect unknown-flag or "cannot be combined" behavior to disappear with the flag. Delete those tests.
  - `run.test.ts:939` and `:952` stop expecting `--attempts` in help text.
  - `packages/cli/test/dx.test.ts:171` drops the `--attempts` argv from the `--once` rejection case. The other two argv in that test stay.
  - `packages/kernel/test/verify.test.ts:928` expects one provider call and `stage_failed` in that command. Delete the assertions that `calls[1]` exists and that `snapshots[1]` resumes `snapshots[0]` (`:952-958`). A following `executeNamedWorkflow` with `continueFailed: true` keeps the resume-same-agent assertion. `:913` expects one call and `stage_failed` with no wait. Delete the assertions that `adapter.calls` has length 2 and that `snapshots[1]` resumes `snapshots[0]` (`:919-925`). A verify-exhausted failure is still `verify_exhausted`. Kernel tests that continue a failed stage pass `continueFailed: true`. `resetRevisions: true` alone does not. Drop `maxAttempts` from the calls at `:142`, `:149`, `:176`, `:182`, `:447`, `:451`, `:465`, `:483`, `:486`, `:502`, `:516`, `:530`, `:875`, `:877`, `:917`, and `:951`.
  - `integration/execute.test.ts:154` ("a bad response is retried and the workflow completes") expects one failure and `stage_failed`, not a later `completed` in the same command. The other `--attempts` cases in that file expect `stage_failed` after one failure.
  - `packages/kernel/test/selection.test.ts` keeps `failedStageCount` as a counter test. Remove the positional `3` before `resumes` at `:245`, `:246`, `:611`, and `:612`. `:164` expects `Stop("stage_failed")` for a failed latest with no marker, and `NextStage` once a `from: failed` marker is present. Add the same pair as a `readyStages` case.
  - `packages/kernel/test/dispatch.test.ts:280` ("failed latest retries that stage") expects `Stop("stage_failed")` with no marker and `NextStage` with a `from: failed` marker.
  - `integration/execute.test.ts` cases that pass `--attempts` and expect `retry_exhausted` expect `stage_failed` after one failure.
- `packages/cli/test/init.test.ts` still pins `.migent/workflows/plan.yaml`. Do not edit that workflow.

## Out of scope

- A cross-session lock for one provider account.
- Quota parsing for Codex, Grok, or Antigravity beyond `provider` / `null`.
- A `retries` field on a stage or a workflow.
- A guessed window, or parsing `12:30pm (Asia/Saigon)`.
- Enabling Claude overage.
- Changing `max_verify`, `max_revisions`, `blocked`, or in-place resume of a cancelled provider turn.
- A new session status.
- Editing `metrics.ts` or historical plans under `docs/plans/` other than this file.
