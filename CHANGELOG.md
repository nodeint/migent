# Changelog

## Unreleased

### Added

- `session repair <session>` rebuilds `status.json` from the session directory. It takes the session lock. `--accept-task` is the only way past a v1 `status.json` that does not parse: it stores the hash of the current `task.md`. `session continue` repairs without that flag and refuses when the task hash or output provenance would be lost.
- Each new event line has `v` and `seq`. Lifecycle changes (`session.created`, `session.activated`, `task.frozen`, `execution.started`, `execution.<status>`, `revisions.reset`, `outputs.published`, `session.<status>`) are recorded before `status.json` is written from that log.
- `roles.<name>.instructions` is an optional list of strings. A stage prompt includes it before that stage's instructions. A role run prepends it to the prompt. `config role --json` includes the list.
- `session prepare <some-id> --workflow <workflow>` creates a session with status `prepared` and a caller-chosen id such as `wave-3`. Write `task.md` in that session, then `migent session run --session <some-id> --workflow <workflow>`. `session show <session-id>` prints that session before the first stage.
- Stage prompts name `task.md` and the session directory. `session run --task` accepts one line and stores it in `task.md`. The first dispatch records a hash of that file. A later change stops the next dispatch. Each execution keeps a copy.

### Changed

- `session continue` on a blocked session dispatches that stage again. The new prompt includes the blocker and the previous response. `completed` and `cancelled` sessions stay stopped.
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
