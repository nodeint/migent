---
name: migent
description: Set up Migent in a project, or configure, run, inspect, and resume its workflows with the migent CLI. Use when the user asks about Migent, .migent/ configuration, workflows, roles, models, sessions, stages, doctor, or published outputs.
---

# Migent

Migent runs a project's multi-stage agent workflows from the `migent` CLI.
A workflow is a set of stages. A stage runs a role, or runs `verify` alone when `role` is omitted. A role uses a model name
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
- `.migent/config.local.yaml`, when present, overrides `config.yaml` on this
  machine. It is not committed. Read both, and edit shared settings in
  `config.yaml`, not the local file.
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

Longer task. `<title>` is a display label such as `some task title`. The command prints a UUID `session_id`:

```
migent session prepare "<title>" --workflow <workflow>
```

Write the task, unchanged, to the printed `task_path` (plus any files next to it).
Do not edit `task.md` once the first stage has started.
Then:

```
migent session run --session <session-id> --workflow <workflow>
```

Dispatch only one stage: add `--once`.

### Read the result

A workflow run prints plain lines on stderr and leaves stdout empty. It does
not print JSON, and it does not print the stage report.

- `session_id: <id>` when the session is created.
- `stage <id> · attempt <n> · <HH:MM:SS> · <provider>/<model> (<options>).` when a stage starts. A description follows the model when the stage has one.
- `stage <id> · attempt <n> · <duration> · <outcome>.` when it finishes. A decision is `decision=<value>` on that line.
- A completed session adds `completed · <duration>` and one `artifact: <absolute-path>` line per published file. The path starts at the filesystem root and names the published file, so the suffix stays, such as `plan.md`. Report those paths.
- Exit 1, 3, 6, and 8 also print `response: executions/<id>/response.md`. Read that file to see why it stopped.
- Exit 7 prints `verify: executions/<id>/turns/01/verify.md`.
- A session that stops before it is completed ends with `Resume with:` and `migent session continue <session-id>`.

- Do not pass `--verbose` or `--progress`. Do not use `session follow`.
- If the command runs in the background, wait for its completion notice. Do not
  add a watcher that waits on the same exit.

### Exit codes

Read the exit code first. Exit 0 with `completed ·` is a completed session.
Exit 0 without that line is `--once` after a complete stage.

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | Completed, or with `--once` the stage is complete | Report each `artifact:` path when the session completed. |
| 1 | Blocked, or with `--once` the stage is not complete | If the stage line says `blocked`: read the `response:` path, then resume with the user's answer (below), or plain `session continue` once the blocker is fixed in the workspace. Otherwise `session continue` keeps going. |
| 2 | Configuration error | Run `migent doctor --json`, fix config. |
| 3 | A stage failed and the command did not wait | Read the `response:` path, fix the cause, `session continue`. Continue runs the stage and does not sleep until an old `retry_at`. |
| 4 | A route would exceed `max_revisions` | Review why the stage keeps being revised, then `session continue` for another batch. |
| 5 | `--max-dispatches` spent | `session continue` if more stages are appropriate. |
| 6 | A stage's `verify` stayed red | Read the `response:` path, fix the cause, `session continue`. |
| 7 | A stage with no role failed `verify` | Read the `verify:` path, fix the tree, `session continue`. That reruns the commands and does not open a provider. |
| 8 | `--once` or `--stage` hit a provider quota and did not wait | Read the `response:` path. `session continue` runs the stage and does not sleep until the recorded `retry_at`. |
| 130 | Cancelled, including a wait that was disarmed | Ask the user before resuming. Continue does not sleep until an old `retry_at`. |

A stopped session that is not `completed` is resumable. Do not call it done.

### Resume

```
migent session continue <session-id>
```

Same command for a workflow session and a role session. Read `session_status`, then use one row.

| Kind | When | What to run |
| --- | --- | --- |
| Workflow | Not `completed`, including a blocker already fixed in the workspace | The command above. Runs until the session stops and resets revision counts. A blocked stage runs again. |
| Workflow | The user answered a blocked stage | Add `--reply "<reply>"`. That text is the whole prompt body. |
| Workflow | One stage, then stop | Add `--once`. Revision counts stay. |
| Role | `cancelled` | The command above. The cut-off turn resumes in the same execution. Omit `--reply`. |
| Role | `active` | The command above. The last prompt is sent again. |
| Role | `blocked` | Add `--reply "<reply>"`. That is the next user turn. With no reply, the agent is only told to continue. |
| Role | `completed` | Leave it stopped. Add `--reply` only to give a new turn. |

`--reply-file <path>` is a longer reply. Pass only one of `--reply` and `--reply-file`. Do not pass `--once` or `--stage` on a role session.

## Check a session

```
migent session show <session-id> --json
migent session list --latest --json
```

`show` gives status, latest execution, decision, and outputs. `list --latest`
is the newest session, or `null`. Both include `title` when the session has one.
Report the session ID, title, status, stop reason,
decisions, and the outputs that matter. Output paths are relative to
`.migent/sessions/<session-id>/`; use the paths Migent reports.

## Set up a project

```
migent provider list --json
migent init --no-input --provider <provider> --model <model-id> [--preset implement|plan] [--skill]
migent doctor --json
```

`--provider` and `--model` go together. The default preset is `implement`.
`provider list --json` shows which provider CLIs are on PATH and what model
ids each supports. Use it to pick a `<provider>` and `<model-id>` for `init`.
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
