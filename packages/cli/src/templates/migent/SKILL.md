---
name: migent
description: Set up Migent in a project, or configure, run, inspect, and resume its workflows. Use when the user asks about Migent configuration, workflows, sessions, stages, or published outputs.
---

# Migent

Use Migent as the control plane for the project's multi-stage agent workflows.

## Working rules

- For an existing project, work from the root containing
  `.migent/config.yaml`. To set up a new project, run `migent init` from
  its root and follow the CLI's provider and model prompts or flags.
- Read `.migent/config.yaml` and the relevant file under
  `.migent/workflows/` before changing or running a workflow.
- Run `migent doctor` after editing configuration or workflows.
  `migent config model` and `migent config role` run it after a write.
- Treat `.migent/sessions/` as generated, resumable state. Do not edit its
  files directly.
- Preserve the user's task wording when passing `--task`.
- Before continuing a stopped session, inspect the command's `stop_reason` and
  latest execution. Fix the cause before retrying.

## Choose the command

- Start a workflow: `migent start <workflow> --task "<task>"`. `<workflow>`
  is the workflow id, or a path to a workflow file. An omitted `id` uses the
  file name. If its
  `requires` block names a prerequisite workflow and decision, find a matching
  completed session and add `--prior <session-id>`.
- Resume an active session: `migent continue <session-id>`. This resets
  revision counts. `migent continue <session-id> --once` advances one stage
  and does not reset them. Create and dispatch one stage with
  `migent start <workflow> --task "<task>" --once`.
- List recorded sessions: `migent sessions` or `migent sessions --json`.
- Inspect a snapshot: `migent sessions <session-id> --json`.
- Follow new events: `migent sessions <session-id> --follow`.
- Run a configured role outside a workflow only when the user asks for ad hoc
  role execution: `migent agent --role <role> --prompt "<prompt>"`. Continue
  that session with `--session <session-id>`.
- Read `.migent/config.yaml`: `migent config` or `migent config show`.
- Change a model entry: `migent config model <name> --provider <provider> --model <model-id>`.
  This updates every role and stage that uses the name.
- Point one role at a model without changing a shared entry:
  `migent config role <role> --provider <provider> --model <model-id>`.
  `migent config role <role> --model-name <name>` points it at a name that
  already exists. Add `--json` to read the result.

Workflow commands emit progress on stderr and one result object on stdout.
Report the session ID, session status, stop reason, decisions, and published
outputs that matter to the user. A stopped active session is resumable; do not
describe it as completed.

`retry_exhausted` means the stage has used its total failed-attempt allowance;
`--attempts` on `continue` sets a new total, not extra retries.
`revisions_exhausted` leaves the session active. `continue` resets revision
counts for the existing session, allowing another batch up to `max_revisions`.
`continue --once` does not reset them. `dispatch_limit` applies to the current
command; continue the same session if further stages are appropriate. Do not
start a replacement session to reset these limits. Stdout is the result and
stderr is progress and notices.

Published output paths are relative to
`.migent/sessions/<session-id>/`. Prefer the paths reported by Migent over
guessing artifact locations.
