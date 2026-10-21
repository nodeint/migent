---
name: migent
description: Set up Migent in a project, or configure, run, inspect, and resume its workflows with the migent CLI. Use when the user asks about Migent, .migent/ configuration, workflows, roles, models, sessions, stages, doctor, or published outputs.
---

# Migent

Migent runs a project's multi-stage agent workflows from the `migent` CLI.
A workflow is a set of stages; each stage runs a role; a role uses a model name
defined in `.migent/config.yaml`. Each run is a session, stored under
`.migent/sessions/<session-id>/`.

This skill is already in the prompt. Do not open its file again.

## Rules

- Work from the project root, the directory containing `.migent/config.yaml`.
- Read `.migent/config.yaml` and the relevant `.migent/workflows/` file before
  running a workflow.
- Before writing either, read `.agents/skills/migent/references/schema-config.yaml`
  and `schema-workflow.yaml` in the same folder. A key absent from them is
  ignored. Then run `migent doctor --json`; if it reports an outdated schema,
  run `migent migrate --yes`.
- You have no terminal for prompts. Pass `--no-input` (or set
  `MIGENT_NO_INPUT=1`) to `init`, `config model`, and `config role`, and give
  every value as a flag.
- Do not edit generated session state: `manifest.yaml`, `status.json`,
  `events.jsonl`, `metrics.json`, or anything under `executions/`.
- Keep the user's task wording. Do not read `task.md` or the documents it
  names; the stage agent does.
- Never start a replacement session to reset limits or get past `blocked`.
  Resume the same one.

## Run a task

`<workflow>` is a workflow id or a path to a workflow file.

One-line task. The command runs until the session stops:

```
migent session run --workflow <workflow> --task "<task>"
```

Longer task. `<some-id>` is a lowercase slug such as `wave-3`:

```
migent session prepare <some-id> --workflow <workflow>
```

Write the task, unchanged, to `.migent/sessions/<some-id>/task.md` (plus any
files next to it). Do not edit `task.md` once the first stage has started.
Then:

```
migent session run --session <some-id> --workflow <workflow>
```

Dispatch only one stage: add `--once`.

### Read the result

stdout is a JSON object: `session_id`, `session_status`, `stop_reason`,
`latest_decision`, `outputs`. Exit 1, 3, and 6 also give `latest_execution_id`
and `response_path`, relative to `.migent/sessions/<session-id>/`; read that
file to see why it stopped.

- stderr is not the outcome. Do not read the command log while a run is healthy.
- Do not pass `--verbose` or `--progress`. Do not use `session follow`.
- If the command runs in the background, wait for its completion notice. Do not
  add a watcher that waits on the same exit.

### Exit codes

Read the exit code first, then `stop_reason`.

| Exit | Meaning | `stop_reason` | What to do |
| --- | --- | --- | --- |
| 0 | Completed (with `--once`: stage complete) | | Report outputs. |
| 1 | Blocked (with `--once`: stage not complete) | `blocked` (`stage` with `--once`) | If `blocked`: read `response_path`, then resume with the user's answer (below), or plain `session continue` once the blocker is fixed in the workspace. If `stage`: `session continue` keeps going. |
| 2 | Configuration error | | Run `migent doctor --json`, fix config. |
| 3 | `--attempts` spent | `retry_exhausted` | Read `response_path`, fix the cause, `session continue` (`--attempts <n>` sets a higher total). |
| 4 | A route would exceed `max_revisions` | `revisions_exhausted` | Review why the stage keeps being revised, then `session continue` for another batch. |
| 5 | `--max-dispatches` spent | `dispatch_limit` | `session continue` if more stages are appropriate. |
| 6 | A stage's `verify` stayed red | `verify_exhausted` | Read `response_path`, fix the cause, `session continue`. |
| 130 | Cancelled | | Ask the user before resuming. |

A stopped session that is not `completed` is resumable. Do not call it done.

### Resume

```
migent session continue <session-id>
```

Resumes until the session stops; a blocked stage runs again. To pass the user's
answer to a blocked stage:

```
migent session continue <session-id> --reply "<reply>"
```

`--reply-file <path>` takes a longer reply. `--once` advances one stage.

## Check a session

```
migent session show <session-id> --json
migent session list --latest --json
```

`show` gives status, latest execution, decision, and outputs. `list --latest`
is the newest session, or `null`. Report the session ID, status, stop reason,
decisions, and the outputs that matter. Output paths are relative to
`.migent/sessions/<session-id>/`; use the paths Migent reports.

## Set up a project

```
migent init --no-input --provider <provider> --model <model-id> [--preset implement|plan] [--skill]
migent doctor --json
```

`--provider` and `--model` go together. The default preset is `implement`.
`--skill` installs this skill; `migent skill update` refreshes it.

## Change models

Edit a model name (updates every role and stage that uses it):

```
migent config model <name> --provider <provider> --model <model-id> --no-input --json
```

Show the config with `migent config`, `migent config model --json`, or
`migent config role --json`.

## Look up anything else

This skill covers the common path. Every command takes `--help`; use it before
guessing a flag:

```
migent --help
migent session run --help
```

References, read only when the task needs them:

| File | Read when |
| --- | --- |
| `references/schema-config.yaml`, `references/schema-workflow.yaml` | Writing config or a workflow. |
| `references/sessions.md` | Prerequisite session (`--prior`), several blocked stages (`--stage`), resuming a cancelled session, raising limits, adopting workflow edits (`--refresh-workflow`). |
| `references/config.md` | Running one role, pointing roles at another model, overriding one role, role instructions. |
| `references/inspect.md` | Filtering `session list`, comparing runs with `session metrics`, `session follow`. |

All paths are under `.agents/skills/migent/`.
