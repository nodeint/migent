# Changelog

## Unreleased

### Added

- `prepare <some-id> --workflow <workflow>` creates a session with status `prepared` and a caller-chosen id such as `wave-3`. Write `task.md` in that session, then `migent start --session <some-id>`. `sessions <session-id>` prints that session before the first stage.
- Stage prompts name `task.md` and the session directory. `start --task` accepts one line and stores it in `task.md`. The first dispatch records a hash of that file. A later change stops the next dispatch. Each execution keeps a copy.

### Changed

- `sessions --workflow`, `--status`, and `--limit` filter the newest-first list. `--latest` prints one session, or `null` when nothing matches. JSON list rows and JSON snapshots omit the task text. The human list and snapshot still print it.
- `init --preset plan` tells the planner to edit the existing plan in place when revising, and tells the reviewer to report every gap of the same kind in one response.
- `start` and `continue` print a coordination result: `session_id`, `session_status`, `stop_reason`, `latest_decision`, and `outputs`. Exit 1, 3, and 6 also include `latest_execution_id` and `response_path`. `--verbose` adds `stages` with each response. Stderr prints stage boundaries and errors. `--progress` prints each tool call once, when it finishes. `stage` uses the same result.
- `continue SESSION` still resumes until the session stops and resets revision counts. `continue SESSION --once` and `start WORKFLOW --task TASK --once` dispatch one stage and do not reset revision counts.
- `agent --role ROLE [--session SESSION]` replaces `agent start` and `agent continue SESSION`.
- `sessions` lists sessions. `sessions SESSION` prints one snapshot. `sessions SESSION --follow` follows events. `--exit-when-done` makes a follow exit when the session is completed, blocked, or cancelled.
- `config` with no subcommand prints `.migent/config.yaml` and exits 0. It used to print help and exit 2. `config show` is unchanged.
- `init` exits 0 after the project files are written. Doctor problems are an advisory on stderr. A failing doctor check no longer makes a successful init exit 1.
- `service status` exits 1 when the service is stopped. `--json` output is unchanged. `service stop` still exits 0 when the service is already absent.
- Cancelling an `init` or `config` prompt exits 130 and prints nothing. `migrate` still treats cancel as a decline and exits 0.
- The workspace register request sends this package's version.

### Deprecated

`stage`, `watch`, `agent start`, and `agent continue` still run, print a deprecation notice on stderr, and keep their previous exit codes and stdout. They will be removed in 0.3.0, the minor release after the one that introduces these aliases.
