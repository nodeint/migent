# Plan: Core metrics

Scope: capture what each provider turn cost, which CLI and arguments ran it, and which commit it ran on, then derive per-execution and per-session metrics on read. Provider knowledge lives in the adapters. The kernel stores what an adapter captured and asks the same adapter to normalize it. This is the first data layer for choosing roles, models, and workflow shapes from evidence. It records facts. It does not score, rank, or choose.

In scope:

- `packages/kernel/src/adapter.ts`, `agent-runner.ts`, `index.ts`
- a new `packages/kernel/src/metrics.ts`
- `packages/adapters/src/claude-adapter.ts`, `codex-adapter.ts`, `grok-adapter.ts`, `agy-adapter.ts`
- the fixtures already in `packages/adapters/test/fixtures/usage/`
- `packages/cli/src/program.ts`, `packages/cli/src/commands/sessions.ts`
- `docs/sessions.md`, `docs/cli.md`, `docs/providers.md`, `CHANGELOG.md`, both copies of the Migent skill (`.agents/skills/migent/SKILL.md`, `packages/cli/src/templates/migent/SKILL.md`)
- the tests named in each task

Out of scope is listed at the end.

Claims were checked against the current tree. Paths below are current. This plan replaces the first draft, after a review (session `20261020-095248--agent--review-core-metrics-plan`) and a resume probe on 2026-10-20.

## Current behavior

### Usage is dropped with stdout

`runTurn` (`agent-runner.ts:573-626`) runs the provider, calls `adapter.parseResponse(stdout, lastMessageFile)` (`:621`), and removes the temp directory (`:623-625`). Stdout is not stored. `parseResponse` returns only text and the provider agent id. Every adapter ignores the usage its CLI prints:

- Claude reads `result` for text only (`claude-adapter.ts:247-254`).
- Codex reads `thread.started`, `item.completed`, `turn.failed`, `error` (`codex-adapter.ts:206-223`), not `turn.completed`.
- Grok reads `tool_call`, `text`, `end`, `error` (`grok-adapter.ts:314-330`), and takes only `sessionId` from `end`.
- Agy reads `result` for text and conversation id (`agy-adapter.ts:87-93`, `:256-280`).

`AgentAdapter` (`adapter.ts:33-40`) has no usage or version method.

### Turn events are ambiguous

The runner emits `provider.turn_completed` or `provider.turn_failed` after each provider process (`agent-runner.ts:382-385`). Claude, Codex, and Agy also return `provider.turn_failed` from `parseProgressEvent` on a provider error (`claude-adapter.ts:288-291`, `codex-adapter.ts:253-256`, `agy-adapter.ts:316-321`). The runner forwards progress events during the stream (`agent-runner.ts:603-610`). Both land in `events.jsonl`, because only `provider.heartbeat` and `provider.item_*` go to `stream.jsonl` (`session-events.ts:13-15`, `:98-101`). A failed turn can therefore appear twice.

`ProviderEvent.toJson` puts `details` at the top level of the line (`provider-events.ts:74-85`). `appendRecordedEvent` keeps those keys and writes `data: {}` (`session-events.ts:89-97`). A reader finds details at `ParsedEvent.raw.details`, not in `data`.

### Other facts that exist and are not gathered

- `execution.json`: provider, model, profile options, `stage_id`, `stage_attempt`, `execution_order`, `resumes_execution_id`, `agent_id`, status, `created_at`, `completed_at`, `error`, outcome (with `blocker` and `decision`), and for verify stages `turns`, `verify`, `failure_reason` (`session-store.ts:540-544`, `agent-runner.ts:341-355`).
- `options` there is the overridable profile (`agent-runner.ts:86`), not what `buildCommand` passed. Claude adds `permission_mode` inside `buildCommand` (`claude-adapter.ts:222-223`).
- `stage_attempt` increases on every execution of a stage, including a route back (`session-store.ts:725`, `:809-824`). It is not a retry count.
- `session.created` carries `hash`, the bare hex sha256 of the frozen workflow (`session-records.ts:121`, `:168`). Agent sessions have none.
- The kernel's revision limit counts visits against `revision_baselines`, which `session continue` resets (`selection.ts:181-200`, `session-fold.ts:224`).
- No commit, dirty state, or CLI version is recorded anywhere.

### What each provider prints

Two probes on 2026-10-20 used the adapters' output flags without the permission-bypass flags. The second ran three turns in one conversation: fresh, resume, resume. Trimmed output is in `packages/adapters/test/fixtures/usage/<provider>-resume-<n>.jsonl`. Versions: claude 2.1.304, codex-cli 0.163.0, grok 1.0.62, agy 1.4.3.

| Provider | Event | Tokens | Cost | Cache inside input | Three-turn evidence |
| --- | --- | --- | --- | --- | --- |
| claude | last `{"type":"result"}` | per process | `total_cost_usd`, **cumulative per conversation** | no | output 3, 3, 3; cost 0.0439, 0.0798, 0.0842 |
| codex | each `{"type":"turn.completed"}` | **cumulative per thread**, every field | none | **yes** | input 14302, 28623, 42963; cached 0, 14080, 28160; output 5, 10, 15 |
| grok | `{"type":"end"}`, also an earlier `{"type":"usage"}` with the same numbers | per process | `total_cost_usd`, per process | no | cost 0.0071, 0.0032, 0.0032; 240 + 17792 + 29 = `total_tokens` 18061 |
| agy | `{"event":"result"}` `result.usage`; each `step_update` with `state: DONE` and `usage` | `result.usage` **cumulative per conversation**; step usage per process | none | not observable: `cache_read_tokens` was 0 on every turn | result input 6673, 13554, 20643 with `num_turns` 1, 2, 3; step input 6673, 6881, 7089 |

Claude's cost delta for turn 2 (0.0359) matches its turn 2 tokens priced by hand. The turn 3 delta (0.0044) is lower than the same calculation (about 0.008). Claude's cost is a client estimate. Treat it as reported, not billed.

Only claude prints its CLI version in the stream (`claude_code_version` on `system`/`init`). Every CLI answers `--version`.

## Decisions

1. **Adapters own provider knowledge.** An adapter selects the usage-bearing events at run time and returns them unchanged. The same adapter normalizes them at read time. The kernel never names a provider field.

2. **Store raw, derive on read.** The turn event stores the adapter's capture verbatim. There is no `metrics.json`. A normalization fix in an adapter applies to every recorded session. Sessions recorded before this change get rows with `null` usage.

3. **Normalization takes the previous capture.** `normalizeUsage(current, previous)` returns the usage of this process. `previous` is the latest earlier capture in the same session with the same provider and the same provider `agent_id`. A cumulative provider subtracts it. A per-process provider ignores it. A conversation can span executions, because a verify repair and a route back resume the same agent (`agent-runner.ts:538-541`, `dispatch.ts:85-97`).

4. **A cancelled or timed-out turn has no capture.** Stdout is not returned on cancel (`command-executor.ts:109-115`) or timeout (`:170-172`). For a cumulative provider the next turn of that agent absorbs the lost spend through the delta. For a per-process provider it is lost. This is recorded as `uncaptured_turns` on the row.

5. **One runner turn event per process.** The runner's turn event carries `details.turn`. Metrics count only turn events that have it. The progress-path `provider.turn_failed` stays for stderr and is ignored by metrics.

6. **Unknown is `null`. A sum skips it and counts it.** A field the provider did not report is `null`. A total sums the known values and reports, per field, how many turns did not report it. A session that mixes providers with and without cost still has a usable cost total, labeled with its gaps.

7. **Cost is what the provider reports.** `cost_usd` comes from claude and grok only. No price table in this plan.

8. **One meaning per field.** `input_tokens` excludes cache reads. `reasoning_tokens` is reported beside `output_tokens` and is not added to it. Provider `total_tokens` is not used.

## Adapter contract

`adapter.ts`:

```ts
/** Provider-shaped JSON selected from one process's stdout. Stored verbatim. */
export type UsageCapture = Record<string, unknown>;

export interface TurnUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
}

export interface AgentAdapter extends ProviderAdapter {
  // existing members
  captureUsage?(stdout: string): UsageCapture | null;
  normalizeUsage?(current: UsageCapture, previous: UsageCapture | null): TurnUsage;
  versionCommand?(): string[];
  parseVersion?(stdout: string): string | null;
}
```

Export `UsageCapture` and `TurnUsage` from `index.ts`. `normalizeUsage` is pure and never throws for a capture its own `captureUsage` produced. A field that is not a finite number, or a delta below 0, is `null`.

Per adapter:

| Adapter | `captureUsage` returns | `normalizeUsage` |
| --- | --- | --- |
| claude | `{ result: { usage, total_cost_usd, num_turns, duration_ms, duration_api_ms, modelUsage } }` from the last `result` event | tokens from `result.usage`: `input_tokens`, `output_tokens`, `output_tokens_details.thinking_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`. `cost_usd` is `total_cost_usd` minus `previous.result.total_cost_usd`, or the current value when `previous` is `null`. |
| codex | `{ turn_completed: [usage, …] }`, every `turn.completed` usage in order | Take the last entry of current and of previous (zeros when `previous` is `null`). Each field is the difference. `input_tokens` is Δ`input_tokens` − Δ`cached_input_tokens`; `null` if `cached_input_tokens` is missing. `cache_read_tokens` is Δ`cached_input_tokens`, `cache_write_tokens` Δ`cache_write_input_tokens`, `reasoning_tokens` Δ`reasoning_output_tokens`. `cost_usd` is `null`. |
| grok | `{ end: { usage, total_cost_usd, num_turns } }` from the last `end`; if there is no `end`, `{ usage_event: usage }` from the last `usage` event | current only: `input_tokens`, `output_tokens`, `reasoning_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and `total_cost_usd` (`null` for `usage_event`). |
| agy | `{ result: { usage, num_turns, duration_seconds }, steps: [usage, …] }`, the last `result` and every `DONE` `step_update` usage | Sum `steps`: `input_tokens`, `output_tokens`, `thinking_tokens`, `cache_read_tokens`. If `steps` is empty, the difference of `result.usage` from `previous.result.usage`. `cache_write_tokens` and `cost_usd` are `null`. |

`versionCommand` is `[command, "--version"]` for all four. `parseVersion` returns the trimmed first line, or `null` when it is empty.

## Recorded data

On the runner's `provider.turn_completed` and `provider.turn_failed` (`agent-runner.ts:382-385`), `details`:

```json
{
  "turn": 2,
  "agent_id": "eb4659c1-9da3-4a89-a738-a01dc74e9c2c",
  "argv": ["claude", "-p", "--model", "sonnet", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--resume", "eb4659c1-…"],
  "usage": { "result": { "usage": { "…": "…" }, "total_cost_usd": 0.0798 } }
}
```

- `turn` is the runner's turn number in this execution.
- `agent_id` is the provider agent after the turn (`record.agentId` once `:386` has run). Emit after that line, or compute it the same way.
- `argv` is `spec.argv` as built by the adapter. It shows the options and defaults that actually ran. The prompt is never in argv: claude, codex, and agy take stdin, and grok takes a temp file path (`grok-adapter.ts:285-288`).
- `usage` is present only when `captureUsage` returned non-null.

On `provider.stage_started` (`agent-runner.ts:140-144`), `details` adds:

- `cli_version`: from `versionCommand`, run once per provider per `AgentToolRunner` instance and cached. Run it with `spawnProviderSync` (`provider-spawn.ts:48-55`), a 10 second timeout, and `cwd` set to the workspace. A failure stores `null`.
- `git_head` and `git_dirty`: `git rev-parse HEAD` and `git status --porcelain` in the workspace, each with a 10 second timeout. Not a repository, or git missing, stores `null` for both. `.migent/sessions/` is ignored by `.migent/.gitignore`, so session writes do not make the tree dirty.

`continueCancelled` (`agent-runner.ts:176-299`) emits no `stage_started` today and does not add one. A reopened execution keeps the values from its first start.

## Metrics output

`migent session metrics <session> --json` prints one session object. `migent session metrics --json` prints one session object per line, newest first, with the `--workflow`, `--status`, and `--limit` filters of `session list`.

```json
{
  "session_id": "20261020-074828--wave-3",
  "workflow_id": "implement",
  "workflow_hash": "3f9c…",
  "status": "completed",
  "latest_decision": "approved",
  "task_sha256": "a81e…",
  "prior_session_id": "20261019-120000--plan-wave-3",
  "created_at": "2026-10-20T07:48:28.857+00:00",
  "updated_at": "2026-10-20T08:31:02.110+00:00",
  "totals": {
    "executions": 4,
    "wall_seconds": 2553.2,
    "active_seconds": 2190.7,
    "verify_seconds": 312.4,
    "turns": 6,
    "uncaptured_turns": 0,
    "usage": { "input_tokens": 9123, "output_tokens": 40211, "reasoning_tokens": 5120, "cache_read_tokens": 701220, "cache_write_tokens": 33002, "cost_usd": 3.61 },
    "usage_missing": { "input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 2, "cost_usd": 2 },
    "failed_executions": 0,
    "blocked": 0,
    "cancelled": 0,
    "verify_red": 2,
    "revisions": 1,
    "revisions_reset": 0
  },
  "stages": {
    "implement": { "executions": 2, "revisions": 1, "failed": 0, "blocked": 0 },
    "review-work": { "executions": 2, "revisions": 0, "failed": 0, "blocked": 0 }
  },
  "executions": [
    {
      "execution_id": "0001-implement--attempt-01",
      "execution_order": 1,
      "stage_id": "implement",
      "stage_attempt": 1,
      "role": "developer",
      "provider": "claude",
      "model": "sonnet",
      "cli_version": "2.1.304 (Claude Code)",
      "argv": ["claude", "-p", "…"],
      "agent_id": "eb4659c1-…",
      "resumes_execution_id": null,
      "routed_from": null,
      "git_head": "94a6d8a…",
      "git_dirty": false,
      "status": "completed",
      "outcome_status": "complete",
      "decision": null,
      "blocker": null,
      "error": null,
      "failure_reason": null,
      "created_at": "2026-10-20T07:48:28.857+00:00",
      "completed_at": "2026-10-20T08:05:40.002+00:00",
      "wall_seconds": 1031.1,
      "verify_seconds": 312.4,
      "turns": 3,
      "uncaptured_turns": 0,
      "usage": { "input_tokens": 6, "output_tokens": 22010, "reasoning_tokens": 3002, "cache_read_tokens": 440102, "cache_write_tokens": 20011, "cost_usd": 3.42 },
      "usage_missing": { "input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "cost_usd": 0 },
      "verify": { "runs": 3, "red": 2, "first_pass": false, "failed_commands": ["pnpm gate", "pnpm gate"] }
    }
  ]
}
```

Field rules:

- `workflow_hash` is `session.created` `data.hash` as stored, bare hex. `null` for an agent session.
- `task_sha256` and `prior_session_id` come from `status.json`. `null` when absent.
- `role` is the stage's role in the frozen workflow, else the live workflow. An agent session uses the manifest `role`. `null` if neither loads.
- `argv` is from the execution's first runner turn event. `cli_version`, `git_head`, `git_dirty` are from its `provider.stage_started`. Each is `null` when absent.
- `wall_seconds` is `completed_at − created_at`, `null` while running. `verify_seconds` sums each `verify.started` to its next `verify.passed` or `verify.failed` in that execution; an unmatched start adds nothing. `verify` is `null` for a stage without verify commands.
- `turns` counts runner turn events (decision 5). `uncaptured_turns` counts those without `details.usage`, plus `provider.cancelled` events for the execution.
- `usage` sums `normalizeUsage` over the execution's runner turns, with `previous` chosen by decision 3 across the whole session in `seq` order. A provider whose adapter has no `normalizeUsage`, or that is not in the adapter map, yields `null` fields and counts as missing.
- `revisions` on a stage counts completed executions whose `decision` routes to that stage in the frozen routes (else the live workflow). A route to `complete` is not one. It is cumulative across `session continue`. `revisions_reset` counts `revisions.reset` events, so a reader can tell a continued session. `null` when no workflow loads.
- `routed_from` is the latest earlier completed execution whose decision routes to this execution's stage, when no execution of this stage ran between them. A failed retry of a routed visit keeps the same `routed_from`.
- Session `wall_seconds` is the first execution's `created_at` to the latest `completed_at`. `null` with no executions or while one runs. `active_seconds` sums execution `wall_seconds` that are not `null`.

## Tasks

### M1. Contract

Add the types and optional methods above to `adapter.ts`. Export them from `index.ts`. Extend `FakeAdapter` (`packages/kernel/test/support.ts:146`) with settable `captureUsage`, `normalizeUsage`, and `versionCommand` behavior for the runner and metrics tests.

### M2. Adapter capture and normalization

Implement the table in "Adapter contract" in each adapter file.

Tests in each `packages/adapters/test/<provider>-adapter.test.ts`, reading `fixtures/usage/<provider>-resume-<n>.jsonl`:

- `captureUsage` on each of the three turns returns the documented shape.
- `normalizeUsage(turn1, null)`, `(turn2, turn1)`, `(turn3, turn2)` match the probe: claude output 3, 3, 3 and cost about 0.0439, 0.0359, 0.0044; codex input (non-cached) 14302, 241, 260 and output 5, 5, 5; grok cost 0.00705, 0.00325, 0.00322; agy input 6673, 6881, 7089.
- Stdout with no usage event returns `null`. A string or negative field normalizes to `null`. A codex delta below 0 is `null`.
- Grok: a stream with `usage` and no `end` uses `usage_event` and has `cost_usd: null`.
- `parseVersion` on `"codex-cli 0.163.0\n"` returns `"codex-cli 0.163.0"`; on `""` returns `null`.

### M3. Runner records captures

`agent-runner.ts`:

- `runTurn` also returns `spec.argv` and `adapter.captureUsage?.(stdout) ?? null`. A throw from `captureUsage` becomes `null`. Capture never fails a turn.
- The turn emit (`:382-385`) moves after `record.agentId` is updated (`:386`) and passes `{ turn, agent_id, argv, usage? }`.
- `run` adds `cli_version`, `git_head`, `git_dirty` to the `provider.stage_started` details (`:140-144`). The version cache is a field on `AgentToolRunner`.

Tests in `packages/kernel/test/agent-runner.test.ts`:

- a turn with a capture writes `details.usage`, `details.turn`, `details.agent_id`, `details.argv`
- an adapter without `captureUsage` writes no `usage`
- a throwing `captureUsage` still completes the execution
- a verify stage with two red runs writes three runner turn events with turns 1, 2, 3
- an adapter whose progress emits `provider.turn_failed` produces two `provider.turn_failed` lines, and exactly one has `details.turn`
- `stage_started` has `git_head` and `git_dirty: false` in a fresh `git init` temp repo with one commit, `true` after an untracked file, and `null` outside a repository
- the version command runs once for two executions of the same provider in one runner

Tests must not call a real provider CLI (`CONTRIBUTING.md:47`). The version command goes through the fake adapter's command.

### M4. Derive metrics

New `packages/kernel/src/metrics.ts`:

```ts
export function sessionMetrics(
  workspace: string,
  sessionId: string,
  adapters: Record<string, AgentAdapter>,
): Record<string, unknown>;
export function listSessionMetrics(
  workspace: string,
  adapters: Record<string, AgentAdapter>,
  filters: { workflow: string | null; status: string | null; limit: number | null },
): Record<string, unknown>[];
```

- Read only. Do not take the session lock, do not reap, and do not call the follow path (`packages/cli/src/commands/watch.ts:63-69`).
- Read `events.jsonl` and streams through `readParsedEvents` and `streamFiles` (`session-events.ts:105-118`, `:220-238`). Turn details are at `event.raw.details`.
- Read `execution.json` through `readExecutionFile` (`query.ts:47-60`). Load the workflow with `loadFrozenWorkflow`, then the live loader, as `loadRunStage` does (`agent-runner.ts:629-647`).
- A session directory with no `status.json` is skipped by the list, as `listSessionRows` skips it (`query.ts:113-118`). A corrupt `status.json` or `execution.json` prints `{ "session_id": …, "status": "corrupt" }` and nothing else for that session.
- List order and filters match `listSessions`.

Tests in a new `packages/kernel/test/metrics.test.ts`, built with the store helpers and `FakeAdapter`:

- plan → review(revise) → plan → review(approved): `plan.revisions: 1`, the second plan's `routed_from` is the first review, `review.revisions: 0`
- a failed attempt, then success: `failed: 1`, `revisions: 0`
- verify red, red, pass: `verify.red: 2`, `first_pass: false`, two `failed_commands`
- a cumulative fake adapter over two executions that share one agent: the second execution's usage is the delta
- the same adapter after a cancelled turn: the next turn's delta includes the cancelled turn's spend, and `uncaptured_turns` is 1
- two providers, one with cost and one without: totals `cost_usd` is the known sum and `usage_missing.cost_usd` counts the other's turns
- a duplicate progress `provider.turn_failed` does not change `turns`
- a session recorded before this change: usage `null`, missing counts equal to `turns`, everything else present
- no frozen workflow and a deleted workflow file: `revisions: null`, rest present
- a running execution: `completed_at: null`, `wall_seconds: null`, session `wall_seconds: null`

### M5. CLI

`program.ts`, beside `session show`:

```text
migent session metrics <session> --json
migent session metrics --json [--workflow <id>] [--status <status>] [--limit <n>]
```

- Without `--json`, exit 2: `session metrics requires --json.`
- A session with no `events.jsonl`, exit 2: `No events found for session: <id>`, the message `session show` uses (`watch.ts:59-60`).
- Exit 0 otherwise. An empty list prints nothing.
- `commands/sessions.ts` calls `sessionMetrics` or `listSessionMetrics` with `adapterMap()` (`packages/cli/src/provider.ts:17-19`).

Tests in `packages/cli/test/session-group.test.ts`: one object, JSONL for several sessions with `--workflow`, missing `--json`, and an unknown session.

### M6. Docs and skill

- `docs/sessions.md`: a "Metrics" section with the output, the field rules, and decisions 3, 4, and 6 in plain words.
- `docs/cli.md`: the command, flags, and exit codes.
- `docs/providers.md`: the provider table from "What each provider prints", including that claude's cost is a client estimate and agy reports no cache.
- Both `SKILL.md` copies, under "Inspect sessions": `migent session metrics --json` compares runs. Read `usage_missing` and `uncaptured_turns` before comparing totals. `stage_attempt` is not a retry count.
- `CHANGELOG.md`: the command and the new turn and stage-start details.

## Pull requests

1. M1, M2, M3. Captures are recorded. Nothing reads them yet. Land this first so later sessions carry data.
2. M4, M5, M6.

## Out of scope

- Carrying partial stdout out of a cancel or timeout. Decision 4 covers cumulative providers. Per-process providers lose that turn.
- A price table and a priced cost beside the reported one.
- Worktrees, branches, diffs, and scope checks (backlog #2). This plan records the base commit only.
- Structured review findings (backlog #6). Without them there is no defect count, and metrics favor cheap, fast runs. Do not build an automatic model choice on this data alone.
- Kernel budgets (backlog #5), and policy or strategy stamps on `session.created`. These are the next step, before any matrix run.
- Task tags, task features, and outcome tracking from git after a session.
- Aggregation across sessions, a strategy library, or any automatic choice.
- Changes to stdout JSON or exit codes of `session run`, `continue`, `show`, and `list`.
