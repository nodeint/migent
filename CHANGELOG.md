# Changelog

## Unreleased

### Changed

- Role defaults accept inline models alongside aliases. Move `roles.<role>.options` into the inline or named model.

- Contributor and release workflows use branches and pull requests. `pnpm setup:git` installs local hooks that prevent commits/direct pushes to main and mismatched branch pushes.

### Added

- `doctor` checks model `effort` against the selected client/model catalog, reports invalid values with the valid choices, and warns when the choices cannot be verified.

- Model configuration accepts `effort` as an alias for the selected CLI client's thinking-level option. OpenCode V2 renders effort as a `#variant` model suffix. Existing native options and stage overrides continue to work; conflicting model declarations and unsupported clients report configuration errors.

## 0.1.11

### Added

- A version 2 workflow stage can declare `run_when.changed_paths`, a list of Git path globs. The stage runs only when a path changed since the session baseline matches a glob; otherwise Migent records a `skipped` execution, calls no provider, and the branch ends. The baseline is the commit `HEAD` pointed at before the session's first stage. Git errors stop the command with exit 2 and are never a skip. `session show` lists `baseline` and `skipped_stages`, and metrics gain `totals.skipped` and a per-stage `skipped` count (`executions` no longer counts skips). See "Conditional stages" in `docs/workflows.md`.

- Session metrics include `totals.cost_partial`, which is true when some turns report cost and others do not. This flags a partial total instead of presenting it as complete.

### Fixed

- In version 2 workflows, a route back to a completed stage (for example `review_tests: fix_production -> implement`) now dispatches that stage and then its dependents. Before, a forward decision from a router between them blocked it, and the session ran or completed the next stage instead.

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

## Older versions

- [0.1.6](https://github.com/nodeint/migent/releases/tag/v0.1.6)
- [0.1.5](https://github.com/nodeint/migent/releases/tag/v0.1.5)
