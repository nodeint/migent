# Changelog

## Unreleased

### Added

- `session prepare <some-id> --workflow <workflow>` creates a session with status `prepared` and a caller-chosen id such as `wave-3`. Write `task.md` in that session, then `migent session run --session <some-id> --workflow <workflow>`. `session show <session-id>` prints that session before the first stage.
- Stage prompts name `task.md` and the session directory. `session run --task` accepts one line and stores it in `task.md`. The first dispatch records a hash of that file. A later change stops the next dispatch. Each execution keeps a copy.

### Changed

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
