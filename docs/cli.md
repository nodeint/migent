# CLI commands and execution controls

Run commands from the configured project or any of its subdirectories.

Generated tables: [exit codes](reference/exit-codes.md), [`--json` output fields](reference/cli-output.md), [environment variables](reference/env.md).

## Session commands

```bash
# Create a session and run until it stops. --task is one line and is stored in task.md.
migent session run --workflow <workflow> --task "<task>"

# Create a prepared session with an empty task.md and an editable workflow.yaml,
# fill them in, then start it.
# <title> is a display label, such as "some task title". The printed session_id is the next number (`1`, `2`, …).
migent session prepare "<title>" --workflow <workflow>
migent session run --session <session-id>

# Resume a stopped workflow or role session.
# A workflow session runs until it stops and resets revision counts.
# A prepared session is not resumed here; start it with session run --session.
# A blocked workflow stage runs again. The new prompt includes the blocker.
# --reply replaces that prompt body with the reply.
# A role session uses the same command. A cancelled role execution resumes in
# place. A blocked role session runs again. An active role session sends its
# last prompt again. --reply is that role's next user turn. A completed role
# session stays stopped unless --reply is set.
# A cancelled stage (Ctrl+C, SIGTERM, session cancel) also accepts --reply. The
# cancelled execution stays cancelled. The reply runs as a new execution in the
# same conversation, and the prompt first says the previous turn was stopped.
migent session continue <session-id>
migent session continue <session-id> --reply "<reply>"
migent session continue <session-id> --stage <stage> --reply-file <path>

# Adopt the current workflow, agents, and role responsibilities for an existing session.
migent session continue <session-id> --refresh-workflow
migent session run --session <session-id> --workflow <workflow> --refresh-workflow

# Dispatch exactly one eligible stage. This does not reset revision counts.
migent session run --workflow <workflow> --task "<task>" --once
migent session run --session <session-id> --once
migent session continue <session-id> --once

# Run one role. Omit --workflow.
migent session run --role reviewer --prompt "Review the latest changes"
migent session run --role reviewer --session <session-id> --prompt "Summarize the risks"
```

`<workflow>` is the workflow id. A path to a workflow file is also accepted.
The id comes from the file's `id` field, or from the file name when `id` is omitted.
`session run` uses the workflow engine when `--workflow` is present. It runs
one role when `--workflow` is omitted. Passing `--workflow` together with
`--role`, a prompt, `--client`, `--model`, `--option`, or `--json` is an error.
Passing `--once`, `--prior`, `--max-dispatches`,
`--unlimited-dispatches`, `--progress`, `--verbose`, `--refresh-workflow`, or
`--skip-preflight` without `--workflow` is an error.

Before a workflow run starts, `session run` runs the `doctor --session` checks
over every stage. A problem exits 2 and creates or freezes nothing. Pass
`--skip-preflight` to bypass it. `session continue` and `--role` skip it.

`--task` is one line on a workflow run. Migent writes it to
`.migent/sessions/<session-id>/task.md`. The session id is the next number (`1`, `2`, …). The session
title is that line. A longer task uses `session prepare`.
`<title>` is the display label, such as `some task title`. Spaces and capitals
stay. It must be one non-empty line. The command creates the session with status
`prepared`, an empty `task.md`, and an editable `workflow.yaml` copied from the
named workflow, then prints `session_id`, `title`, `status`, `task_path`, and
`workflow_path` on stdout. Write `task.md`, and any companion files in the same
directory, and adjust `workflow.yaml` if needed. Then run
`migent session run --session <session-id>`. The session records its workflow, so
`--workflow` is optional; if passed, its id must match the session. Do not change
`id` in `workflow.yaml`. `session continue` rejects a prepared
session. `session run --session` accepts only a prepared session. Stage prompts
name `task.md` and the session directory. They do not include the task text.
At the first dispatch, Migent validates the draft, freezes it to
`workflow.frozen.yaml`, and records a hash of `task.md`. After that, a change to
`task.md` stops the next dispatch. The draft is the source for this session:
edits to `.migent/workflows/<workflow>.yaml` do not change it, and
`--refresh-workflow` rereads the draft. Older prepared sessions have no draft
and keep the project workflow path stored in their manifest. The title stays
the text from `prepare`.

On a role run, `--task` is the label for a new session and is stored as the title.
The session id is the next number (`1`, `2`, …). `--task` cannot be
combined with `--session`. Pass one of `--prompt`, `--file`, or `--stdin`.
`--client` and `--model` are passed together. `--json` prints one result
object. Without `--json` the result is a table. Exit 0 means the outcome is
complete. Exit 1 means it is not. Exit 130 means the run was cancelled.
A stopped role session prints `migent session continue <session-id>` on
stderr. That command resumes it. `session run --role --session` still sends
a new prompt. Workflow-only flags such as `--once` and `--stage` are rejected
on a role session.
Exit 6 is only for a cancelled role session that reopened more than one
execution and one of them exhausted verify. A single role result uses 0, 1,
and 130.

A failed stage stays stopped. `session continue` runs that stage again.
Exit 3 is `stage_failed`: the command stopped on that failure. A client quota
is a failure like any other: Migent records `failure_reason: quota`, the reset
time as `retry_at` (informational only), the known window as `quota_window`, and a
`provider.quota` event. `failure.md` and `session watch`/`session show` list every stage whose latest execution failed on quota with its message, reset
time and window. Migent
neither sleeps nor retries. Exit 8 is `quota` for `--once` and `--stage`; a
full run reports a quota failure as exit 3. `session continue` runs the stage
again immediately, without regard to `retry_at`.

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
client turn that was cut off is sent again, and a verify that was cut off
runs again. `completed` sessions stay stopped. The
existing session history and artifacts remain available to later stages.

A workflow session keeps the workflow, agents, and role responsibilities from when
it was created, in `workflow.frozen.yaml`. An edit to those files does not
change that session. `session continue` and `session run --session` warn on
stderr and keep the frozen copy. `--refresh-workflow` adopts the current
workflow, agents, and role responsibilities, then resumes. It requires a session
that has a frozen workflow. A creating run, a session without that file, and a
completed or cancelled session exit 2. Starting a prepared session with
`session run --session` does not need the flag: that command reads
the workflow source recorded for the session (`workflow.yaml` for a newly
prepared session, or the recorded project workflow path for an older one) and
writes `workflow.frozen.yaml` regardless, so the flag has no effect on that
start. `session continue` still rejects a prepared session,
and `session run --session` remains the command that starts it.

A workflow run leaves stdout empty. Stderr is plain lines. A stage start line
names the stage, attempt, clock time, client, and model. A stage finish line
names the stage, attempt, duration, outcome, and decision. A completed session
adds `completed · <duration>` and, when the workflow published files, one
`artifact: <absolute-path>` line per file. The path starts at the filesystem
root and names the published file, so the suffix stays, such as `plan.md`. The stage
report is not printed. Every execution that ended failed prints
`failure: executions/<id>/failure.md`, including an attempt that a later retry
recovered from. Exit 1, 3, 6, and 8 also print
`response: executions/<id>/response.md` when the model produced a response;
when the client never started there is no response line.
Exit 7 prints `verify: executions/<id>/turns/01/verify.md`. `--verbose` does not print the
report. Stderr also has the session id when the session is created, and client
errors. When a workflow or role session stops before it is completed, including blocked,
cancelled, and `--once` while later workflow stages remain, stderr ends with:

```text
Resume with:
migent session continue <session-id>
```

The second line is the command. A completed session does not print it.
`--progress` also prints each tool call once,
when it finishes. Item traces and client heartbeats are appended to
`executions/<id>/stream.jsonl`. `session follow` merges that file with
`events.jsonl` in timestamp order. Nothing switches
format because a terminal is attached. `--json` selects machine output where a
command has a human form. Run `migent <command> --help` for stop reasons and
exit codes.

### Session resume

`migent session resume <session> <resume|fresh> [--stage <stage>] [--no-continue] [--json]` decides a resume that
stopped with status `expired` (exit 10). Unlike `session continue`, which continues whatever can run, it records
one decision and runs only that stage. `--no-continue` records and re-folds the status. `--json` (with
`--no-continue`) prints the decision and the decisions still waiting. Exit 2 when the choice, the stage, or the
session state is wrong, or when several decisions wait and `--stage` is missing.

## Init

```bash
migent init
migent init --no-input --agent planning=codex:gpt-5 --agent review=grok:grok-4.7 --agent coding=codex:gpt-5
```

The project template decides which agents init asks for. The packaged template
defines three agents: `planning` (used by the `architect` role), `review`
(`reviewer`), and `coding` (`developer` and `operator`). In a terminal, choose a
client and model for each agent in turn; each selection can include the client's
prompted options. Agents are configured independently and can use the same
model. Each role includes instructions for its responsibilities. Init saves
these selections and creates the project. Install the Migent skill separately afterward:

```bash
migent skill install --project
```

This command reads the configured clients from the project. If installation
fails, retry it; the saved configuration and workflows remain unchanged.
Init does not need `npx`.

Init always writes both workflows:

```text
.migent/
??? config.yaml        # agents (planning, review, coding) and the architect, reviewer, developer, operator roles
??? .gitignore         # ignores sessions/ and optional config.local.yaml
??? workflows/
    ??? implement.yaml # developer implements, reviewer approves or requests revision
    ??? plan.yaml      # architect plans, reviewer approves or requests revision
```

Both workflows route `approved` to completion and `revise` back to the
work stage, with `max_revisions: 3`. The implement workflow can run
independently; it does not require a prior plan session.

There is no preset selection. `config.yaml` has an `agents` section holding
each agent's client, model ID, and selected options; roles refer to agents by
name, so `developer` and `operator` share `coding`. Init also writes an empty
`config.local.yaml` for machine-specific overrides, which Git ignores. Commit
the configuration and workflows. Renaming roles or regrouping them onto agents
is a change to the project template, not to the CLI.

| Flag | Input / purpose |
| --- | --- |
| `--agent NAME=CLIENT:MODEL` | CLI client and model ID for the template agent `NAME`; repeat per agent. The value splits at the first `=` and then the first `:`, so model IDs may contain `:`. |
| `--agent-effort NAME=EFFORT` | Effort for an agent; requires `--agent NAME=...`. |
| `--agent-option NAME:KEY=VALUE` | Model option for an agent; repeat for multiple options. Requires `--agent NAME=...`. |
| `--no-input` | Disable prompts; also set by `MIGENT_NO_INPUT=1`. Every template agent must be given with `--agent`. |

Agents without `--agent` are prompted for in a terminal. An unknown agent name
exits 2 and lists the template's agents. The earlier per-role flags
(`--planner-*`, `--reviewer-*`, `--developer-*`, `--client`, `--model`,
`--effort`, `--option`, and the `--*provider` flags) have been removed and are
rejected as unknown options.

Model IDs and prompted option values come from the selected client CLI.
Omit options to keep client defaults. Invalid selections exit 2 before
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
.migent/config.local.yaml. Local agents: <names>.` to stderr. `--json` prints
one object, `{"config": {...}, "local": {"file": ..., "agents": [...]} | null}`.

`config` is read-only. To change a role, an agent, or the client and model on
this machine, edit `.migent/config.yaml` or `.migent/config.local.yaml` and run
`migent doctor`. `doctor` names every agent that has no local mapping and prints
the YAML to add. The `config` subcommands `show`, `model`, and `role` were removed;
they exit 2 and print this instruction.

## Authoring drafts

```
migent config validate|render|save <draft|-> [--scope project|local] [--format yaml|json] [--json]
migent workflow validate|render|save <draft|-> [--target <file>.yaml | --session <id>] [--format yaml|json] [--json]
migent {config|workflow} save ... [--base-hash <sha256>]
migent {config|workflow} render|save ... [--preserve-comments]
```

These check an unsaved draft with the rules the runtime uses. A config draft is merged with the other layer on disk; a companion layer that cannot be read adds its own diagnostic and the draft is still checked. A workflow draft is checked against the sibling workflows and the effective config.

Validation reports every independent problem in the draft in one run, each with its own `path`. A failed field does not hide other fields or entries, and a problem in one stage does not produce follow-on errors from the checks that read it. A syntax error in the draft still stops validation at the first error.

- `render` prints canonical YAML (`yaml` stringify, key order kept). `save` writes exactly those bytes. Without `--preserve-comments`, comments are not preserved; replacing a file that has comments adds a `comments-dropped` warning.
- `save --preserve-comments` keeps the target's comments, key order, and line-ending style. When the draft's data equals the target's, the target's bytes are written back exactly, including whitespace, quoting, and the final newline. After an edit, comments on kept nodes and the order of kept keys survive while the serializer may normalize other formatting (blank lines, quoting, the final newline); keys absent from the draft are removed. When preservation is impossible (for example the target uses anchors, aliases, merge keys, or custom tags, or the result would not match the draft), the file is written in canonical form with a `comments-not-preserved` warning, plus `comments-dropped` when the old file had comments. The written data always equals the draft's data.
- `render --preserve-comments` prints exactly the bytes `save --preserve-comments` would write to the same target.
- `save` without `--base-hash` only creates a file (exclusive hard link; it never overwrites). With `--base-hash` the file must exist and its raw-byte SHA-256 must match, or the save is a `stale-base` conflict. Both run under a file lock. An editor that writes between the hash check and the rename can still be overwritten. With `--preserve-comments`, the hash is checked before rendering, so a stale base writes nothing.
- A local config draft must carry the current `schema_version`. `--preserve-comments` applies only to `render` and `save`.
- Exit codes: 0 ok (warnings allowed), 1 invalid draft, 2 invocation or I/O error, 3 conflict (`stale-base`, `already-exists`, `session-locked`).

### Session drafts

`workflow validate|render|save ... --session <id>` works on the editable `workflow.yaml` of an existing session instead of a project workflow. It excludes `--target`, applies to `workflow` only, and changes nothing without the flag. The destination is always `.migent/sessions/<id>/workflow.yaml`; a session is never created, and a missing draft is never created.

- The session must be a workflow session whose manifest records its own `workflow.yaml` as `workflow_path` (as `session prepare` does). An invalid id, an unknown session, a symlinked session directory or draft, a role session, a session that runs a project workflow file, and missing or corrupt manifest or status all exit 2 with a structured diagnostic (`invalid-session-id`, `session-not-found`, `session-not-workflow`, `session-source-unsupported`, `session-metadata-missing`, `session-metadata-corrupt`, `session-draft-missing`, `session-draft-invalid`). Nothing falls back to the project workflow or the frozen copy.
- The draft is checked like a project draft (schema, document rules, live config bindings, all findings at once, source ranges), except that it is not a catalog entry: it may share its `id` with its project template without a `duplicate-id` finding, while its `downstream` and `requires` references are still checked against the project workflows. Its `id` must equal the session's recorded workflow id (`session-workflow-id-mismatch`, with the draft position). Diagnostics and `file` name `.migent/sessions/<id>/workflow.yaml`, with `draft: true`.
- `render --preserve-comments` and `save --preserve-comments` use the session draft as the formatting base. Replacing the draft needs its current raw-byte `--base-hash`; without one the save is an `already-exists` conflict, and a stale hash is `stale-base`. A rejected save leaves the draft unchanged.
- `save` takes the session lock before it reads session state and holds it through validation and the write. A held lock exits 3 with `session-locked`. `validate` and `render` are read-only: no lock, no repair, no freeze.
- `save` accepts a `prepared` session, and a started session that is not `completed` or `cancelled`, has a `workflow.frozen.yaml`, and whose lock is free (`active`, `blocked`, `question`). A terminal session exits 2 with `session-terminal`; other states with `session-not-savable`. The persisted status alone never proves a session is stopped: the lock decides.
- **Saving is not applying.** `save` writes only the draft and returns its new `hash`. It does not start or resume the session, rewrite `workflow.frozen.yaml`, touch the manifest, events, or executions, or change `.migent/workflows/`. A prepared session reads the draft at `session run --session <id>`. A started session keeps its freeze until `session continue <id> --refresh-workflow`.
- `get workflow --session` and `doctor --session` report the effective workflow, which is the frozen copy once the session has started. They do not return the draft and its hash; use the hash returned by `save` (or the SHA-256 of the file's bytes) as the next `--base-hash`.
- `--json` prints one envelope: `schema_version`, `command`, `valid`, `diagnostics`, and `rendered`, `file`, `hash`, `written` where they apply. Each diagnostic has `severity`, `code`, `message`, and optionally `source` (`project`, `local`, `effective`, `workflow`), `file`, `draft`, `path` (strings and list indices), `line`, `column`. A draft diagnostic whose `path` resolves in the draft text also carries `end_line` and `end_column`; both are one-based and the end is exclusive. A missing key, or a problem in a file other than the draft, has no position.

## Get

```bash
migent get workflows
migent get workflow plan --json
migent get workflow --session <id> -o yaml
migent get roles | migent get role <name>
migent get agents | migent get agent <name>
migent get config -o json

migent get clients | migent get client <id>
migent get models [--client <id>]
migent get model <id> [--client <id>]
migent get options [--client <id>]
migent get options --native [--client <id>]
migent get option <name> [--client <id>] [--native]
migent get efforts [--client <id>]
migent get effort <model> [--client <id>]
```

`get` looks up what the project defines or what this machine can run without
reading and merging YAML by hand. It is read-only: no writes and no session
lock. Plural forms and `wf` also work.

Project types `workflow`, `role`, `agent`, and `config` read `.migent/`.
`agents` lists the agents the project names (name, client, model, and
whether `config.local.yaml` sets it); `roles` shows each role's agent and
description; `workflows` lists the files in `.migent/workflows/`.

Machine types `client`, `model`, `option`, and `effort` work
outside a project:

- `clients` lists registered CLI clients with `command`,
  `available`, `path`, `effort_option`, and `problems` that hold PATH findings
  only. It runs no subprocess, and a missing client is a row with
  `available: false`, not an error.
- `models` lists the model IDs each client's CLI reports, with the client's
  default model. `options` lists Migent's configured option metadata per client;
  `--native` lists the CLI's parsed headless help catalog instead. `efforts`
  lists the effort values per client and model under the client's native option
  name; a client without an effort option contributes no rows.
- `models`, `options --native`, and `efforts` are the only `get` types that run
  a subprocess, because they ask the client's own CLI for catalog data. A client
  that is not on PATH is skipped without spawning and prints
  `warning: <client>: <command> is not on PATH; skipped.` A failed discovery
  prints its own `warning: <client>: <error>`, and the other clients still
  print. stdout carries only the rendered rows.
- `--client <id>` limits `models`, `options`, and `efforts` to one client and is
  a usage error for the other types; an unknown id exits 2 and lists the valid
  ids. `--native` is valid only for `options`.

Models, options, and efforts are keyed by CLI client. A singular lookup without
`--client` searches every candidate client and never picks one silently: no
match exits 2 and names the clients searched, skipped, or failed; two or more
matches exit 2 and ask for `--client`. `get option effort` without `--client`
is usually ambiguous. `-o name` prints bare names, so a name shared by clients
appears once per client.

- Without a name, a list type prints a table; a name prints that resource as
  YAML. `-o json` prints an array for a list and an object for one resource;
  `-o yaml` prints the same view as YAML; `-o name` prints one bare name per
  line (not valid for `config`). `--json` is the same as `-o json`.
- Every view has `kind` and `name`, snake_case fields, `null` for absent values,
  and `problems` that report an unresolved agent, a broken file, or a missing
  client instead of aborting. `doctor` remains the validator.
- A workflow view gives each stage its `depends_on`, `decisions`, and resolved
  `target` (`client`, `model`, `options`). With `--session <id>` the
  `source.kind` is `draft`, `frozen` (targets are the pinned ones), or `live`.
- Exit 0 on success, including an empty list or a discovery warning. Exit 2 on a
  usage error, an unknown or not-found name, or a configuration error.

`get config` carries the same merged config as `migent config --json` and is not
redacted: `.migent/` config is not a secret store.

## Migrate

```bash
migent migrate
migent migrate --yes
```

`doctor`, `session run`, and `session continue`
stop when `schema_version` is older than this Migent and print
`Schema is outdated. Run migent migrate.` A missing `schema_version` is
version 0. Both `.migent/config.yaml` and an existing
`.migent/config.local.yaml` are migrated independently against the original
merged configuration. Locations with neither a legacy provider nor a client stay
unchanged for validation to report.

`migrate` prints the pending changes and asks before it writes. `--yes` writes
without asking, for a caller that has no terminal. Declining leaves the files
unchanged. Session files follow the same
steps: each `.migent/sessions/<id>/workflow.yaml` draft and the `workflow` in
`workflow.frozen.yaml` are migrated, and the freeze's `source_sha256` is updated
when its draft is rewritten. The upgrade still runs one version at a time. The early versions
keep their historical, provider-keyed `thinking` steps; the step from version 4
to 5 is structural for every client, and version 5 to 6 replaces `provider`
with `client.type`. Version 6 to 7 replaces `produces` and top-level `outputs`
with the artifact registry:

- config: `models` becomes `agents`; an agent's `client: <id>` becomes
  `client.type` and its `options` become `client.options`; a role's
  `default_model` becomes `agent` and its `instructions` become
  `responsibilities`; `provider` becomes `client.type`, or is dropped when the
  other config layer supplies the client.
- workflows: a stage's `model` becomes `agent`, and stage `options` are
  **deleted**. The notes list each deleted option, so you can recreate it as an
  inline `agent` on that stage.
- workflows, 6 to 7: each `produces.artifact` becomes a top-level `artifacts`
  entry referenced from the stage by id, and `outputs` is removed. The id is the
  first output name that names the artifact, else the stage id. Migration
  analyses the whole workflow first and **writes nothing** when it must refuse:
  two stages that would publish the same file name (rename one file), or an id
  that collides or is not a valid artifact id. Otherwise it reports each
  semantic change: an artifact that no v6 output named is now published; an
  artifact in a `run_when` stage becomes `required: false`, is published when
  produced, and its producer gate is relaxed; and several outputs aliasing one
  artifact merge into one (`downstream.artifacts` values are rewritten to that
  id, while the destination context names are kept, so a run without a mapping
  now receives one context name instead of one per alias).

Comments and layout are kept. When a file's layout cannot be edited line by line
(for example flow-style mappings), the file is rewritten as canonical YAML and
the notes say its comments could not be preserved.

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
uses the clients of the agents in the merged `.migent/config.yaml` and `config.local.yaml`, and `skills` asks when
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
migent doctor --session <session-id> [--json]
```

`doctor` checks `.migent/config.yaml`, every file in `.migent/workflows/`,
and whether each client CLI named in config is on `PATH`. It also checks
that each configured model name exists by asking the client CLI for its model
list (see [Model availability](#model-availability)). It does not check login,
quota, or account entitlement. Exit 0 when every check passes, and exit 1
when a check fails. If git tracks `.migent/config.local.yaml`, `doctor` prints
a `warning:` line (and a `warnings` entry with `--json`); a warning does not
change the exit code.

`doctor --session <id>` checks only the workflow that one workflow session runs,
and the client CLIs its stages need. It ignores other workflows, unused roles
and agents, and the installed skill, and it is read-only: it never starts,
freezes, or repairs the session. The source it checks matches what the runtime
uses:

- A prepared session: its editable `workflow.yaml` (source `draft`), validated
  against current config. The workflow `id` must still match the session.
- A started session: its `workflow.frozen.yaml` (source `frozen`). Pinned role
  instructions and stage targets are validated as stored, so removing or
  changing the live workflow or config does not fail it; such differences are
  reported as warnings. A corrupt freeze fails and never falls back to the live
  file.
- An older session without a freeze: its recorded workflow file (source `live`).

Output has the checks `session` (id, workflow id, source kind, path), `workflow`,
`bindings`, and `clients`. With `--json` the object also has
`"session": {"id", "workflow_id", "source", "path"}`; `source` and `path` are
`null` when none could be determined. Exit 0 when every check passes and exit 1
when one fails, including an unknown session, a role session (it has no
workflow), a missing or corrupt manifest or freeze, a broken workflow, or a
missing client CLI. Exit 2 for an invalid session id (such as `../x`) or an
outdated config schema for a draft or live source.

### Model availability

`doctor` checks that each configured model name exists by asking the client
CLI for its model list. A missing name is a problem for `opencode`, `grok`, and
`agy`, and a warning for other clients. An unreadable list is a warning. An agent without `client.type` is checked against the client
Migent infers from its model; a model no client lists, or several clients list, is a configuration
problem (exit 1). See [Agent configuration](agents.md#inferred-client).

```bash
# Edit .migent/sessions/<id>/workflow.yaml, then validate it before starting
migent doctor --session <id>
migent session run --session <id>

# Check a started session's frozen workflow
migent doctor --session <id> --json
```

## Removed provider commands

`migent provider list` and `migent get providers` were removed. Use `migent get
clients`, `migent get models`, `migent get options`, or `migent get efforts`.
The old commands, including `--json`, exit 2 and name those replacements.

`get models` lists the model IDs each CLI client reports and `get efforts`
lists thinking levels per model, so the combined dump is no longer needed. For
discovery behavior, JSON fields, error handling, and exit status, see
[Adapters: Listing and JSON output](adpaters.md#listing-and-json-output).

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
migent session complete <session-id>
migent session complete <session-id> --json
migent session rename <session-id> "<title>"
migent session rename <session-id> "<title>" --json
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

`session rename <session-id> "<title>"` changes only the session's display title.
It takes no session lock, so it works in any status, including while a process
is running the session, and it leaves `task`, `task.md`, events, and lifecycle
state unchanged. The title is trimmed. A title that is empty or contains a line
break exits 2 and changes nothing; an unknown session also exits 2. Exit 0 when
renamed. `--json` prints `{"session_id", "title", "previous_title"}`. See
[Sessions](sessions.md) for where the title is stored.

`session complete <session-id>` marks a stopped workflow session `completed` when
you judge the work is done, without dispatching another stage. It takes the
session lock, so it refuses a session that a live process is running; run
`migent session cancel <session-id>` first. It applies to a workflow session in
status `active` (no live lock), `blocked`, `question`, or `cancelled`. A role
session and a `prepared` session exit 2; start a prepared session with
`migent session run --session <session-id>`. Completion is terminal:
`session continue` leaves the session stopped, and there is no command to reopen
it. Calling it on a `completed` session exits 0, reports that it is already
completed, and changes nothing.

It publishes the outputs a normal completion would, from the current completed
executions, seals `metrics.json`, and writes `next.json`. A required artifact
that cannot be resolved or is empty does not stop the completion: the command
completes the session and warns. Human output goes to stderr:

```text
[migent] Session <id> completed manually.
[migent] warning: required artifact missing: <name>
[migent] artifact: <absolute-path>
[migent] next: <path to next.json>
[migent] migent session run --workflow <workflow> --prior <id>
```

With `--json`, stdout carries exactly one object: `session_id`, `status`,
`already_completed`, `outputs` (a list of `{name, path}` with absolute paths),
`missing_outputs`, and `next` (`{path, suggestions}`, where `path` is null when
no `next.json` exists). Exit 0 on success and when already completed. Exit 2 when
the session does not exist, is a role session, is `prepared`, a live process
holds its lock, or its state is unreadable (repair it first).

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
session is blocked. When a provider exited non-zero without reporting an error
(`provider.exit_anomaly` in `events.jsonl`), the snapshot adds one line per
affected stage, after the `execution` / `running` line:
`exit_anomaly  <stage> · <execution> · turn N · exit C · accepted|rejected [· ×count] · <diagnostics path>`.
It describes the stage's latest anomaly; `×count` is shown above 1 and counts all
of the stage's executions. The JSON snapshot has the same data as an
`exit_anomalies` array (`stage_id`, `execution_id`, `turn`, `exit_code`,
`accepted`, `count`, `diagnostics`), omitted when empty. `diagnostics` is the
session-relative `diagnostics.json` of that execution, or `null` when absent. See
[Session metrics](session-metrics.md#provider-exit-anomalies) for the counters. For a schema 2 session it also prints, on stderr, any drift
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

## Downstream suggestions and prior context

A completed workflow with `downstream` prints a `next.json` path and commands
ready to copy. Run a suggestion using the existing flag:

```bash
migent session run --workflow implement --prior <completed-session-id>
```

A matching suggestion supplies task and named artifacts. `--task` overrides its
task. Without a matching suggestion, provide `--task`; all prior published outputs
become context. Workflows can always run independently without `--prior`.
Prepared sessions freeze current workflow/configuration and prior artifacts at
`run`, allowing manual edits before starting. No downstream is started automatically.
