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
- Treat `.migent/sessions/` as generated, resumable state. Do not edit its
  files directly.
- Preserve the user's task wording when passing `--task`.
- Stdout carries the result; stderr carries progress and notices.

## Set up

```
migent init --no-input --provider <provider> --model <model-id> [--preset implement|plan] [--option KEY=VALUE] [--skill]
migent doctor --json
```

`--provider` and `--model` go together. `--preset` picks the workflow to
create (default `implement`). `--skill` installs this skill at
`.agents/skills/migent`; `migent skill update` refreshes a managed copy.

## Run workflows

- Start: `migent start <workflow> --task "<task>"`. `<workflow>` is a
  workflow id, or a path to a workflow file (the `id` field defaults to the
  file name). Runs until the session stops.
- Start and dispatch one stage only: add `--once`.
- If the workflow's `requires` block names a prerequisite workflow and
  decision, find a completed session of that workflow with that decision in
  `migent sessions --json` and pass `--prior <session-id>`. `continue` accepts
  `--prior` too.
- Resume an active session: `migent continue <session-id>`. This resets
  revision counts. `migent continue <session-id> --once` advances one stage
  and does not reset them.

Limits, accepted by `start` and `continue`:

- `--attempts <n>`: failed executions allowed for one stage (default 3). On
  `continue` it sets a new total, not extra retries.
- `--max-dispatches <n>`: stage dispatches allowed in this command (default
  20). `--unlimited-dispatches` removes the ceiling; use it only if the user
  agrees.

### Exit codes and stop reasons

The result object on stdout includes `stop_reason`. Read the exit code first.

| Exit | Meaning | `stop_reason` | Session | What to do |
| --- | --- | --- | --- | --- |
| 0 | Completed (with `--once`: stage complete) | | completed or advancing | Report outputs. |
| 1 | Blocked (with `--once`: stage not complete) | | see snapshot | Inspect the latest execution, fix the cause. |
| 2 | Configuration error | | unchanged | Run `migent doctor --json`, fix config. |
| 3 | `--attempts` spent | `retry_exhausted` | active | Inspect the failing execution, fix it, then `continue` (add `--attempts` for a higher total). |
| 4 | A route would exceed `max_revisions` | `revisions_exhausted` | active | Review why the stage keeps being revised; `continue` (without `--once`) resets counts for another batch. |
| 5 | `--max-dispatches` spent | `dispatch_limit` | active | `continue` the same session if more stages are appropriate. |
| 130 | Cancelled | | see snapshot | Ask the user before resuming. |

A stopped active session is resumable; do not describe it as completed. Do
not start a replacement session to reset limits. If you change a workflow or
config while a session is active, run `migent doctor --json` and tell the user the
session was created under the earlier definition.

## Inspect sessions

- List: `migent sessions` or `migent sessions --json`.
- Snapshot, including `stop_reason` and executions:
  `migent sessions <session-id> --json`.
- Follow events: `migent sessions <session-id> --follow`. This runs until
  signalled, so add `--exit-when-done` (exits 0 completed, 1 blocked, 130
  cancelled) or `--execution <id> --until`.
- To poll without replaying, use `--follow --json --cursor <offset>`
  (byte offset in `events.jsonl`; `0` replays everything).

Report the session ID, status, stop reason, decisions, and published outputs
that matter to the user. Published output paths are relative to
`.migent/sessions/<session-id>/`; use the paths Migent reports instead of
guessing.

## Ad hoc role execution

Only when the user asks to run a role outside a workflow:

```
migent agent --role <role> --prompt "<prompt>"
```

Use `--file <path>` or `--stdin` for long or multi-line prompts. `--task`
labels a new session and cannot be combined with `--session <session-id>`,
which continues an earlier `agent` session. `--provider`/`--model` (together)
and `--option KEY=VALUE` override the role for this turn. Add `--json` for one
result object. Exit 0 means the outcome is complete, 1 not complete.

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
