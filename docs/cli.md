# CLI commands and execution controls

Run commands from the configured project or any of its subdirectories.

## Session commands

```bash
# Create a session and run until it stops. --task is one line and is stored in task.md.
migent session run --workflow <workflow> --task "<task>"

# Create a prepared session, write a longer task, then start it.
# <title> is a display label, such as "some task title". The printed session_id is a UUID.
migent session prepare "<title>" --workflow <workflow>
migent session run --session <session-id> --workflow <workflow>

# Resume a stopped workflow or role session.
# A workflow session runs until it stops and resets revision counts.
# A prepared session is not resumed here.
# A blocked workflow stage runs again. The new prompt includes the blocker.
# --reply replaces that prompt body with the reply.
# A role session uses the same command. A cancelled role execution resumes in
# place. A blocked role session runs again. An active role session sends its
# last prompt again. --reply is that role's next user turn. A completed role
# session stays stopped unless --reply is set.
migent session continue <session-id>
migent session continue <session-id> --reply "<reply>"
migent session continue <session-id> --stage <stage> --reply-file <path>

# Adopt the current workflow, models, and role instructions for an existing session.
migent session continue <session-id> --refresh-workflow
migent session run --session <session-id> --workflow <workflow> --refresh-workflow

# Dispatch exactly one eligible stage. This does not reset revision counts.
migent session run --workflow <workflow> --task "<task>" --once
migent session run --session <session-id> --workflow <workflow> --once
migent session continue <session-id> --once

# Run one role. Omit --workflow.
migent session run --role reviewer --prompt "Review the latest changes"
migent session run --role reviewer --session <session-id> --prompt "Summarize the risks"
```

`<workflow>` is the workflow id. A path to a workflow file is also accepted.
The id comes from the file's `id` field, or from the file name when `id` is omitted.
`session run` uses the workflow engine when `--workflow` is present. It runs
one role when `--workflow` is omitted. Passing `--workflow` together with
`--role`, a prompt, `--provider`, `--model`, `--option`, or `--json` is an error.
Passing `--once`, `--prior`, `--max-dispatches`,
`--unlimited-dispatches`, `--progress`, `--verbose`, or `--refresh-workflow`
without `--workflow` is an error.

`--task` is one line on a workflow run. Migent writes it to
`.migent/sessions/<session-id>/task.md`. The session id is a UUID. The session
title is that line. A longer task uses `session prepare`.
`<title>` is the display label, such as `some task title`. Spaces and capitals
stay. It must be one non-empty line. The command creates the session with status
`prepared` and prints `session_id`, `title`, `status`, and `task_path` on stdout.
Write that file, and any companion files in the same directory, then
`migent session run --session <session-id> --workflow <workflow>`. The workflow
must be the one stored on the session. `session continue` rejects a prepared
session. `session run --session --workflow` accepts only a prepared session. Stage prompts
name `task.md` and the session directory. They do not include the task text.
After the first dispatch, a change to `task.md` stops the next dispatch.
The title stays the text from `prepare`.

On a role run, `--task` is the label for a new session and is stored as the title.
The session id is a UUID. `--task` cannot be
combined with `--session`. Pass one of `--prompt`, `--file`, or `--stdin`.
`--provider` and `--model` are passed together. `--json` prints one result
object. Without `--json` the result is a table. Exit 0 means the outcome is
complete. Exit 1 means it is not. Exit 130 means the run was cancelled.
A stopped role session prints `migent session continue <session-id>` on
stderr. That command resumes it. `session run --role --session` still sends
a new prompt. Workflow-only flags such as `--once` and `--stage` are rejected
on a role session.
Exit 6 is only for a cancelled role session that reopened more than one
execution and one of them exhausted verify. A single role result uses 0, 1,
and 130.

A failed stage stays stopped. `session continue` runs that stage again and
does not sleep until an old `retry_at`. Exit 3 is `stage_failed`: the command
stopped on that failure and did not wait. Exit 8 is `quota` for `--once` and
`--stage`: the provider named a reset time and the command did not wait.
Cancelling during a wait is exit 130. That disarms the timer. The quota
execution stays `failed`, and the session stays `active` when nothing else
was in flight. The next `session continue` runs the stage and does not sleep
until the recorded `retry_at`.

Workflow `session run` and `session continue` default to 20 stage dispatches
per command. Configure that guard with:

```bash
migent session continue <session-id> --max-dispatches 50
migent session continue <session-id> --unlimited-dispatches
```

A `run_when` skip counts as one dispatch. `--once` dispatches only once and
has no dispatch ceiling. When that one dispatch is a skip, the command exits 0. Do not combine
`--once` with `--max-dispatches` or `--unlimited-dispatches`. Revision limits
are defined by `max_revisions` in
the workflow. `session continue` resets the session's revision counts before
dispatching. `session continue --once` does not. On a blocked session, both
forms dispatch that stage again. The new prompt includes the blocker and the
previous response. `--reply "<text>"` or `--reply-file <path>` sends that
reply on the new execution instead. The prompt body is the reply. The response
contract is still appended, and so is the new artifact directory when the stage
has an artifact. The reply does not repeat the blocker. `--reply` and
`--reply-file` are mutually exclusive. The session must be blocked. When more
than one stage is blocked, `--stage` names the one that receives the reply.
Only that stage is resumed. The others stay blocked. A later stage in the same
command does not receive the reply. A cancelled session is resumed on that same execution: a
provider turn that was cut off is sent again, and a verify that was cut off
runs again. `completed` sessions stay stopped. The
existing session history and artifacts remain available to later stages.

A workflow session keeps the workflow, models, and role instructions from when
it was created, in `workflow.frozen.yaml`. An edit to those files does not
change that session. `session continue` and `session run --session` warn on
stderr and keep the frozen copy. `--refresh-workflow` adopts the current
workflow, models, and role instructions, then resumes. It requires an existing
session that has a frozen workflow. A creating run, a session without that
file, and a completed or cancelled session exit 2. It does not start a prepared
session: `session continue` still rejects one, and `session run --session` is
still the command that starts it.

A workflow run leaves stdout empty. Stderr is plain lines. A stage start line
names the stage, attempt, clock time, provider, and model. A stage finish line
names the stage, attempt, duration, outcome, and decision. A completed session
adds `completed · <duration>` and, when the workflow published files, one
`artifact: <absolute-path>` line per file. The path starts at the filesystem
root and names the published file, so the suffix stays, such as `plan.md`. The stage
report is not printed. Exit 1, 3, 6, and 8 also print
`response: executions/<id>/response.md`. Exit 7 prints
`verify: executions/<id>/turns/01/verify.md`. `--verbose` does not print the
report. Stderr also has the session id when the session is created, and provider
errors. When a workflow or role session stops before it is completed, including blocked,
cancelled, and `--once` while later workflow stages remain, stderr ends with:

```text
Resume with:
migent session continue <session-id>
```

The second line is the command. A completed session does not print it.
`--progress` also prints each tool call once,
when it finishes. Item traces and provider heartbeats are appended to
`executions/<id>/stream.jsonl`. `session follow` merges that file with
`events.jsonl` in timestamp order. Nothing switches
format because a terminal is attached. `--json` selects machine output where a
command has a human form. Run `migent <command> --help` for stop reasons and
exit codes.

## Init

```bash
migent init
migent init --no-input --planner-provider codex --planner-model gpt-5 --reviewer-provider grok --reviewer-model grok-4.7 --provider codex --model gpt-5
```

In a terminal, choose a provider and model for the planner, then the reviewer,
then the developer. Each selection can include the provider's prompted options.
All three roles are configured independently and can use the same model.
Each role includes instructions for its responsibilities. Init saves these
selections and creates the
project. Install the Migent skill separately afterward:

```bash
migent skill install --project
```

This command reads the configured clients from the project. If installation
fails, retry it; the saved configuration and workflows remain unchanged.
Init does not need `npx`.

Init always writes both workflows:

```text
.migent/
??? config.yaml        # developer, planner, reviewer with inline models and instructions
??? .gitignore         # ignores sessions/ and optional config.local.yaml
??? workflows/
    ??? implement.yaml # developer implements, reviewer approves or requests revision
    ??? plan.yaml      # planner plans, reviewer approves or requests revision
```

Both workflows route `approved` to completion and `revise` back to the
work stage, with `max_revisions: 3`. The implement workflow can run
independently; it does not require a prior plan session.

There is no preset selection. `config.yaml` contains each role's provider,
model ID, and selected options directly; no `models` section or
`config.local.yaml` is generated. Commit the configuration and workflows.
Use the optional local file later for machine-specific overrides.

| Flag | Input / purpose |
| --- | --- |
| `--planner-provider`, `--planner-model` | Planner provider and model ID; pass together. |
| `--planner-option KEY=VALUE` | Planner model option; repeat for multiple options. |
| `--reviewer-provider`, `--reviewer-model` | Reviewer provider and model ID; pass together. |
| `--reviewer-option KEY=VALUE` | Reviewer model option; repeat for multiple options. |
| `--provider`, `--model` | Developer provider and model ID; pass together. |
| `--option KEY=VALUE` | Developer model option; repeat for multiple options. |
| `--no-input` | Disable prompts; also set by `MIGENT_NO_INPUT=1`. All three role selections are required. |

Model IDs and prompted option values come from the selected provider CLI.
Omit options to keep provider defaults. Invalid selections exit 2 before
writing project files. Missing flags include a complete command example.

Init never starts an agent. It prints the chosen models, created files,
`migent skill install --project`, and a
`migent session run --workflow implement --task "<what you want done>"`
command. Use `--workflow plan` to run planning and review instead.
Doctor problems are advisory on stderr; interactive setup also shows the
full doctor report. Successful project creation exits 0.

An existing valid project is left unchanged; model selection flags are
ignored and init prints the next commands again.
A partial project, including a lone `config.local.yaml`, exits 1 and lists
conflicting files without overwriting them.

`init --skill` has been removed. It exits 2 with instructions to run
`migent init` followed by `migent skill install --project`.

## Config

```bash
migent config
migent config --json
```

`config` prints the effective config and exits 0. Without
`.migent/config.local.yaml` it prints `.migent/config.yaml` as stored. With it,
`config` prints the merged config as YAML and writes `Merged with
.migent/config.local.yaml. Local models: <names>.` to stderr. `--json` prints
one object, `{"config": {...}, "local": {"file": ..., "models": [...]} | null}`.

`config` is read-only. To change a role, an alias, or the provider and model on
this machine, edit `.migent/config.yaml` or `.migent/config.local.yaml` and run
`migent doctor`. `doctor` names every alias that has no local mapping and prints
the YAML to add. The `config` subcommands `show`, `model`, and `role` were removed;
they exit 2 and print this instruction.

## Migrate

```bash
migent migrate
migent migrate --yes
```

`doctor`, `session run`, and `session continue`
stop when `schema_version` is older than this Migent and print
`Schema is outdated. Run migent migrate.` A missing `schema_version` is
version 0.

`migrate` prints the pending changes and asks before it writes. `--yes` writes
without asking, for a caller that has no terminal. Declining leaves the files
unchanged. The upgrade still runs one version at a time. Each provider defines
its own function for a model, a role, and a stage at that version.

## Project skill

```bash
migent skill install [--project | --global] [--client <ids>] [-y]
migent skill update  [--project | --global] [--client <ids>] [-y]
migent skill path
```

`skill install` and `skill update` run `npx skills add <bundled skill> -s migent
--copy`, so they need Node 22.20 or newer and `npx` on PATH. `skills` sends
anonymous telemetry; Migent sets `DISABLE_TELEMETRY=1` unless you already set it.

`install` needs a scope. In a terminal it asks "Project" or "Global"; otherwise
pass `--project` or `--global`. `--client` takes a comma-separated list of
`claude-code`, `codex`, `opencode`, `agy`, `grok`. Without it, project scope
uses the clients of the models in the merged `.migent/config.yaml` and `config.local.yaml`, and `skills` asks when
none are known. Project scope writes to the client's project directory
(`.claude/skills`, `.agents/skills` for codex, opencode and agy, `.grok/skills`);
global scope writes under your home directory the same way.

`update` scans every client directory in both scopes and reinstalls the copies
whose files differ from the skill bundled with this CLI (line endings ignored).
It asks first, because a copy may hold local edits; `-y` skips the question.
`npx skills update` does not upgrade this skill; use `migent skill update`.

`skill path` prints the bundled skill directory.

## Doctor

```bash
migent doctor
migent doctor --json
```

`doctor` checks `.migent/config.yaml`, every file in `.migent/workflows/`,
and whether each provider CLI named in config is on `PATH`. It does not run
those CLIs or check their login. Exit 0 when every check passes, and exit 1
when a check fails. If git tracks `.migent/config.local.yaml`, `doctor` prints
a `warning:` line (and a `warnings` entry with `--json`); a warning does not
change the exit code.

## Providers

```bash
migent provider list
migent provider list --json
```

`provider list` reports every registered provider provider (agy, claude, codex,
grok, opencode), whether its CLI is on `PATH`, the model ids that CLI reports,
and the provider options the provider exposes. It works without `.migent/config.yaml`.

Model ids come from running each provider's model-listing command: `codex debug models`,
`grok models`, `opencode models`, and `agy models`. Claude has no listing command, so
migent runs `claude --version` to confirm the CLI works and reports its built-in model
names. The JSON output includes `default_model` when the provider reports one.

Options lists the names of options each provider supports (`prompt`, `allow_default`,
`overridable`). Per-model option values are not fetched, since that would cost a CLI
call per model and option.

Exit 0 when at least one provider returned models. Exit 1 when no provider returned
any models. A missing optional CLI is not an error; it is reported as a per-provider
problem, and the command still exits 0 if other providers work.

`--json` output shape:
```json
{
  "ok": true,
  "providers": [
    {
      "name": "codex",
      "command": "codex",
      "path": "/usr/bin/codex",
      "available": true,
      "models": ["gpt-5", "gpt-4o"],
      "default_model": null,
      "options": [
        { "name": "model_reasoning_effort", "prompt": true, "allow_default": true, "overridable": true }
      ],
      "problems": []
    }
  ]
}
```

## Workspace registry

```bash
migent service start [--port N] [--foreground]
migent service stop
migent service status [--json]

migent workspace register [--path DIR] [--name TEXT]
migent workspace list [--json]
migent workspace remove ID
```

`service start` runs a registry on `127.0.0.1`. The default port is 47321.
Without `--foreground` it detaches and adopts an instance only when the
service's local endpoint (a Unix socket, or a named pipe on Windows) and its
authenticated health both name the instance in `service.json`.
`--foreground` serves in the current process until SIGINT or SIGTERM.
`service stop` asks the instance to exit through that endpoint and ends the
process only if it does not. Stop is idempotent: it exits 0 when the service
is already absent or was stopped, and exits 1 when the process is still alive
or its identity cannot be verified. A service started by Migent 0.1 must be
stopped with that version. `status` is a query. It prints `running` or
`stopped` and exits 1 when the service is stopped. `--json` output is
unchanged. A stale `service.json` is `stopped`.
The bearer token is not printed.

`workspace register` records the directory that contains
`.migent/config.yaml`. A relative `--path` is resolved from the invocation
directory, and the stored path is that absolute root. Registering the same
resolved path again keeps the same id. `list` shows `available: false` when
the config file is gone. `remove` drops one id and exits 2 when the id is
unknown. The registry listens for clients on `http://127.0.0.1:{port}`.

## Inspect sessions

```bash
migent session list
migent session list --latest --json
migent session list --workflow <id> --status completed --json
migent session show <session-id>
migent session show <session-id> --json
migent session metrics <session-id> --json
migent session metrics --json --workflow <id> --status completed --limit 10
migent session follow <session-id>
migent session follow <session-id> --exit-when-done
migent session repair <session-id>
migent session repair <session-id> --accept-task
migent session cancel <session-id>
migent session cancel <session-id> --wait 60 --json
```

`session cancel` stops a session that another process is running, without a
signal. It writes `cancel.requested` in the session directory. The process that
holds the session lock sees it within about 500 ms and stops as if it received
SIGINT: the execution is marked cancelled, the process exits 130, and the lock
is released. `session continue` then resumes it. The command waits up to
`--wait` seconds (default 15) for the lock to go away. Exit 0 when the session
stopped, 1 when it is still running after the wait, 2 when the session does not
exist, no live process holds its lock, or the lock belongs to another machine.
A session that is not running is left unchanged. `--json` prints
`{"session_id", "cancelled", "status"}`.

`session list` lists recorded runs, newest first. A row with a title prints that
title before the session id. A row without one prints the id. `--workflow` and `--status`
select rows before `--limit`. `--status` is `active`, `prepared`, `completed`,
`blocked`, or `cancelled`. `--latest` prints the newest match. `--latest`
cannot be combined with `--limit`. An empty list exits 0.

`session metrics` prints `metrics.json`, written when a workflow session
becomes `completed`. Pass a session id for one JSON object. Omit it for one object per
line, newest first. Only sessions with that file appear. `--workflow`,
`--status`, and `--limit` filter those rows. `--json` is required: without it
the command exits 2 with `session metrics requires --json.` A session with no
`metrics.json` exits 2 with
`No metrics for session: <id>. Metrics are recorded when a workflow session completes.`
A file that is not a JSON object exits 2 with
`metrics.json for session <id> is not valid JSON.` and stays in place. An
empty list prints nothing and exits 0. The command does
not take the session lock.

`session show <session-id>` prints one snapshot and exits 0, including when the
session is blocked. For a schema 2 session it also prints, on stderr, any drift
between `status.json` and the fold of the session files. `session follow` prints
that snapshot and then follows events until a signal. It merges `events.jsonl`
with each execution's `stream.jsonl` in timestamp order. Item traces and
provider heartbeats are the lines in the stream. `--cursor` is a byte offset
into `events.jsonl` and skips the snapshot. `0` replays the whole log and every
stream. Any other offset replays `events.jsonl` from that byte, and stream lines
whose timestamp is at or after the first complete event at or after that byte.
A cursor at the end of the file tails every stream from its end. A stream
created after follow starts is read from the beginning. `--json` is an array
for a list, one object for `--latest`
(`null` when nothing matches), one object for a snapshot, and a snapshot
object followed by JSON lines while following. With `--cursor`, follow prints
only JSON lines. JSON list rows include `title` and omit `task`. The JSON snapshot
includes `title` when the session has one, and omits `task`. The human
list and snapshot still print the task. The human list prints the title when it
differs from the session id. `--exit-when-done` is opt-in and exits when
the session status is completed (0), blocked (1), or cancelled (130).

A role run prints its new session id on stderr as soon as the session exists.
`--json` prints one result object on stdout. Without `--json` the result is a
table. Use `--file PATH` or `--stdin` instead of `--prompt`.
