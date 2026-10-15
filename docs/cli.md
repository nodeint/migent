# CLI commands and execution controls

Run commands from the configured project or any of its subdirectories.

## Workflow commands

```bash
# Create a session and run until it stops.
migent start <workflow> --task "<task>"

# Resume an active session and run until it stops.
migent continue <session-id>

# Create or advance a session by exactly one eligible stage.
migent stage --workflow <workflow> --task "<task>"
migent stage <session-id>
```

`<workflow>` is the workflow id. A path to a workflow file is also accepted.
The id comes from the file's `id` field, or from the file name when `id` is omitted.

`start` and `continue` default to three failed execution attempts per stage and
20 stage dispatches per command. Configure those guards with:

```bash
migent continue <session-id> --attempts 5
migent continue <session-id> --max-dispatches 50
migent continue <session-id> --unlimited-dispatches
```

`--attempts N` is the total failed-execution allowance for one stage, not an
additional retry count. `stage` dispatches only once and has no dispatch
ceiling. Revision limits are defined by `max_revisions` in the workflow.
Each `continue` resets the session's revision counts before dispatching. The
existing session history and artifacts remain available to later stages.

Workflow commands write progress to stderr and one JSON result to stdout. Run
`migent <command> --help` for its fields, stop reasons, and exit codes.

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
provider, model, and prompted options are chosen from lists, and `plan` can
assign the reviewer a second model. In a terminal, init also asks whether to
install the Migent skill at `.agents/skills/migent/`. `--skill` installs that
skill without asking. Pass `--provider` and `--model` together when input is
not a terminal. Without `--skill`, a non-interactive init leaves the skill
uninstalled.

An existing valid project is left unchanged. `--skill` still installs the
skill on that project. A partial `.migent/` directory stops init and lists
the files in the way. Init writes nothing when the skill directory already
exists and installation was requested.

## Config

```bash
migent config show
migent config model
migent config model <name> --provider grok --model grok-4.7 --option reasoning-effort=medium
migent config role
migent config role reviewer --model-name plain
migent config role reviewer --provider grok --model grok-4.7 --option reasoning-effort=high
```

`config` with no command prints help. `config show` prints
`.migent/config.yaml` as stored.

## Migrate

```bash
migent migrate
migent migrate --yes
```

`doctor`, `config model`, `config role`, `agent`, `start`, `continue`, and
`stage` stop when `schema_version` is older than this Migent and print
`Schema is outdated. Run migent migrate.` A missing `schema_version` is
version 0.

`migrate` prints the pending changes and asks before it writes. `--yes` writes
without asking, for a caller that has no terminal. Declining leaves the files
unchanged. The upgrade still runs one version at a time. Each adapter defines
its own function for a model, a role, and a stage at that version.

In a terminal, `config model` or `config role` with no arguments opens a list.
The last choice adds a model or a role. Choosing a model edits that entry.
Choosing a role points that role at a model, or adds a model for it.

Pass the flags to write without prompts. `--model` is the provider model id.
`--model-name` is the name under `models:` in `.migent/config.yaml`.
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
process only if it does not. It exits 0 when the service is already absent or
was stopped, and exits 1 when the process is still alive or its identity cannot
be verified. A service started by Migent 0.1 must be stopped with that version.
`status` prints `running` or `stopped`. A stale `service.json` is `stopped`.
The bearer token is not printed.

`workspace register` records the directory that contains
`.migent/config.yaml`. A relative `--path` is resolved from the invocation
directory, and the stored path is that absolute root. Registering the same
resolved path again keeps the same id. `list` shows `available: false` when
the config file is gone. `remove` drops one id and exits 2 when the id is
unknown. The registry listens for clients on `http://127.0.0.1:{port}`.

## Session commands

```bash
migent sessions
migent sessions --json
migent watch <session-id>
```

## Ad hoc role execution

Configured roles can also run directly without a workflow while retaining a
local session:

```bash
migent agent start --role reviewer --prompt "Review the latest changes"
migent agent continue <session-id> --role reviewer --prompt "Summarize the risks"
```

Use `--file PATH` or `--stdin` instead of `--prompt`. Pass `--json` for
machine-readable output.
