# Sessions and workflow composition

Migent stores local execution state under `.migent/sessions/`. A session
records stage executions, client events, decisions, artifacts, and published
outputs. Event kinds keep their historical `provider.*` names; they describe the
agent CLI that ran the turn.

Do not commit this directory. Commit `.migent/config.yaml` and
`.migent/workflows/` instead. `.migent/config.local.yaml` is a per-machine
override and stays uncommitted.

## On-disk layout

The field-level structure of every file below, and of each `events.jsonl` event, is in the [session files reference](reference/session-files.md).

Each run has its own directory, named by its session ID. A new session id is the
next number in the workspace (`1`, `2`, `3`, …): the highest numeric directory name plus one.
Older UUID and timestamp ids stay valid and are ignored when numbering. `manifest.yaml`
stores `session_id` and `prior_session_id` as quoted strings, and also records `title`. A workflow or role session sets
`title` to its one-line task. `session prepare` sets `title` to the text you
pass, creates an empty `task.md`, and copies the workflow to an editable
`workflow.yaml`. The title is for display, so spaces and capitals stay. A session written by an older Migent has no `title`. List and
show use `session_id` for that session.

Next to the session directories, `.migent/sessions/` holds Migent bookkeeping that `session list` ignores:
`.last-id` (the highest number retired by `session delete`), `.last-id.lock` (held for milliseconds
while it is updated), and `.deleting/` (sessions being removed).

```text
.migent/sessions/<session-id>/
├── manifest.yaml
├── workflow.yaml                         # editable workflow draft created by prepare
├── workflow.frozen.yaml                  # pinned workflow, roles, and stage targets
├── status.json
├── title.json                            # present after `session rename`
├── task.md                               # task body; written before the first stage
├── events.jsonl
├── session.lock                          # present only while a process is running the session
├── cancel.requested                      # temporary; written by `session cancel`, removed by the running process
├── outputs/                              # present after outputs are published
│   └── <output-name>
└── executions/
    └── <order>-<stage-id>--attempt-<n>/
        ├── execution.json
        ├── diagnostics.json              # the latest abnormal client turn; see diagnostics.md
        ├── debug.log                     # only when MIGENT_DEBUG is on
        ├── stream.jsonl                  # client item traces and heartbeats (`provider.*` events)
        ├── conversation.json             # client conversation checkpoint
        ├── prompt.md
        ├── task.md                       # copy of the session task at dispatch
        ├── response.md                   # model response, only when the model produced one
        ├── failure.md                    # readable failure report for a failed execution
        └── artifacts/
            └── <stage artifact files>
```

The session-level files have distinct purposes:

- `manifest.yaml` on a schema 2 session records identity and handoff provenance: `session_id`, an
  optional `title`, the workflow id and path, the task label, `created_at`, an
  optional `prior_session_id` or `role`, and `schema_version`. A prepared session
  has a title and no task label. The task body is `task.md`; `workflow_path`
  names its editable `workflow.yaml`. The manifest has no status line.
  Status lives in `status.json`. A v1 manifest still has a `status` line, and
  that line is still updated. An ad hoc agent session records its role; a
  workflow started with prior context records `prior_session_id` and a `handoff` mapping with source output names, snapshot paths and SHA-256 hashes.
- `workflow.yaml` is the editable draft that `session prepare` writes from the
  named workflow, with an explicit `id`. It is this session's workflow source:
  edit it before starting, keep its `id`, and run
  `session run --session <id>`. At the first dispatch Migent
  freezes it to `workflow.frozen.yaml`. Changes to `.migent/workflows/` do not
  change this session, and `--refresh-workflow` rereads the draft.
  Prepared sessions created by an older Migent have no draft and read the
  project workflow. `migent workflow validate|render|save --session <id>`
  edits the draft safely (see [cli.md](cli.md#session-drafts)); saving does not
  apply it to a started session.
- `workflow.frozen.yaml` pins the workflow, role responsibilities, and resolved
  stage targets when a workflow session starts. Prepared sessions freeze from
  `workflow.yaml` at `run`. `session continue` and
  `session run --session` keep using that copy when the live files change, and
  warn on stderr. `--refresh-workflow` replaces it. A missing file means the
  session uses the live workflow and config. Repair does not rebuild it.
  Agent sessions do not have this file.
- `task.md` is the task body. A one-line `session run --workflow --task` writes
  that sentence here. A prepared session creates an empty file for you to write, along with any
  other files that belong next to it. Stage prompts name this path and the
  session directory. They do not include the task text. The first dispatch
  records a hash of `task.md`. A later change stops the next dispatch.
- `title.json` is written only by `migent session rename`. It holds the current `title`, `updated_at`,
  and a `history` of earlier titles with timestamps. The effective title is the `title.json` title,
  then the `title` in `manifest.yaml` (the creation title, never rewritten), then none. A missing or
  invalid `title.json` falls back to the manifest title. Rename takes no session lock, so it works
  during a live run. `session list`, `session show`, and `session follow` apply the effective title
  when they read, while `status.json` may keep the previous title until the next lifecycle commit or
  `session repair` folds the effective title into it. Rename never changes `task`.
- `status.json` is the current, machine-readable session snapshot. It includes
  the latest execution and stage state, and records decisions, blockers, and
  published outputs when applicable. `session show` reads this file.
  `running_stages` lists each running execution in execution order. Each entry
  has `execution_id`, `stage_id`, `client`, `event`, `summary`, and
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
- `executions/<id>/stream.jsonl` holds the client's `provider.item_*` and
  `provider.heartbeat` events for that execution. Other client events, including
  `verify.heartbeat`, stay in `events.jsonl`.
- `baseline.captured` is logged once, just before the session's first execution. It holds the Git commit
  that `HEAD` pointed at (or null and the reason) and feeds `status.baseline`. A `run_when` stage compares
  the working tree with it. A session that already had executions never gets one.
- `executions/` contains one record for every stage attempt. A completed or
  failed execution record is immutable. `session continue` reopens a cancelled
  execution in place; the cancelled event stays in the log. Execution directory
  names are ordered, for example `0002-review--attempt-01`. A `run_when` skip is an
  execution with `kind: "skip"` and status `skipped`. It is terminal from the start, holds no
  prompt or conversation, and stores `skip` (reason, baseline commit, patterns, number of
  changed paths). `status.json` gains `baseline` (`commit`, `captured_at`, optional `error`) and,
  while a stage's latest execution is a skip, `skipped_stages` (`stage_id`, `execution_id`).
- `outputs/` contains the artifacts named by the workflow. A schema 7 workflow
  copies every top-level `artifacts` entry that resolves when the run is quiet;
  required entries must resolve, optional ones are copied only when present, and
  decision-local artifacts are never copied. A version 2 to 6 workflow
  copies top-level `outputs` when the run is quiet and every artifact resolves.
  A version 1 workflow still copies `completion.outputs` when the completion
  stage makes its decision. The directory is created only then, and only when
  every selected artifact is non-empty.

Each execution directory contains:

- `execution.json`: execution identity, order, stage and attempt, client and
  model, lifecycle status, timestamps, and the parsed stage outcome. A client
  execution also records `final_turn`, the last client turn it ran, on every
  terminal save; `failure.md` uses it to tell whether `diagnostics.json` explains
  the failure. An execution written by an older version has no `final_turn`. A
  stage with no role records `kind: verify`, and `client` and `model` are null.
- `turns/NN/`: written when a stage runs `verify`. A role stage holds
  `response.md`, `outcome.json` for a complete turn, `verify.md`, and
  `commands/MM.log`. A stage with no role writes `turns/01/verify.md` and
  `turns/01/commands/MM.log` and does not write a model response.
  `execution.json` for a role stage also records `turns`, `verify` (`runs`,
  `red`, `max_verify`, `last_result`, `last_report`), and `failure_reason`
  (`verify_exhausted`, or a correction reason when the agent's fix turn still fails:
  `handoff_file_invalid`, `stage_output_missing`, and for protocol 2 conversations
  `response_contract_invalid`, `question_file_invalid`;
  see [Workflows](workflows.md#correctable-response-failures)). `corrections` records
  each granted correction by kind (`turn`, `error_kind`, `error_detail`). A stage with no role records `failure_reason:
  verify_failed` when the list fails.
- `handoff.json`: the stage outcome the agent writes under response protocol 3 (see
  [Workflows](workflows.md#stage-protocol)). Migent deletes it before every fresh turn, so it
  holds the last turn's handoff, and a failed validation leaves it for diagnosis. Corrections for it
  are recorded as `corrections.handoff`. `execution.json` records `response_protocol` (3 for a
  new conversation; a continued conversation keeps its source execution's value, and a missing
  or legacy value is read as protocol 1). Protocol 2 conversations use `question-request.json`.
- `conversation.json`: client conversation checkpoint used when resuming a
  client session. It stores the client and model, native agent ID, options
  setting, lifecycle status, and fallback message history. A stage with no
  role does not write this file. This is separate from the Migent
  session-level `status.json`.
- `prompt.md` and `response.md`: the exact prompt sent for the attempt and the
  response returned by the model. `response.md` is written only when the model
  produced output (text the adapter labels `model`); a client that could not
  start leaves it absent, and it never holds Migent's error text or the
  client's own error payload. It is also absent when the client reported an
  error, even if the model had written text first. A turn whose process exited
  non-zero without reporting an error (`exit-only`) keeps the model's reply
  whether or not Migent accepted the turn. A stage with no role writes neither file.
  A later attempt that continues the same stage's client session records the
  continuation prompt. An attempt that continues a `session.resume_from`
  dependency records the full stage prompt. `task.md` in this directory is a
  copy of the session task at the moment the execution was created.
- Non-zero exit with a usable reply: the exit code alone does not fail a turn.
  When the process exited non-zero, the client reported no error, and the
  reply is model text, the turn goes through the same checks as an exit-0 turn
  (parsable outcome, stage artifact, completion outputs). If it passes, the turn
  is accepted: the execution ends `completed`, `failure_kind` and `reset_at` are
  empty, and `events.jsonl` gets one `provider.exit_anomaly`
  event (`turn`, `client`, `exit_code`, `signal`, `origin`, `accepted: true`,
  `reason: null`) next to `provider.turn_completed`. If a check fails, the
  execution fails with the model's text as its error, and the event has
  `accepted: false` with the failed check in `reason`. Each client turn gets
  one verdict; later question-correction or verify turns are separate turns. A
  client error, a start failure, or a signal exit is never accepted.
- `failure.md`: written when the execution ends `failed`. It is a readable
  report with the stage, attempt, client, `failure_reason`, the error message,
  and pointers to `diagnostics.json` or the verify report. When `diagnostics.json`
  describes the execution's `final_turn` and that turn failed, the report states
  it as the cause; an earlier or accepted turn is labelled as such. Structured
  data stays in `execution.json` (`error`, `failure_reason`, `final_turn`) and
  `diagnostics.json`.
- `artifacts/`: files written by that stage. These are per-attempt working
  artifacts; only explicitly configured outputs are copied to the
  session-level `outputs/` directory.

These files are Migent's resumable local state. Before the first stage of a
prepared session, write `task.md`, add any files next to it, and adjust
`workflow.yaml` if needed, then check it with `migent doctor --session <id>`
(read-only; see [cli.md](cli.md#doctor)). `session run` repeats these checks
before it freezes the draft. Do not edit
`manifest.yaml`, `status.json`, `events.jsonl`, or `executions/` by hand.
Prefer the CLI commands below for inspection and automation.

Older executions may contain the former name `session.json`. Migent still
reads that file when resuming, but all new checkpoints are written as
`conversation.json`.

## Deleting sessions

`migent session delete` ([CLI](cli.md#inspect-sessions)) takes the session lock, retires the session's
number, renames the directory into `.deleting/`, and removes it there, so a session is either whole or gone.
If removal fails after the rename, the session is already hidden from every command; the next `session delete`
(naming the ID, or any other run) finishes the removal.

- **Numbering.** A numeric ID deleted with `session delete` is never reissued: `.last-id` records the
  highest retired number and new sessions continue above it. A directory removed by hand (`rm -rf`) leaves no
  mark, so its number can be reused. An older Migent version ignores `.last-id` and can reissue a number.
- **Dependents.** Deletion does not check `--prior`. A dependent that started has its own `handoff/`
  snapshot and is unaffected. A historical dependent without handoff records reads the source's live files, so
  it breaks when it resumes. An unstarted prepared dependent fails with the missing `--prior` source error; it
  never binds to another session.
- **Foreign-host locks.** A lock from another machine whose heartbeat has expired is stale and the session is
  deletable, although `session cancel` reports it as running elsewhere.
- **Containment.** `session delete` rejects session folders, `.deleting/`, `.last-id`, and a sessions root that are
  links when it checks them, immediately before each change. It does not defend against another process that
  writes to `.migent/sessions/` and swaps a folder for a link while a delete is running. Such a process can
  redirect the delete's lock file, move, or recursive removal to a folder outside `.migent/sessions/` that the
  user can write to, as with `rm -rf` on a tree that another writer controls. Do not run `session delete` while
  other tools rewrite `.migent/sessions/`.

## Published outputs

A published output is copied from a successful stage artifact to
`outputs/<artifact-file>`, keeping the artifact name and its suffix. A schema 7
workflow declares those artifacts in the top-level `artifacts` registry and
publishes them once, when the session completes (the persisted `outputs/`
directory and `status.json.outputs` keep their names):

```yaml
artifacts:
  plan:
    file: plan.md
```

A version 2 to 6 workflow lists them as top-level `outputs` entries (`name`,
`from_stage`, `artifact`) instead.

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
      "published_by_execution_id": "0002-review_plan--attempt-01"
    }
  }
}
```

`source_execution_id` identifies the attempt that produced the artifact.
`published_by_execution_id` identifies the execution that published it: the
completion stage on a version 1 workflow, or the execution that made the run
quiet on a version 2 workflow.

## Inspect and resume

See [Human-in-the-loop interaction](human-in-the-loop.md) for the complete
question-and-answer flow, including numbered replies and structured history.

Stages with `ask: human` can stop with outcome `question`. `session show` lists
each pending question with its context, options, and `single`/`multiple`
selection mode. Each execution's `questions.json` preserves the batch it asked, and the
`input.json` of the execution that received the answers records them
(see [Human-in-the-loop interaction](human-in-the-loop.md#files-and-question-history)). Questions are identified by execution ID and question ID.
These requests remain visible while independent branches run or another stage
is blocked. A quiet session is `blocked` if any stage is blocked, otherwise
`question` if an answer is pending. A question exits 9 and is not a failure.

Questions are numbered from 1 in each stage's batch; options are lettered A, B,
C, ... by order. Reply with `session continue <session-id> --reply "1A, 2B, 3 explain further"`.
Multiple selections use `2A+C`. JSON objects mapping question numbers to letters,
arrays, or text are also accepted through `--reply` or `--reply-file`. Invalid answers
are rejected before dispatch. Free text is always allowed for every question;
in a batch, use a text string as the question's value. Use `--stage`
when more than one stage is waiting for a reply, including blocked stages.
Continuing without a reply leaves questions pending. The reply creates a new
execution in the same conversation, carries the declared artifact, and preserves
the verification failures used before asking. Standalone role sessions can ask
the human without workflow configuration and use the same reply command.

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
new execution and does not start a client. A blocked session is resumed the
same way: continue dispatches that stage again, and the new prompt includes
the blocker and the previous response.
`session continue <session-id> --reply "<reply>"` uses the reply as that prompt
body instead. `--reply-file <path>` reads it from a file. When more than one
stage is blocked, `--stage` selects the stage. The other blocked stages stay
blocked.
A cancelled session is resumed on that same execution. `session continue`
does this for a role session too. A cancelled role execution sends a cut-off
client turn again, or reruns verify when the reply was already saved. A
cancelled stage with no role reruns its verify list in place and does not start
a client. An active role session sends its last prompt again. `--reply` on
a role session is the next user turn. A completed role session stays stopped
unless `--reply` is set.
To redirect a stopped agent instead, pass `--reply "<text>"` (or `--reply-file`)
to `session continue`. This works for a workflow stage and for a role session.
The cancelled execution stays `cancelled` with its partial stream. The reply is
sent as a new execution (next attempt) that continues the same client
conversation. Its prompt starts with a line saying the previous turn was
stopped by the human before it finished, then the reply. Edits the cut-off turn
already made to the workspace are not rolled back. A verify that was cut off is
discarded, and the new execution runs verify again. A stage with no role has no
agent to reply to; omit `--reply` to rerun its verify list. If the command is
interrupted after the reply was saved, `session continue` without `--reply`
sends the saved reply. A newer `--reply` replaces it. Without `--reply`,
`session continue` still resumes the cancelled execution and sends the cut-off
turn again, except one a reply already replaced. When a cancelled stage waits
beside a blocked stage or pending question, `--reply` needs `--stage` to pick
the target. Replying to the cancelled stage leaves the blocked stage blocked.
## Expired resumes

When a resume policy finds the prompt cache expired and the action is `ask`, the session gets the status
`expired` (exit 10). Its precedence is below `blocked` and `question`: with several stops, the session shows the
higher one. The stop belongs to the **target stage** (the stage that would resume), keyed by the source
execution. A `session.resume_from` target with no execution of its own can therefore wait for a decision.

- `migent session show` lists each pending decision and the exact command.
- `migent session resume <session> resume|fresh [--stage <stage>] [--no-continue]` records the decision and
  continues only that stage. Other blockers, questions, and cancelled stages stay as they are. Use
  `session continue` for those.
- `fresh` starts a new conversation with the full stage prompt and the saved reply, blocker, or verify output.
  The execution records `resume_skipped`.
- `session complete` marks pending decisions as superseded.
- A decision applies to one use of one source execution. Once the stage has started on it, or the source was reopened
  in place after a cancel, a later resume of the same source is judged again and can ask again.
- Downgrade limitation: Migent versions without resume policies ignore `resume.expired` and `resume.decided` events,
  and ignore the frozen policy. Continuing an `expired` session with such a version resumes the stale conversation
  without the guard, and that version reads the status `expired` as unknown. Finish or complete such sessions with
  the version that created them.

## Completion method

Every completed session records how it completed:
- `completion_method: "agent"`: normal agent-driven completion (execution reached decision or quiescence)
- `completion_method: "manual"`: human-initiated completion via `migent session complete`

```json
{ "status": "completed", "completion_method": "manual" }
```

This enables audit queries (e.g., `jq '.completion_method' *.json | grep manual`) and distinguishes deliberate human decisions from automatic workflow outcomes. Future versions could add `migent session reopen` if manual completions need reversal.

`completed` sessions stay stopped. `session continue --once`
advances one stage and does not reset revision counts.

## Manual completion

`migent session complete <session-id>` lets a person mark a stopped workflow
session `completed` without running another stage (see
[CLI](cli.md#inspect-sessions)). It runs under the session lock and applies to
`active` (no live lock), `blocked`, `question`, and `cancelled` sessions. It
appends `outputs.published` (when anything is published) and a session-level
`session.completed` to `events.jsonl`; the latter has no execution id and
carries `data.manual: true`, `data.from` (the previous status), `data.reason`,
and optionally `data.missing_outputs`.

The completion_method field indicates completion cause (manual vs agent).

The fold derives manual completion from that event, so `status.json` stays
`completed` after `session repair`. It clears the blocked and question fields,
omits `questions`, and records `manual_completion`:

```json
{ "status": "completed", "manual_completion": { "completed_at": "2026-11-07T12:00:00+00:00", "from": "blocked" } }
```

An unanswered question stays in its execution's `questions.json` and is no
longer listed as pending in `status.json`.

Outputs resolve by the normal rules: schema 7 resolves the artifact registry
against the skip-aware current completions; schema 2 to 6 publish the top-level
`outputs`, and version 1 publishes `completion.outputs`, each from a completed
execution with a non-empty artifact. A manually published output records
`published_by_execution_id: "manual"`; `source_execution_id` still names the
producing execution. A required artifact that cannot be resolved is listed in
`data.missing_outputs` and warned about, and the session still completes.

The command then seals `metrics.json` and writes `next.json`, as a normal
completion does. The session stays terminal: `session continue` does not
dispatch, and no command reopens it. An execution left `running` by a crashed
process is not reconciled by this command.

A session with status `prepared` is not resumed by `session continue`. Write
`task.md`, adjust `workflow.yaml` if needed, then run
`migent session run --session <session-id>`.

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

## Legacy sessions

Sessions written before schema version 6 store the removed `provider` field.
Read-only inspection (`session show`, `session follow`, doctor session, and
metrics) always works. Resume and continue need evidence of the CLI that
actually ran the turn:

| Legacy case | Resume / continue |
| --- | --- |
| Workflow execution with turn events | yes, when every recorded turn's `details.argv[0]` agrees on the client |
| Workflow execution with no turn events | refused: there is no evidence; start a new session to rerun the stage |
| Execution whose evidence conflicts, for example `argv[0]` differs from the frozen target or the client the caller requested | refused, and nothing is spawned |
| Role session with a default-client provider | yes, through the legacy provider → client mapping |
| Role session for `byteplus` | refused: it never had a client |

Turn events have carried `argv` since they were introduced; an older event
without it is treated as having no evidence. When evidence exists,
`session continue` uses that client and keeps the native conversation ID, the
model string, and the options. A conflict or missing evidence prints
`Cannot resume execution <id>: <reason>. Start a new attempt.` Unsealed legacy
metrics parse usage with the launched client; a sealed `metrics.json` is never
recomputed and keeps its `provider` key.
Provenance and profile checks run before a new attempt is created. Continuing
a cancelled batch validates every execution before reopening any of them.
An old execution whose turns used different CLIs cannot resume; its metrics
still parse each turn with that turn's own executable when known.

## Metrics

`migent session metrics` prints the `metrics.json` written when a workflow
session completes. See [Session metrics](session-metrics.md) for the command,
the JSON shape, and how usage, cost, and timing are computed.

## Artifact dependency versus client-session resume

`depends_on` gives a stage the output of an upstream stage:

```yaml
depends_on: [plan]
```

`session.resume_from` additionally continues the client's prior conversational
session instead of starting a new one:

```yaml
depends_on: [plan]
session:
  resume_from: plan
```

The resumed stage therefore receives both the declared upstream context and the
client's conversation history. `resume_from` must name one of the stage's
dependencies.

A stage keeps one client agent for every visit. The next execution continues
that agent when the stage runs again, including a failed attempt, a blocked
result, a verify repair, a route back, and a newer dependency. A route back's
prompt points at the routing stage's response and the previous artifact.

`session.resume_from` is the exception. The stage continues the named
dependency's client session instead of keeping its own. That applies on the
first visit, and on a later visit that was not routed back. A verify repair
and a failed retry of a routed visit continue the execution already in
progress.

## Reusable workflow boundaries

A completed producer can publish `next.json`, and `session run --prior` starts a
downstream workflow from a completed session with snapshotted context. See
[Session handoff](session-handoff.md).
