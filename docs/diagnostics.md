# Diagnosing provider failures

When Migent cannot start a provider CLI, or the provider process dies, the
error message names the cause and the execution keeps a durable trace. This
page explains what is recorded, how to read it, and how to turn on a step-by-step
trace.

## How a provider is started

Migent does not spawn a provider directly. It starts a small **process
wrapper** (`process-wrapper`) in its own process group. The wrapper owns the
provider and talks to Migent (the *owner*) over an IPC channel:

| Message | Direction | Meaning |
| --- | --- | --- |
| `ready` | wrapper → owner | The liveness endpoint is listening. |
| `start` | owner → wrapper | The owner recorded the endpoint; the wrapper may start the provider. |
| `failed` | wrapper → owner | The wrapper cannot go on. It carries a `phase` and the real error. |

The wrapper never starts the provider before `start`. If the owner disappears,
the wrapper stops the provider tree and exits.

## Reading an error message

A start failure is reported as one line that names the phase and the cause.

| Message | Meaning |
| --- | --- |
| `Provider wrapper failed to start (listen): …` | The wrapper could not open its endpoint, for example `EACCES`, `EADDRINUSE`, or a socket path that is too long. |
| `Provider wrapper failed to start (argv): …` | The wrapper received a command line it could not parse. |
| `Provider wrapper failed to start (ipc): …` | The wrapper has no IPC channel. This phase can only reach Migent through stderr. |
| `Provider wrapper exited before it was ready (code N)` or `(signal S)` | The wrapper died without reporting. A signal usually means an external `kill` or the OOM killer. |
| `Could not launch <path>: ENOENT …` | Node could not start the wrapper itself. |
| `CLI executable not found: <command>` | The provider executable is not on `PATH`. |
| `Provider CLI could not be started: <command>: <code> (<syscall>) …` | The provider exists but could not be launched, for example `EACCES` or `ENOEXEC`. |
| `Provider wrapper failed (runtime): …` | The wrapper hit an unexpected error after it started. |

A message may end with `stderr: …`, the last few lines the wrapper wrote to
stderr. Provider stderr passes through the wrapper, so it is included.

Pressing Ctrl+C, sending SIGTERM, or running `session cancel` while a provider
starts is a **cancellation**, not a startup failure. It is never reported or
recorded as one. If the wrapper dies from a signal during startup, Migent waits
a short settle window for a cancellation to arrive before it calls the exit a
failure.

## What is recorded

On a wrapper-level failure, Migent writes `diagnostics.json` in the execution
directory, next to `execution.json`:

```text
.migent/sessions/<session-id>/executions/<order>-<stage-id>--attempt-<n>/
├── execution.json
├── diagnostics.json        # only after a wrapper-level failure
└── debug.log               # only when MIGENT_DEBUG is on
```

`diagnostics.json` is separate because `execution.json` cannot change after an
execution ends. Each execution keeps the last failure; `turn` says which turn it
was.

| Field | Content |
| --- | --- |
| `schema_version` | `1`. |
| `turn` | The provider turn that failed. |
| `recorded_at` | When the failure was recorded (ISO 8601). |
| `failure.kind` | `start` (the wrapper never became ready, or reported a failure) or `provider-exit` (the provider exited non-zero and wrote to stderr). |
| `failure.phase` | `argv`, `ipc`, `listen`, `spawn`, or `runtime` when the wrapper reported one; otherwise `null`. |
| `failure.code`, `errno`, `syscall`, `path` | The underlying error, when known. |
| `failure.message` | The same text as the error message. |
| `stderr_tail` | The last 8 KB the wrapper wrote to stderr. |
| `command` | `executable` and `argument_count` only. |
| `cwd` | The working directory the provider was started in. |
| `endpoint`, `endpoint_length` | The wrapper's socket or pipe, and its length in bytes. |
| `migent_version`, `node_version`, `platform`, `arch` | The environment. |
| `timings` | `spawned_at` and `failed_at`. |

`command` never holds the other arguments. They can carry API keys, attached
option values, or prompt text, and no filter is safe for all providers. The
provider and model are already in `execution.json`. `stderr_tail` is raw output;
read it before you share the file.

## Where to look

```bash
# The error, plus a pointer to the file
migent session show <session-id>

# Recorded diagnostics, latest per stage
migent doctor --session <session-id>
migent doctor --session <session-id> --json
```

`session show` adds a `diagnostics:` line, a path relative to the session
directory, when the file exists. It is a pointer only.

`doctor --session` adds a **Provider diagnostics** check when something was
recorded. It prints the message, `kind`, `phase`, and `code`, the last five
non-empty lines of `stderr_tail`, and the file path. Recorded diagnostics are
**warnings**, not failures. They describe the past and the cause may already be
fixed, so the exit code still reflects whether the workflow is valid now.

A role session has no workflow. `doctor --session` shows the diagnostics check
for it and reports "Role session: no workflow to validate" for the workflow.

## Debug trace

Set `MIGENT_DEBUG` to `1` or `true` to trace every step of a provider start:

```bash
MIGENT_DEBUG=1 migent session run --session <session-id>
```

Each step is printed to stderr as `[migent] debug: …` and appended to
`debug.log` in the execution directory, across turns. The steps are the chosen
endpoint and its length, the wrapper pid, ready or failed, `start` sent, and the
provider exit. The wrapper adds its own steps when it inherits the variable.
With the variable unset, nothing is written.

It is an environment variable, not a flag, so it reaches background runs,
`migent service`, and role sessions the same way. `debug.log` can hold the same
sensitive values as stderr. Do not commit it.

## Common causes

| Symptom | Likely cause | What to try |
| --- | --- | --- |
| `failed to start (listen)` with `ENAMETOOLONG` | The endpoint path exceeds the socket limit. | Set `TMPDIR` to a shorter directory. |
| `failed to start (listen)` with `EACCES` | The temp directory is not writable. | Fix permissions on `TMPDIR`. |
| `exited before it was ready (signal SIGKILL)` | The OS or another process killed the wrapper. | Check memory pressure and `dmesg` or the system log. |
| `Could not launch …: ENOENT` | The Node binary or wrapper file is missing. | Reinstall Migent and check `node -v`. |
| `CLI executable not found` | The provider CLI is not on `PATH`. | Run `migent doctor` and install or fix the path. |
| No `diagnostics.json` after a failure | The run was cancelled, or the failure came from the provider's own output. | Read `response.md`, `stream.jsonl`, and the stage `failure_detail`. |

When you report a bug, attach `diagnostics.json` and `debug.log` after you check
them for secrets.
