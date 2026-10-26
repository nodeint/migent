# Changelog

## Unreleased

## 0.1.10

### Changed

- `init` now writes shared aliases to `.migent/config.yaml` (`code_generation` for `implement`; `deep_reasoning` and `critical_review` for `plan`) as empty entries, and this machine's provider, model, and `--option` values to `.migent/config.local.yaml`. Projects created before this change keep working; `init` does not rewrite them. A lone `config.local.yaml` is treated like a partial project and stops init.
- `init` prints the chosen provider and model and a `migent session run --workflow <preset> --task "<what you want done>"` command. A missing `--provider` or `--model` error includes a full example. `init` still never starts a model.
- `doctor` reports every model alias that has no provider and model in one message with the YAML to add to `.migent/config.local.yaml`, instead of one `provider is required` problem per role and stage.
- `migent config` is read-only. `--json` prints `{config, local}`, and the stderr note lists the models `config.local.yaml` sets.
- `skill install` picks the project's clients from the merged config.

- Documentation, the `plan` workflow written by `init`, and this repository's workflows use `snake_case` ids (`review_plan`, `review_work`). Hyphenated ids still work; existing projects and sessions are unchanged. The docs now state the naming rule.

### Removed

- `config show`, `config model`, and `config role`. They exit 2 and print the replacement: edit `.migent/config.yaml` or `.migent/config.local.yaml`, then run `migent doctor`. Scripts that used `config model --json` or `config role --json` should read `migent config --json` and edit the YAML.

## 0.1.9

### Added

- `migent skill path` prints the directory of the skill bundled with the CLI. `migent skill install` and `update` take `--project`/`--global`, `--client <ids>` and `-y`, and cover claude-code, codex, opencode, agy and grok. `migent doctor` has a `skill` check that warns, without failing, when the skill is missing or an installed copy differs from the bundled one.
- `migent session cancel <session> [--wait <sec>] [--json]` asks the process running a session to stop, through a `cancel.requested` marker the lock holder polls every 500 ms. It works on Windows, where signals cannot stop a run cleanly. The run ends as if it got SIGINT (exit 130, execution `cancelled`, lock released), and `session continue` resumes it. Exit 0 when the session stopped, 1 when it still runs after `--wait` (default 15 s), 2 when the session does not exist, is not running, or runs on another machine.

### Changed

- `migent skill install` and `update` run `npx skills add` (Node 22.20 or newer) instead of writing `.agents/skills/migent` themselves. `update` reinstalls every copy that differs from the bundled skill, after asking. `init --skill` installs into the directory of the chosen client.

- `migent skill install` and `update` work on Windows when the path of the bundled skill holds a space.

### Removed

- The `.migent-template.json` state file and `skill update --force`.

## 0.1.8

### Added

- `.migent/config.local.yaml` is an optional per-machine override of `.migent/config.yaml`. Mappings (`models`, `roles`, `options`) merge key by key; scalars and lists replace the base value; its `schema_version` is ignored. Runs, session freezes, `agent`, `doctor`, and `config show` read the merged result. `config model` and `config role` still edit `config.yaml` only.
- `init` ignores `config.local.yaml` in `.migent/.gitignore`. `doctor` warns, without failing, when git tracks it, and `doctor --json` carries `warnings` on each check.
- `config show` prints the merged config as YAML when `config.local.yaml` exists, and notes the merge on stderr. Without that file it prints `config.yaml` as stored.

### Changed

- `doctor` no longer reports "has no default CLI client" for a role or stage whose model sets `client`.

## 0.1.7

### Added

- `migent provider list [--json]` lists every registered provider adapter, whether its CLI is on PATH, the model ids that CLI reports, and the provider options the adapter exposes. It works without `.migent/config.yaml`. Exit 0 when at least one provider returned models, exit 1 when none did. Missing CLIs and listing failures are reported as per-provider problems, not errors.
- An OpenCode provider runs models through the `opencode` CLI. A provider quota error from OpenCode is classified as a quota, so the stage waits or exits 8 like any other provider.
- `models.<name>.client` is optional and picks the CLI client that runs a model. `doctor` rejects an unknown client id.
- A BytePlus ModelArk provider has no default CLI client. Set `client` on each BytePlus model, for example `opencode`. `doctor` reports a BytePlus model with no `client` and checks the executable and options of the client it names. `provider list` and `init` skip a provider that still needs a client.

### Changed

- A new session id is a UUID. `manifest.yaml` records `title`. A workflow or role session uses its one-line task as the title. `session prepare <title>` stores that text as the title and prints the UUID. The title is a display label, so spaces and capitals are kept. `session list` prints the title before the id, and its JSON includes `title`. A session with no title is shown by its id. `continue`, `--prior`, and `metrics` still take the id.
- Claude models are listed from the CLI initialize response instead of a hardcoded catalog.

## 0.1.6

### Added

- A version 2 stage may omit `role` when it sets `verify`. Migent runs that list and does not start an agent. `description` is an optional one-line label on any stage. It is printed on the stage start line and is not part of the provider prompt. All exits 0 complete the stage and publish `artifacts/verify.md`. The first non-zero exit, a timeout, or a failure to start the shell fails the stage with `failure_reason: verify_failed`. Dependents do not start. The session stays active and the command exits 7. `session continue` runs the list again in a new execution and does not open a provider. A cancelled stage with no role reruns its verify list in place. `max_verify`, `instructions`, `model`, `options`, `session`, `produces`, `decision`, and `max_revisions` are rejected on a stage with no role.
- The installed skill ships `references/sessions.md`, `references/inspect.md`, and `references/config.md` next to the schema files.

### Changed

- A workflow run prints plain stage lines and leaves stdout empty. A stage line names the attempt. The start line also names the clock time. The finish line names how long that attempt took. A completed session prints `completed · <duration>` and, when it published files, one `artifact: <absolute-path>` line per file. The path starts at the filesystem root. A published file keeps the artifact name, including its suffix. The stage report is not printed. Exit 1, 3, 6, and 8 print `response: executions/<id>/response.md`. Exit 7 prints `verify: executions/<id>/turns/01/verify.md`.
- A workflow run that stops before the session is completed prints the resume command on stderr: `migent session continue <session-id>`. That includes blocked, cancelled, a failed or exhausted stage, and `--once` while later stages remain. A completed session does not print it.
- `session continue <session-id>` also resumes a role session. A cancelled role execution resumes in place. A blocked role session runs again. An active role session sends its last prompt again. `--reply` is the next user turn. A completed role session stays stopped unless `--reply` is set. A stopped role run prints the same command.
- A failed provider stage stops the branch. `session continue` runs that stage again. Exit 3 is `stage_failed`. `--once` and `--stage` that hit a provider quota exit 8 and do not wait. A quota with a reset time waits in the owning process, then dispatches that stage. Cancelling during the wait is exit 130 and does not sleep until the old `retry_at` on the next continue. `--attempts` and `retry_exhausted` are gone. A single role result uses exits 0, 1, and 130. Exit 6 stays the path that reopened more than one role execution.
- A completed workflow session writes `metrics.json`. `session metrics --json` prints that file and lists only sessions that have it. A session without the file exits 2. Later adapter changes do not change that file. An agent session has no metrics file.
- Verify runs each command with `/bin/sh` when that file is executable. On Windows it uses `sh` from `PATH`. Publishing a file syncs it through a writable handle, so the publish does not stop with `EPERM`.

## Older versions

- [0.1.5](https://github.com/nodeint/migent/releases/tag/v0.1.5)
