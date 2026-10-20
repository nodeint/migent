# CLI commands and execution controls

Run commands from the configured project or any of its subdirectories.

## Session commands

```bash
# Create a session and run until it stops. --task is one line and is stored in task.md.
migent session run --workflow <workflow> --task "<task>"

# Create a prepared session, write a longer task, then start it.
migent session prepare <some-id> --workflow <workflow>
migent session run --session <some-id> --workflow <workflow>

# Resume an active or blocked workflow session and run until it stops.
# This resets revision counts. A prepared session is not resumed here.
# A blocked session runs that stage again. The new prompt includes the blocker.
migent session continue <session-id>

# Adopt the current workflow, models, and role instructions for an existing session.
migent session continue <session-id> --refresh-workflow
migent session run --session <some-id> --workflow <workflow> --refresh-workflow

# Dispatch exactly one eligible stage. This does not reset revision counts.
migent session run --workflow <workflow> --task "<task>" --once
migent session run --session <some-id> --workflow <workflow> --once
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
Passing `--once`, `--prior`, `--attempts`, `--max-dispatches`,
`--unlimited-dispatches`, `--progress`, `--verbose`, or `--refresh-workflow`
without `--workflow` is an error.

`--task` is one line on a workflow run. Migent writes it to
`.migent/sessions/<session-id>/task.md`. A longer task uses `session prepare`.
`<some-id>` is a lowercase slug such as `wave-3`: letters, digits, and single
hyphens. The command creates the session with status `prepared` and prints
`session_id`, `status`, and `task_path` on stdout. Write that file, and any
companion files in the same directory, then
`migent session run --session <some-id> --workflow <workflow>`. The workflow
must be the one stored on the session. `session continue` rejects a prepared
session. `session run --session --workflow` accepts only a prepared session. Stage prompts
name `task.md` and the session directory. They do not include the task text.
After the first dispatch, a change to `task.md` stops the next dispatch.

On a role run, `--task` is only a label for a new session and cannot be
combined with `--session`. Pass one of `--prompt`, `--file`, or `--stdin`.
`--provider` and `--model` are passed together. `--json` prints one result
object. Without `--json` the result is a table. Exit 0 means the outcome is
complete. Exit 1 means it is not.

Workflow `session run` and `session continue` default to three failed execution
attempts per stage and 20 stage dispatches per command. Configure those guards
with:

```bash
migent session continue <session-id> --attempts 5
migent session continue <session-id> --max-dispatches 50
migent session continue <session-id> --unlimited-dispatches
```

`--attempts N` is the total failed-execution allowance for one stage, not an
additional retry count. `--once` dispatches only once and has no dispatch
ceiling. Do not combine `--once` with `--attempts`, `--max-dispatches`, or
`--unlimited-dispatches`. Revision limits are defined by `max_revisions` in
the workflow. `session continue` resets the session's revision counts before
dispatching. `session continue --once` does not. On a blocked session, both
forms dispatch that stage again. The new prompt includes the blocker and the
previous response. A cancelled session is resumed on that same execution: a
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

A workflow run's stdout is one JSON result: `session_id`, `session_status`, `stop_reason`,
`latest_decision`, and `outputs`. Exit 1, 3, and 6 also include
`latest_execution_id` and `response_path` (relative to the session directory).
`--verbose` adds `stages`, including each stage's response text. Stderr is the
session id, one line when a stage starts, one line when it finishes, provider
errors, and the resume hint. `--progress` also prints each tool call once,
when it finishes. Item traces and provider heartbeats are appended to
`executions/<id>/stream.jsonl`. `session follow` merges that file with
`events.jsonl` in timestamp order. Nothing switches
format because a terminal is attached. `--json` selects machine output where a
command has a human form. Run `migent <command> --help` for stop reasons and
exit codes.

## Init

```bash
migent init
migent init --provider codex --model gpt-5
migent init --preset plan --provider codex --model gpt-5
migent init --skill --provider codex --model gpt-5
```

`init` writes `.migent/config.yaml`, one workflow, and `.migent/.gitignore`.
The config contains the provider and model you choose. Model ids come from
that provider's CLI, not from a built-in list. Prompted options come from
that provider for the model you picked. Omit `--option` to keep the provider
default. The default workflow is `implement`, a single developer
stage. `--preset plan` writes a planner and a reviewer. In a terminal,
provider, model, and prompted options are chosen from lists. Both `plan`
roles use that model; give the reviewer another with `migent config role
reviewer`. In a terminal, init also asks whether to
install the Migent skill at `.agents/skills/migent/`. `--skill` installs that
skill without asking. Pass `--provider` and `--model` together when input is
not a terminal, or when `--no-input` or `MIGENT_NO_INPUT=1` is set. Without
`--skill`, a non-interactive init leaves the skill uninstalled. After the
files are written, init exits 0. An interactive init prints the doctor
report on stdout. A non-interactive init does not. Doctor problems are
printed as an advisory on stderr. An existing project ignores `--provider`,
`--model`, `--option`, and an explicit `--preset`, and says so. `--skill`
still installs.

An existing valid project is left unchanged. `--skill` still installs the
skill on that project. A partial `.migent/` directory stops init and lists
the files in the way. Init writes nothing when the skill directory already
exists and installation was requested.

## Config

```bash
migent config
migent config show
migent config model
migent config model <name> --provider grok --model grok-4.7 --option reasoning-effort=medium
migent config role
migent config role reviewer --model-name plain
migent config role reviewer --provider grok --model grok-4.7 --option reasoning-effort=high
```

`config` and `config show` print `.migent/config.yaml` as stored and exit 0.
`config model` and `config role` accept `--no-input` (and `MIGENT_NO_INPUT=1`).
With no changes they still list and exit 0.

## Migrate

```bash
migent migrate
migent migrate --yes
```

`doctor`, `config model`, `config role`, `session run`, and `session continue`
stop when `schema_version` is older than this Migent and print
`Schema is outdated. Run migent migrate.` A missing `schema_version` is
version 0.

`migrate` prints the pending changes and asks before it writes. `--yes` writes
without asking, for a caller that has no terminal. Declining leaves the files
unchanged. The upgrade still runs one version at a time. Each adapter defines
its own function for a model, a role, and a stage at that version.

In a terminal, `config model` or `config role` with no arguments opens a list.
`--no-input` and `MIGENT_NO_INPUT=1` keep the list. Cancelling a prompt exits
130 and prints nothing. `migrate` still treats cancel as a decline.
The last choice adds a model or a role. Choosing a model edits that entry.
Choosing a role points that role at a model, or adds a model for it.

Pass the flags to write without prompts. `--model` is the provider model id.
`--model-name` is the name under `models:` in `.migent/config.yaml`, not a
provider model id.
`--provider` and `--model` are passed together. Model ids come from that
provider's CLI. Prompted option values come from that provider for the chosen model.

`config model <name>` creates a missing name and updates an existing one. An
update changes every role and stage that uses the name. `--option KEY=VALUE`
sets one entry under `options` and leaves the others in place.
`--clear-option KEY` removes it.

`config role <role> --model-name <name>` changes only that role's
`default_model`. Several roles can share one `--model-name`.
`config role <role> --provider <provider> --model <model-id>` reuses an entry
with the same provider, model id, and empty options, or adds a new name, and
points only that role at it. A shared entry is left unchanged.
`--option` on `role` writes `roles.<role>.options` for one role.

After a write, the command names the roles that changed, the stages that
follow, and the stages that stay put because they set their own `model` or
`options`. A model name that nothing points at anymore is reported and kept.
The command then runs `doctor`.

`--json` prints one object. Exit 0 when a list is shown or the write passes
doctor. Exit 1 when the file is written and doctor fails. Exit 2 when the
arguments are rejected, before the file changes.

## Project skill

```bash
migent skill install
migent skill update
```

`skill install` writes the bundled Migent usage skill to
`.agents/skills/migent/` in the configured project. It refuses to replace an
existing directory.

`skill update` refreshes a skill previously installed by Migent. It refuses
to overwrite local changes; use `migent skill update --force` when replacing
those changes is intentional. The installed template metadata is kept beside
`SKILL.md` in `.migent-template.json`.

## Doctor

```bash
migent doctor
migent doctor --json
```

`doctor` checks `.migent/config.yaml`, every file in `.migent/workflows/`,
and whether each provider CLI named in config is on `PATH`. It does not run
those CLIs or check their login. Exit 0 when every check passes, and exit 1
when a check fails.

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
migent session follow <session-id>
migent session follow <session-id> --exit-when-done
migent session repair <session-id>
migent session repair <session-id> --accept-task
```

`session list` lists recorded runs, newest first. `--workflow` and `--status`
select rows before `--limit`. `--status` is `active`, `prepared`, `completed`,
`blocked`, or `cancelled`. `--latest` prints the newest match. `--latest`
cannot be combined with `--limit`. An empty list exits 0.

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
only JSON lines. JSON list rows and the JSON snapshot omit `task`. The human
list and snapshot still print it. `--exit-when-done` is opt-in and exits when
the session status is completed (0), blocked (1), or cancelled (130).

A role run prints its new session id on stderr as soon as the session exists.
`--json` prints one result object on stdout. Without `--json` the result is a
table. Use `--file PATH` or `--stdin` instead of `--prompt`.
