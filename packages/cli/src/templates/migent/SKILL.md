---
name: migent
description: Set up Migent in a project, or configure, run, inspect, and resume its workflows with the migent CLI. Use when the user asks about Migent, .migent/ configuration, workflows, roles, models, sessions, stages, doctor, or published outputs.
---

# Migent

Migent runs a project's multi-stage agent workflows from the `migent` CLI.
A workflow is a set of stages; each stage runs a role; a role uses a model
name defined in `.migent/config.yaml`. Each run is a session.

## Working rules

- For an existing project, work from the root containing
  `.migent/config.yaml`.
- Read `.migent/config.yaml` and the relevant file under
  `.migent/workflows/` before changing or running a workflow.
- Before writing `.migent/config.yaml` or a file under `.migent/workflows/`,
  read `.agents/skills/migent/references/schema-config.yaml` and
  `.agents/skills/migent/references/schema-workflow.yaml`. They list every
  accepted key. A key absent from those files is ignored.
- Run `migent doctor --json` after editing configuration or workflows. If it
  reports an outdated schema, run `migent migrate --yes`. Pass `--json` on
  `config model` and `config role` writes too. The object includes the doctor
  result.
- You have no terminal for prompts. Pass `--no-input` (or set
  `MIGENT_NO_INPUT=1`) to `init`, `config model`, and `config role`, and give
  every value as a flag.
- Treat `.migent/sessions/` as generated, resumable state. Do not edit
  `manifest.yaml`, `status.json`, `events.jsonl`, or files under
  `executions/`. In a prepared session, write `task.md` and files next to
  it before the first stage. Do not change `task.md` after that stage starts.
- Preserve the user's task wording. Pass a one-line task in `--task`. Write
  a longer task into `task.md` unchanged.
- A workflow `session run` or `session continue` prints `session_id`,
  `session_status`, `stop_reason`, `latest_decision`, and `outputs` on stdout.
  Stderr carries stage boundaries and errors. A role run prints a table unless
  `--json`. That JSON is the role result, not this object.
- This skill is already in the prompt. Do not open its file again.
- Do not read `task.md` or the documents it names. The stage agent reads
  them. Still read `.migent/config.yaml` and the workflow file before starting.

## Set up

```
migent init --no-input --provider <provider> --model <model-id> [--preset implement|plan] [--option KEY=VALUE] [--skill]
migent doctor --json
```

`--provider` and `--model` go together. `--preset` picks the workflow to
create (default `implement`). `--skill` installs this skill at
`.agents/skills/migent`; `migent skill update` refreshes a managed copy.

## Run

`migent session run` runs a workflow when `--workflow` is set, and one role
when `--workflow` is omitted.

- Start a one-line task: `migent session run --workflow <workflow> --task "<task>"`.
  `<workflow>` is a workflow id, or a path to a workflow file (the `id`
  field defaults to the file name). The sentence is stored in `task.md`.
  `--task` must be one line. Runs until the session stops.
- Start a longer task: `migent session prepare <some-id> --workflow <workflow>`.
  `<some-id>` is a lowercase slug such as `wave-3` (letters, digits, and
  single hyphens). Write `.migent/sessions/<some-id>/task.md`, then
  `migent session run --session <some-id> --workflow <workflow>`.
  `session continue` does not start a prepared session.
- Start and dispatch one stage only: add `--once`. `--once` requires `--workflow`.
- If the workflow's `requires` block names a prerequisite workflow and
  decision, find it with
  `migent session list --workflow <workflow-id> --status completed --json`
  and pass `--prior <session-id>`. `session continue` accepts `--prior` too.
- Resume an active workflow session: `migent session continue <session-id>`.
  This resets revision counts. `migent session continue <session-id> --once`
  advances one stage and does not reset them.
- Run one role: `migent session run --role <role> --prompt "<prompt>"`.
  `roles.<role>.instructions` in config, when set, is prepended to that prompt.
  Use `--file <path>` or `--stdin` for a long prompt. `--task` labels a new
  role session and cannot be combined with `--session <session-id>`, which
  continues an earlier role session. `--provider`/`--model` (together) and
  `--option KEY=VALUE` override the role for this turn. Add `--json` for one
  result object. Exit 0 means the outcome is complete, 1 not complete.
- Read the JSON result on stdout for a workflow run. Do not pass `--verbose`
  or `--progress`. `--verbose` inlines every stage response. `--progress`
  prints each tool call.
- Exit 1, 3, and 6 also include `latest_execution_id` and `response_path`,
  relative to `.migent/sessions/<session-id>/`. Read that file when you must
  fix the execution.
- Stderr is not the outcome. Do not read the command log while a run is healthy.
- When `session run` or `session continue` is in the background, wait for that
  command's completion notice. Do not add a watcher that only waits for the same exit.
- To check a run without waiting on the command, use
  `migent session show <session-id> --json` once.
- Do not run `session follow` or `--cursor`.

Limits, accepted by workflow `session run` and by `session continue`:

- `--attempts <n>`: failed executions allowed for one stage (default 3). On
  `session continue` it sets a new total, not extra retries.
- `--max-dispatches <n>`: stage dispatches allowed in this command (default
  20). `--unlimited-dispatches` removes the ceiling; use it only if the user
  agrees.

### Exit codes and stop reasons

A workflow result on stdout includes `stop_reason`. Read the exit code first.

| Exit | Meaning | `stop_reason` | Session | What to do |
| --- | --- | --- | --- | --- |
| 0 | Completed (with `--once`: stage complete) | | completed or advancing | Report outputs. |
| 1 | Blocked (with `--once`: stage not complete) | `blocked`, or `stage` with `--once` | blocked, or active with `--once` | When `stop_reason` is `blocked`, read `response_path`, fix the cause, then `session continue`. That runs the blocked stage again and includes the blocker in its prompt. When `stop_reason` is `stage`, `session continue` keeps going. |
| 2 | Configuration error | | unchanged | Run `migent doctor --json`, fix config. |
| 3 | `--attempts` spent | `retry_exhausted` | active | Read `response_path`, fix the cause, then `session continue` (add `--attempts` for a higher total). |
| 4 | A route would exceed `max_revisions` | `revisions_exhausted` | active | Review why the stage keeps being revised; `session continue` (without `--once`) resets counts for another batch. |
| 5 | `--max-dispatches` spent | `dispatch_limit` | active | `session continue` the same session if more stages are appropriate. |
| 130 | Cancelled | | see snapshot | Ask the user before resuming. |

A stopped active session is resumable; do not describe it as completed. A
blocked session is resumed the same way: `session continue` runs that stage
again. Do not start a replacement session to reset limits or to get past
`blocked`. If you change a workflow or
config while a session is active, run `migent doctor --json` and tell the user the
session was created under the earlier definition.

## Inspect sessions

- Newest match: `migent session list --latest --json`. Add `--workflow <id>` and
  `--status active|prepared|completed|blocked|cancelled` to narrow it. `--limit <n>`
  returns the newest n rows. Do not combine `--latest` with `--limit`.
- `--latest --json` is one object, or `null` when nothing matches. A list is
  a JSON array. Snapshot: `migent session show <session-id> --json` has the
  status, latest execution, decision, and outputs. JSON omits the task text.
- `session follow` streams the event trace for a person at a terminal.
  Do not use it or `--cursor` to coordinate a run.

Report the session ID, status, stop reason, decisions, and published outputs
that matter to the user. Published output paths are relative to
`.migent/sessions/<session-id>/`; use the paths Migent reports instead of
guessing.

## Configure models and roles

- Show: `migent config` or `migent config show`.
- List models or roles: `migent config model --json`,
  `migent config role --json`.
- Change a model name:
  `migent config model <name> --provider <provider> --model <model-id> --no-input --json`.
  This updates every role and stage that uses the name. Use
  `--option KEY=VALUE` and `--clear-option KEY` for provider options.
- Point roles at an existing model name:
  `migent config role <role>... --model-name <name> --no-input --json`. The value is
  a name from `models`, not a provider model id.
- Override one role without touching the shared name:
  `migent config role <role> --provider <provider> --model <model-id> --no-input --json`.
- `roles.<name>.instructions` is an optional list of strings. A stage prompt
  includes it before that stage's instructions. A role run prepends it to the prompt.
