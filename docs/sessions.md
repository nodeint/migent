# Sessions and workflow composition

Migent stores local execution state under `.migent/sessions/`. A session
records stage executions, provider events, decisions, artifacts, and published
outputs.

Do not commit this directory. Commit `.migent/config.yaml` and
`.migent/workflows/` instead. `.migent/config.local.yaml` is a per-machine
override and stays uncommitted.

## On-disk layout

Each run has its own directory, named by its session ID. A new session id is a
UUID. `manifest.yaml` also records `title`. A workflow or role session sets
`title` to its one-line task. `session prepare` sets `title` to the text you
pass. The title is for display, so spaces and capitals stay. A session written by an older Migent has no `title`. List and
show use `session_id` for that session.

```text
.migent/sessions/<session-id>/
├── manifest.yaml
├── workflow.frozen.yaml                  # pinned workflow, roles, and stage targets
├── status.json
├── task.md                               # task body; written before the first stage
├── events.jsonl
├── session.lock                          # present only while a process is running the session
├── cancel.requested                      # temporary; written by `session cancel`, removed by the running process
├── outputs/                              # present after outputs are published
│   └── <output-name>
└── executions/
    └── <order>-<stage-id>--attempt-<n>/
        ├── execution.json
        ├── stream.jsonl                  # provider item traces and provider heartbeats
        ├── conversation.json             # provider conversation checkpoint
        ├── prompt.md
        ├── task.md                       # copy of the session task at dispatch
        ├── response.md                   # present after a response is saved
        └── artifacts/
            └── <stage artifact files>
```

The session-level files have distinct purposes:

- `manifest.yaml` on a schema 2 session is identity only: `session_id`, an
  optional `title`, the workflow id and path, the task label, `created_at`, an
  optional `prior_session_id` or `role`, and `schema_version`. A prepared session
  has a title and no task label. The task body is `task.md`. The manifest has no status line.
  Status lives in `status.json`. A v1 manifest still has a `status` line, and
  that line is still updated. An ad hoc agent session records its role; a
  workflow with `requires` records its prerequisite as `prior_session_id`.
- `workflow.frozen.yaml` pins the workflow, role instructions, and resolved
  stage targets when a workflow session is created. `session continue` and
  `session run --session` keep using that copy when the live files change, and
  warn on stderr. `--refresh-workflow` replaces it. A missing file means the
  session uses the live workflow and config. Repair does not rebuild it.
  Agent sessions do not have this file.
- `task.md` is the task body. A one-line `session run --workflow --task` writes
  that sentence here. A prepared session leaves the file for you to write, along with any
  other files that belong next to it. Stage prompts name this path and the
  session directory. They do not include the task text. The first dispatch
  records a hash of `task.md`. A later change stops the next dispatch.
- `status.json` is the current, machine-readable session snapshot. It includes
  the latest execution and stage state, and records decisions, blockers, and
  published outputs when applicable. `session show` reads this file.
  `running_stages` lists each running execution in execution order. Each entry
  has `execution_id`, `stage_id`, `provider`, `event`, `summary`, and
  `updated_at`. The field is absent when nothing is running.
  `blocked_by_execution_id` is the first blocked execution.
  `blocked_by_execution_ids` lists every blocked execution.
  `latest_decision` is the decision of the highest-order execution. It is not
  the session outcome: a later stage with no decision leaves the earlier
  decision in place, and an approved sibling does not clear a blocked stage.
- `events.jsonl` is the append-only session log. Each line is one JSON object
  with `v`, `seq`, `event`, `timestamp`, and `data`. Lines written by an older
  Migent have no `v` and are read as version 1. `seq` increases by one for each
  complete line in this file and in every `stream.jsonl`. `session show` can
  print a prepared session before the first stage. `session follow --cursor`
  is a byte offset into this file. Stream lines are matched by timestamp.
- `executions/<id>/stream.jsonl` holds `provider.item_*` and `provider.heartbeat`
  for that execution. Other provider events, including `verify.heartbeat`, stay
  in `events.jsonl`.
- `executions/` contains one record for every stage attempt. A completed or
  failed execution record is immutable. `session continue` reopens a cancelled
  execution in place; the cancelled event stays in the log. Execution directory
  names are ordered, for example `0002-review--attempt-01`.
- `outputs/` contains the artifacts named by the workflow. A version 2 workflow
  copies top-level `outputs` when the run is quiet and every artifact resolves.
  A version 1 workflow still copies `completion.outputs` when the completion
  stage makes its decision. The directory is created only then, and only when
  every selected artifact is non-empty.

Each execution directory contains:

- `execution.json`: execution identity, order, stage and attempt, provider and
  model, lifecycle status, timestamps, and the parsed stage outcome. A stage
  with no role records `kind: verify`, and `provider` and `model` are null.
- `turns/NN/`: written when a stage runs `verify`. A role stage holds
  `response.md`, `outcome.json` for a complete turn, `verify.md`, and
  `commands/MM.log`. A stage with no role writes `turns/01/verify.md` and
  `turns/01/commands/MM.log` and does not write a model response.
  `execution.json` for a role stage also records `turns`, `verify` (`runs`,
  `red`, `max_verify`, `last_result`, `last_report`), and `failure_reason`
  (`verify_exhausted`). A stage with no role records `failure_reason:
  verify_failed` when the list fails.
- `conversation.json`: provider conversation checkpoint used when resuming a
  provider session. It stores the provider and model, native agent ID, options
  setting, lifecycle status, and fallback message history. A stage with no
  role does not write this file. This is separate from the Migent
  session-level `status.json`.
- `prompt.md` and `response.md`: the exact prompt sent for the attempt and the
  response saved from the provider. A stage with no role writes neither file.
  A later attempt that continues the same stage's provider agent records the
  continuation prompt. An attempt that continues a `session.resume_from`
  dependency records the full stage prompt. `task.md` in this directory is a
  copy of the session task at the moment the execution was created.
- `artifacts/`: files written by that stage. These are per-attempt working
  artifacts; only explicitly configured outputs are copied to the
  session-level `outputs/` directory.

These files are Migent's resumable local state. Before the first stage of a
prepared session, write `task.md` and files next to it. Do not edit
`manifest.yaml`, `status.json`, `events.jsonl`, or `executions/` by hand.
Prefer the CLI commands below for inspection and automation.

Older executions may contain the former name `session.json`. Migent still
reads that file when resuming, but all new checkpoints are written as
`conversation.json`.

## Published outputs

A published output is copied from a successful stage artifact to
`outputs/<artifact-file>`, keeping the artifact name and its suffix. A version 2
workflow names those artifacts at the top level and publishes them once, when
the session completes:

```yaml
outputs:
  - name: plan
    from_stage: plan
    artifact: plan.md
```

A version 1 workflow still uses `completion.outputs` and publishes when the
completion stage makes its decision. Either form publishes:

```text
.migent/sessions/<session-id>/outputs/plan.md
```

`status.json` records both the relative path and provenance of the published
file:

```json
{
  "outputs": {
    "plan": {
      "path": "outputs/plan.md",
      "source_execution_id": "0001-plan--attempt-01",
      "published_by_execution_id": "0002-review-plan--attempt-01"
    }
  }
}
```

`source_execution_id` identifies the attempt that produced the artifact.
`published_by_execution_id` identifies the execution that published it: the
completion stage on a version 1 workflow, or the execution that made the run
quiet on a version 2 workflow.

## Inspect and resume

```bash
migent session list
migent session list --latest --json
migent session show <session-id>
migent session follow <session-id>
migent session continue <session-id>
migent session continue <session-id> --once
migent session repair <session-id>
```

`session list` lists recorded runs, newest first. `--workflow`, `--status`, and
`--limit` narrow that list. `--latest` prints the newest match. `session show
<session-id>` prints a snapshot. `--json` omits the task text from the list
and the snapshot. `session follow` follows execution events until a signal, or
until the session stops when `--exit-when-done` is set. `session continue`
resumes an active workflow session from its recorded state and resets revision
counts. A stage that failed `verify` with no role runs that list again in a
new execution and does not open a provider. A blocked session is resumed the
same way: continue dispatches that stage again, and the new prompt includes
the blocker and the previous response.
`session continue <session-id> --reply "<reply>"` uses the reply as that prompt
body instead. `--reply-file <path>` reads it from a file. When more than one
stage is blocked, `--stage` selects the stage. The other blocked stages stay
blocked.
A cancelled session is resumed on that same execution. `session continue`
does this for a role session too. A cancelled role execution sends a cut-off
provider turn again, or reruns verify when the reply was already saved. A
cancelled stage with no role reruns its verify list in place and does not open
a provider. An active role session sends its last prompt again. `--reply` on
a role session is the next user turn. A completed role session stays stopped
unless `--reply` is set.
`completed` sessions stay stopped. `session continue --once`
advances one stage and does not reset revision counts.

A session with status `prepared` is not resumed by `session continue`. Write
`task.md`, then run `migent session run --session <session-id> --workflow <workflow>`.

`session repair <session-id>` rebuilds `status.json` from the session directory
and takes the session lock. `session continue` does the same rebuild before it
dispatches. Neither command replaces a parsed `status.json` when that would drop
`workflow_id`, `task_sha256`, or output provenance. When a v1 `status.json` is
destroyed, the task hash and output provenance cannot be recovered.
`session repair <session-id> --accept-task` is the only way past that file. It
stores the hash of the current `task.md`, keeps any provenance map that still
parsed, and adds a path-only row for an `outputs/` file the map does not name.
It does not leave `task_sha256` empty. `session continue` does not accept the flag.
Repair does not rebuild a missing `workflow.frozen.yaml`. Without that file the
session uses the live workflow and config.

## Metrics

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

`workflow_hash` is the bare hex hash on `session.created`. It is null for an
agent session. `task_sha256` and `prior_session_id` come from `status.json`.
`role` is the stage role in the frozen workflow, otherwise the live workflow.
An agent session uses the manifest role. `stage_attempt` counts every execution
of a stage, including a route back. It is not a retry count.

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
report. There is no price table.

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

## Artifact dependency versus provider-session resume

`depends_on` gives a stage the output of an upstream stage:

```yaml
depends_on: [plan]
```

`session.resume_from` additionally continues the provider's prior conversational
session instead of starting a new one:

```yaml
depends_on: [plan]
session:
  resume_from: plan
```

The resumed stage therefore receives both the declared upstream context and the
provider's conversation history. `resume_from` must name one of the stage's
dependencies.

A stage keeps one provider agent for every visit. The next execution continues
that agent when the stage runs again, including a failed attempt, a blocked
result, a verify repair, a route back, and a newer dependency. A route back's
prompt points at the routing stage's response and the previous artifact.

`session.resume_from` is the exception. The stage continues the named
dependency's provider agent instead of keeping its own. That applies on the
first visit, and on a later visit that was not routed back. A verify repair
and a failed retry of a routed visit continue the execution already in
progress.

## Reusable workflow boundaries

One workflow can require an approved run of another. This lets teams separate
reusable processes—for example, plan approval from implementation:

```yaml
id: implement
requires:
  workflow: plan
```

`requires` has no decision. The prior session must be `completed`. A declining
decision that must not satisfy `requires` blocks, or routes to a stage that
does not end the branch.

Start it with the completed prerequisite session:

```bash
migent session run --workflow implement \
  --task "Build the approved plan" \
  --prior <plan-session-id>
```
