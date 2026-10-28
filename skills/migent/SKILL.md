---
name: migent
description: Set up, configure, run, inspect, and resume Migent workflows and role sessions with the migent CLI.
---

# Migent

Run a project's agent workflows with `migent`. Each run is a session you can
inspect and continue.

## Before running or editing

- Work from the project root. Read `.migent/config.yaml`, its optional
  `config.local.yaml`, and the selected workflow before running it.
- Before editing configuration or workflows, read the matching schema in
  `references/`. Use only documented keys, then run `migent doctor --json`.
  If doctor reports an outdated schema, run `migent migrate --yes`.
- Pass the user's task unchanged. Leave reading `task.md` and its referenced
  documents to the stage agent. Do not edit `task.md` after stages start.
- Do not edit generated session files. Use the CLI to inspect and resume.
- Resume the same session after errors or limits; do not create a replacement
  to bypass them. Ask before resuming a cancelled session.

## Set up a project

```bash
migent provider list --json
migent init --no-input --provider <provider> --model <model-id> [--preset implement|plan] [--skill]
migent doctor --json
```

Choose an available provider and model ID from `provider list`.
Pass `--provider` and `--model` together; use `--no-input` for unattended setup.
The default preset is `implement`; `--skill` installs this skill.

Output: configuration and a workflow under `.migent/`, setup diagnostics, and
the next run command. `init` does not start an agent. For an existing project,
follow [config.md](references/config.md) instead of running `init` again.
Refresh an installed skill with `migent skill update` after upgrading Migent.

## Run a workflow

Input: a workflow ID or file path and the user's task.

```bash
migent session run --workflow <workflow> --task "<task>"
```

For a longer task, prepare a session:

```bash
migent session prepare "<title>" --workflow <workflow>
```

Output: `session_id` and `task_path`. Write the unchanged task to `task_path`,
with supporting files beside it, then run:

```bash
migent session run --session <session-id> --workflow <workflow>
```

The command runs until the session stops. Add `--once` to dispatch one stage.
If it runs in the background, wait for completion; do not add another watcher.
Do not pass `--verbose` or `--progress`, or use `session follow` to wait.

### Output and errors

Workflow runs print progress on stderr, not JSON on stdout. Use the reported
`session_id`, outcome, decision, and diagnostic paths. Read the reported
`response:` or `verify:` file when a run stops with an error.

| Exit | Result | Action |
| --- | --- | --- |
| 0 | Completed, or one stage completed with `--once` | Only report the session complete when `completed` is printed. Report each published `artifact:` path exactly. |
| 1 | Blocked or incomplete | Read the response. Resolve the blocker or obtain the user's reply, then continue. |
| 2 | Configuration error | Run `migent doctor --json`, fix the reported configuration, and retry. |
| 3 | Stage failed | Read the response, fix the cause, and continue. |
| 4 | Revision limit | Review repeated feedback before continuing another batch. |
| 5 | Dispatch limit | Continue if more stages are appropriate. |
| 6 | Agent stage failed verification | Read the response, fix the cause, and continue. |
| 7 | Verification-only stage failed | Read the verify report, fix the workspace, and continue to rerun checks. |
| 8 | Provider quota reached with `--once` or `--stage` | Read the response; resolve the quota or wait for availability before continuing. |
| 130 | Cancelled | Ask the user before continuing. |

A stopped session is not necessarily complete. Continue retries immediately;
it does not wait for a previously recorded retry time.

## Inspect and continue

```bash
migent session show <session-id> --json
migent session list --latest --json
migent session continue <session-id>
```

`show` returns status, latest execution, decisions, and outputs. `list --latest`
returns the newest session or `null`. Report the ID, title when present, status,
stop reason, and relevant decisions and outputs. Paths from `show` are relative
to `.migent/sessions/<session-id>/`.

Use the session status to choose how to continue:

| Session | Action |
| --- | --- |
| Workflow stopped, including a resolved blocker | Continue; add `--reply "<reply>"` when the user answered a blocker. The reply is the whole prompt body. |
| Workflow, one stage only | Continue with `--once`. |
| Role cancelled | Continue without `--reply` to resume the interrupted turn. |
| Role active | Continue to resend the last prompt. |
| Role blocked | Continue with `--reply "<reply>"` for the user's answer; without it, the agent is told to continue. |
| Role completed | Leave stopped unless the user supplies a new turn with `--reply`. |

For a long reply, use `--reply-file <path>` instead of `--reply`.
Do not use `--once` or `--stage` with a role session.

## Configure or use other commands

Edit YAML directly, then run `migent doctor --json`. Use `migent config --json`
to inspect the effective settings. Read only the reference needed for the task:

| Reference | Use for |
| --- | --- |
| [config.md](references/config.md) | Models, roles, machine setup, and running one role. |
| [schema-config.yaml](references/schema-config.yaml) | Writing configuration. |
| [schema-workflow.yaml](references/schema-workflow.yaml) | Writing workflows. |
| [sessions.md](references/sessions.md) | Prerequisites, multiple blockers, limits, and adopting workflow changes. |
| [inspect.md](references/inspect.md) | Filtering sessions, metrics, and live progress. |

Use `migent <command> --help` before using an unfamiliar flag.
