# Changelog

## Unreleased

### Added

- `migent session cancel <session> [--wait <sec>] [--json]` asks the process running a session to stop, through a `cancel.requested` marker the lock holder polls every 500 ms. It works on Windows, where signals cannot stop a run cleanly. The run ends as if it got SIGINT (exit 130, execution `cancelled`, lock released), and `session continue` resumes it. Exit 0 when the session stopped, 1 when it still runs after `--wait` (default 15 s), 2 when the session does not exist, is not running, or runs on another machine.

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

## 0.1.5

### Added

- `session continue --reply` and `--reply-file` send a reply to a blocked stage. The new execution resumes that stage's provider agent. The prompt body is the reply. Without `--reply`, a blocked continue still includes the blocker and the previous response. When more than one stage is blocked, `--stage` selects the stage and the others stay blocked.
- `session metrics --json` prints derived per-execution and per-session usage, time, and revision counts. Provider turns record `details.usage`, `details.argv`, `details.turn`, and `details.agent_id`. `provider.stage_started` records `cli_version`, `git_head`, and `git_dirty`. Usage is normalized when the metrics are read.
- A version 2 workflow may set `concurrency` and route one decision to a list of stages. Independent branches run together up to that limit, in declaration order. A branch that blocks or exhausts verify, retries, or revisions stops; the others keep running. The session completes when nothing is running and nothing else can start. `status.json` lists `running_stages` and `blocked_by_execution_ids`. `latest_decision` is still the decision of the highest-order execution.
- A workflow session pins its workflow, role instructions, and resolved stage targets in `workflow.frozen.yaml`. Later edits warn on stderr and do not change that session. `session continue --refresh-workflow` and `session run --session --refresh-workflow` adopt the current workflow, models, and role instructions.
- New sessions write `schema_version: 2` on an identity-only `manifest.yaml`. Status lives in `status.json`. A v1 manifest still has its status line and is still updated.
- `session repair <session>` rebuilds `status.json` from the session directory. It takes the session lock. `--accept-task` is the only way past a v1 `status.json` that does not parse: it stores the hash of the current `task.md`. `session continue` repairs without that flag and refuses when the task hash or output provenance would be lost.
- Each new event line has `v` and `seq`. Lifecycle changes (`session.created`, `session.activated`, `task.frozen`, `execution.started`, `execution.<status>`, `revisions.reset`, `outputs.published`, `session.<status>`) are recorded before `status.json` is written from that log.
- `roles.<name>.instructions` is an optional list of strings. A stage prompt includes it before that stage's instructions. A role run prepends it to the prompt. `config role --json` includes the list.
- `session prepare <some-id> --workflow <workflow>` creates a session with status `prepared` and a caller-chosen id such as `wave-3`. Write `task.md` in that session, then `migent session run --session <some-id> --workflow <workflow>`. `session show <session-id>` prints that session before the first stage.
- Stage prompts name `task.md` and the session directory. `session run --task` accepts one line and stores it in `task.md`. The first dispatch records a hash of that file. A later change stops the next dispatch. Each execution keeps a copy.
- A stage may set `verify`. After the model reports `status: complete`, Migent runs those commands in the same execution, in order, and stops at the first failure. A red command sends the report back to that provider agent. The execution stays running and records no outcome until verify passes. A passing run writes `artifacts/verify.md`. After `max_verify` red runs (default 3) the execution fails with `failure_reason: verify_exhausted`. The loop stops with stop reason `verify_exhausted` and exit 6. The session stays active and `--attempts` is not consumed. `session continue` resumes that provider conversation with the last report and a fresh `max_verify` budget, and keeps the provider, model, and options of the exhausted execution.
- The `agy` adapter runs the Antigravity CLI. Headless runs use stream-json, model ids come from `agy models`, and a later turn resumes with `--conversation`.
- The installed skill lists every accepted config key in `references/schema-config.yaml` and every accepted workflow key in `references/schema-workflow.yaml`.

### Changed

- `session continue` on a blocked session dispatches that stage again. The new prompt includes the blocker and the previous response. `completed` sessions stay stopped.
- `session continue` on a cancelled session resumes that same execution. The execution id and stage attempt stay the same. A provider turn that was cut off is sent again. A verify that was cut off runs again. A role run on a cancelled session does the same and does not send the new prompt.
- A later visit that a decision routes back to a stage resumes that stage's provider agent. The prompt sends only what changed: upstream artifact paths, the route back, or a blocked attempt. It does not repeat the task path, role instructions, stage instructions, constraints, or verify commands. The reviewing stage still starts a new agent.
- `provider.item_*` and `provider.heartbeat` are appended to `executions/<id>/stream.jsonl`. Other events, including `verify.heartbeat`, stay in `events.jsonl`. Heartbeats do not rewrite `status.json`. `session follow` merges `events.jsonl` with every execution stream in timestamp order. `--cursor` remains a byte offset into `events.jsonl`. `0` replays the whole log and every stream. Any other offset replays events from that byte, and stream lines whose timestamp is at or after the first event there.
- Session files (`status.json`, `execution.json`, `manifest.yaml`, `task.md`, `prompt.md`, `response.md`) are written to a temp file, synced, and renamed, so a kill no longer leaves a truncated file. Event lines are synced when appended. A save writes its events before `status.json`.
- One process writes a session at a time. `session run --session`, `session continue` and `session run --role --session` hold `session.lock` in the session directory. A second writer exits 2 with `Session <id> is being run by pid <n> on <host>.` A lock is stale after 30 s without a heartbeat, or when its pid is gone on the same host. A holder whose lock was taken stops before its next write. `session follow` reaps a dead owner only when it can take the lock.
- Session and execution directories are created with a non-recursive `mkdir`, so two processes never share an id.
- `session list` shows a session whose `status.json` does not parse with status `corrupt` instead of dropping it. `--status corrupt` selects them. `session show`, `session follow` and `--prior` name the corrupt file and exit 2. Task freeze and prepared-session activation no longer overwrite it.
- Session commands live under `migent session`. `session run --workflow <workflow>` runs that workflow. Omit `--workflow` and pass `--role` to run one role. `session list`, `session show`, and `session follow` inspect sessions. `session continue` resumes a workflow session.
- `session list --workflow`, `--status`, and `--limit` filter the newest-first list. `--latest` prints one session, or `null` when nothing matches. JSON list rows and JSON snapshots omit the task text. The human list and snapshot still print it.
- `init --preset plan` tells the planner to edit the existing plan in place when revising, and tells the reviewer to report every gap of the same kind in one response.
- A workflow `session run` and `session continue` print a coordination result: `session_id`, `session_status`, `stop_reason`, `latest_decision`, and `outputs`. Exit 1, 3, and 6 also include `latest_execution_id` and `response_path`. `--verbose` adds `stages` with each response. Stderr prints stage boundaries and errors. `--progress` prints each tool call once, when it finishes. A role run prints a table unless `--json`. That JSON is the role result (`outcome_status`), not this object.
- `session continue SESSION` resumes until the session stops and resets revision counts. `session continue SESSION --once` and `session run --workflow W --task T --once` dispatch one stage and do not reset revision counts.
- A role run is `session run --role ROLE [--session SESSION]`. `session list` lists sessions. `session show SESSION` prints one snapshot. `session follow SESSION` follows events. `--exit-when-done` makes a follow exit when the session is completed, blocked, or cancelled.
- `config` with no subcommand prints `.migent/config.yaml` and exits 0. It used to print help and exit 2. `config show` is unchanged.
- `init` exits 0 after the project files are written. Doctor problems are an advisory on stderr. A failing doctor check no longer makes a successful init exit 1.
- `service status` exits 1 when the service is stopped. `--json` output is unchanged. `service stop` still exits 0 when the service is already absent.
- Cancelling an `init` or `config` prompt exits 130 and prints nothing. `migrate` still treats cancel as a decline and exits 0.
- The workspace register request sends this package's version.

### Removed

`start`, `prepare`, `continue`, `sessions`, `agent`, `stage`, `watch`, `agent start`, and `agent continue` are removed. Use `session run`, `session prepare`, `session continue`, `session list`, `session show`, and `session follow`.
