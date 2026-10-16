# Changelog

## Unreleased

### Changed

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
