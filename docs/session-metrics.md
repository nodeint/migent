# Session metrics

Metrics summarize time, usage, verification, and revisions for a completed workflow session. For the session directory and `status.json`, see [Sessions](sessions.md).

```bash
migent session metrics <session-id> --json
migent session metrics --json
migent session metrics --json --workflow <id> --status completed --limit 10
```

`session metrics` prints `metrics.json`, written when a workflow session
becomes `completed`. The command reads that file. It does not take the session lock
and does not change files. One session is one JSON object. A list is
one object per line, newest first, and includes only sessions that have the
file. `--workflow`, `--status`, and `--limit` filter those rows. `--json` is
required. A session with no `metrics.json` exits 2 with
`No metrics for session: <id>. Metrics are recorded when a workflow session completes.`
A file that is not a JSON object exits 2 with
`metrics.json for session <id> is not valid JSON.` and stays in place. An
empty list prints nothing and exits 0. A session that is not `completed` has
no file and does not appear.

```json
{
  "session_id": "20261020-074828--wave-3",
  "workflow_id": "implement",
  "workflow_hash": "3f9c",
  "status": "completed",
  "latest_decision": "approved",
  "task_sha256": "a81e",
  "prior_session_id": "20261019-120000--plan-wave-3",
  "created_at": "2026-10-20T07:48:28.857+00:00",
  "updated_at": "2026-10-20T08:31:02.110+00:00",
  "totals": {
    "executions": 4,
    "skipped": 0,
    "wall_seconds": 2553.2,
    "active_seconds": 2190.7,
    "verify_seconds": 312.4,
    "turns": 6,
    "uncaptured_turns": 0,
    "usage": {
      "input_tokens": 9123,
      "output_tokens": 40211,
      "reasoning_tokens": 5120,
      "cache_read_tokens": 701220,
      "cache_write_tokens": 33002,
      "cost_usd": 3.61
    },
    "usage_missing": {
      "input_tokens": 0,
      "output_tokens": 0,
      "reasoning_tokens": 0,
      "cache_read_tokens": 0,
      "cache_write_tokens": 2,
      "cost_usd": 2
    },
    "cost_partial": true,
    "failed_executions": 0,
    "blocked": 0,
    "cancelled": 0,
    "verify_red": 2,
    "revisions": 1,
    "revisions_reset": 0
  },
  "stages": {
    "implement": { "executions": 2, "skipped": 0, "revisions": 1, "failed": 0, "blocked": 0 },
    "review_work": { "executions": 2, "skipped": 0, "revisions": 0, "failed": 0, "blocked": 0 }
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
      "argv": ["claude", "-p"],
      "agent_id": "eb4659c1",
      "resumes_execution_id": null,
      "routed_from": null,
      "git_head": "94a6d8a",
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
      "usage": {
        "input_tokens": 6,
        "output_tokens": 22010,
        "reasoning_tokens": 3002,
        "cache_read_tokens": 440102,
        "cache_write_tokens": 20011,
        "cost_usd": 3.42
      },
      "usage_missing": {
        "input_tokens": 0,
        "output_tokens": 0,
        "reasoning_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "cost_usd": 0
      },
      "verify": {
        "runs": 3,
        "red": 2,
        "first_pass": false,
        "failed_commands": ["pnpm gate", "pnpm gate"]
      }
    }
  ]
}
```

`verify` is null when the stage has no verify commands and no verify events.

A `run_when` skip stays in `executions[]` with status `skipped`, null `provider`
and `model`, zero turns, blank usage, `verify: null`, and a `skip` object. `skip`
is null on every other row. `totals.executions` and a stage's `executions` do not
count skips; `totals.skipped` and the stage's `skipped` do. A stage that only
skipped is still listed.

`workflow_hash` is the bare hex hash on `session.created`, or the start-time `handoff.bound` event for a prepared session. It is null for an
agent session. `task_sha256` and `prior_session_id` come from `status.json`.
`role` is the stage role in the frozen workflow, otherwise the live workflow.
An agent session uses the manifest role. `stage_attempt` counts every execution
of a stage, including a route back. It is not a retry count.

The adapter capture and normalization contract is documented in
[Adapters](adpaters.md#failures-and-usage).

Usage is stored raw on the runner's turn event. When a workflow session
becomes `completed`, Migent normalizes those captures and writes `metrics.json`. A
later change to an provider does not change that file. The previous capture is
the latest earlier one in the same session with the same provider and the same
provider agent id. A cumulative provider
subtracts it. A per-process provider ignores it. A conversation can span
executions, because a verify repair and a route back resume the same agent.

A cancelled or timed-out turn has no capture. For a cumulative provider the
next turn of that agent absorbs the lost spend through the delta. For a
per-process provider that spend is gone. `uncaptured_turns` counts runner turns
with no usage plus `provider.cancelled` events.

A field the provider did not report is null. A total sums the known values and
`usage_missing` counts, per field, how many turns did not report it. A session
that mixes providers with and without cost still has a usable cost total.
`input_tokens` excludes cache reads. `reasoning_tokens` sits beside
`output_tokens` and is not added to it. `cost_usd` is only what claude, grok, and opencode
report. There is no price table, so a codex or agy execution adds to
`usage_missing.cost_usd` and nothing to the cost total. `totals.cost_partial` is
true when some turns reported a cost and others did not, so `totals.usage.cost_usd`
understates the session cost.

`wall_seconds` is `completed_at` minus `created_at`, null while that execution
is running. The session wall runs from the first execution's `created_at` to
the latest `completed_at`, and is null when any execution is still running.
`active_seconds` sums the execution walls that are known. `verify_seconds` sums
each `verify.started` to its next `verify.passed` or `verify.failed`. An
unmatched start adds nothing.

`revisions` on a stage counts completed executions whose decision routes to
that stage. A route to `complete` is not one. The count is cumulative across
`session continue`. `revisions_reset` counts `revisions.reset` events, so a
continued session is visible. Both revision fields are null when no workflow
loads. `routed_from` is the latest earlier completed execution whose decision
routes to this stage, when no completed execution of this stage sits between
them. A failed retry of that visit keeps the same `routed_from`.

A turn with no capture still counts. Its usage fields are null and
`usage_missing` includes it. A session completed before `metrics.json` existed
has no metrics. The command does not build them.
