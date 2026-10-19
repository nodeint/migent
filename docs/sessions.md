# Sessions and workflow composition

Migent stores local execution state under `.migent/sessions/`. A session
records stage executions, provider events, decisions, artifacts, and published
outputs.

Do not commit this directory. Commit `.migent/config.yaml` and
`.migent/workflows/` instead.

## On-disk layout

Each run has its own directory, named by its session ID:

```text
.migent/sessions/<session-id>/
├── manifest.yaml
├── status.json
├── task.md                               # task body; written before the first stage
├── events.jsonl
├── session.lock                          # present only while a process is running the session
├── outputs/                              # present after outputs are published
│   └── <output-name>
└── executions/
    └── <order>-<stage-id>--attempt-<n>/
        ├── execution.json
        ├── conversation.json             # provider conversation checkpoint
        ├── prompt.md
        ├── task.md                       # copy of the session task at dispatch
        ├── response.md                   # present after a response is saved
        └── artifacts/
            └── <stage artifact files>
```

The session-level files have distinct purposes:

- `manifest.yaml` identifies the session, workflow, task label, creation time, and
  terminal status. An ad hoc agent session also records its role; a workflow
  with `requires` records its prerequisite as `prior_session_id`.
- `task.md` is the task body. A one-line `session run --workflow --task` writes
  that sentence here. A prepared session leaves the file for you to write, along with any
  other files that belong next to it. Stage prompts name this path and the
  session directory. They do not include the task text. The first dispatch
  records a hash of `task.md`. A later change stops the next dispatch.
- `status.json` is the current, machine-readable session snapshot. It includes
  the latest execution and stage state, and records decisions, blockers, and
  published outputs when applicable. `session show` reads this file.
- `events.jsonl` is the append-only event stream. Each line is one JSON object.
  A prepared session starts with an empty file, so `session show <session-id>` can
  print the snapshot before the first stage. `session follow <session-id> --cursor`
  uses byte offsets into this file.
  `--cursor` is an option for tools that resume a follow.
- `executions/` contains one record for every stage attempt. A completed,
  failed, or cancelled execution record is immutable. Execution directory names
  are ordered, for example `0002-review--attempt-01`.
- `outputs/` contains the artifacts selected by the workflow's `completion`
  block. It is created only when the workflow reaches its configured completion
  condition and all selected artifacts are non-empty.

Each execution directory contains:

- `execution.json`: execution identity, order, stage and attempt, provider and
  model, lifecycle status, timestamps, and the parsed stage outcome.
- `turns/NN/`: written only for stages with `verify`. It holds `response.md`,
  `outcome.json` for a complete turn, `verify.md`, and `commands/MM.log`.
  `execution.json` also records `turns`, `verify` (`runs`, `red`, `max_verify`,
  `last_result`, `last_report`), and `failure_reason` (`verify_exhausted`).
- `conversation.json`: provider conversation checkpoint used when resuming a
  provider session. It stores the provider and model, native agent ID, options
  setting, lifecycle status, and fallback message history. This is separate
  from the Migent session-level `status.json`.
- `prompt.md` and `response.md`: the exact prompt sent for the attempt and the
  response saved from the provider. `task.md` in this directory is a copy of
  the session task at the moment the execution was created.
- `artifacts/`: files written by that stage. These are per-attempt working
  artifacts; only explicitly configured completion outputs are copied to the
  session-level `outputs/` directory.

These files are Migent's resumable local state. Before the first stage of a
prepared session, write `task.md` and files next to it. Do not edit
`manifest.yaml`, `status.json`, `events.jsonl`, or `executions/` by hand.
Prefer the CLI commands below for inspection and automation.

Older executions may contain the former name `session.json`. Migent still
reads that file when resuming, but all new checkpoints are written as
`conversation.json`.

## Published outputs

A completion output is copied from a successful stage artifact to
`outputs/<output-name>`. For example:

```yaml
completion:
  stage: review-plan
  decision: approved
  outputs:
    - name: plan
      from_stage: plan
      artifact: plan.md
```

publishes:

```text
.migent/sessions/<session-id>/outputs/plan
```

`status.json` records both the relative path and provenance of the published
file:

```json
{
  "outputs": {
    "plan": {
      "path": "outputs/plan",
      "source_execution_id": "0001-plan--attempt-01",
      "published_by_execution_id": "0002-review-plan--attempt-01"
    }
  }
}
```

`source_execution_id` identifies the attempt that produced the artifact.
`published_by_execution_id` identifies the completion attempt that caused it to
be published.

## Inspect and resume

```bash
migent session list
migent session list --latest --json
migent session show <session-id>
migent session follow <session-id>
migent session continue <session-id>
migent session continue <session-id> --once
```

`session list` lists recorded runs, newest first. `--workflow`, `--status`, and
`--limit` narrow that list. `--latest` prints the newest match. `session show
<session-id>` prints a snapshot. `--json` omits the task text from the list
and the snapshot. `session follow` follows execution events until a signal, or
until the session stops when `--exit-when-done` is set. `session continue`
resumes an active workflow session from its recorded state and resets revision
counts. `session continue --once` advances one stage and does not reset them.
A session with status `prepared` is not resumed by `session continue`. Write
`task.md`, then run `migent session run --session <session-id> --workflow <workflow>`.

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

## Reusable workflow boundaries

One workflow can require an approved run of another. This lets teams separate
reusable processes—for example, plan approval from implementation:

```yaml
id: implement
requires:
  workflow: plan
  decision: approved
```

Start it with the completed prerequisite session:

```bash
migent session run --workflow implement \
  --task "Build the approved plan" \
  --prior <plan-session-id>
```
