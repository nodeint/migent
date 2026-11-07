# Diagnosing client failures

When Migent cannot start a client CLI, the client process exits non-zero,
or the client reports an error, the error message names the cause and the
execution keeps a durable trace. This
page explains what is recorded, how to read it, and how to turn on a step-by-step
trace.

## How a client is started

Migent does not spawn a client directly. It starts a small **process
wrapper** (`process-wrapper`) in its own process group. The wrapper owns the
client and talks to Migent (the *owner*) over an IPC channel:

| Message | Direction | Meaning |
| --- | --- | --- |
| `ready` | wrapper → owner | The liveness endpoint is listening. |
| `start` | owner → wrapper | The owner recorded the endpoint; the wrapper may start the client. |
| `failed` | wrapper → owner | The wrapper cannot go on. It carries a `phase` and the real error. |

The wrapper never starts the client before `start`. If the owner disappears,
the wrapper stops the client tree and exits.

## Reading an error message

A start failure is reported as one line that names the phase and the cause.

| Message | Meaning |
| --- | --- |
| `Provider wrapper failed to start (listen): …` | The wrapper could not open its endpoint, for example `EACCES`, `EADDRINUSE`, or a socket path that is too long. |
| `Provider wrapper failed to start (argv): …` | The wrapper received a command line it could not parse. |
| `Provider wrapper failed to start (ipc): …` | The wrapper has no IPC channel. This phase can only reach Migent through stderr. |
| `Provider wrapper exited before it was ready (code N)` or `(signal S)` | The wrapper died without reporting. A signal usually means an external `kill` or the OOM killer. |
| `Could not launch <path>: ENOENT …` | Node could not start the wrapper itself. |
| `CLI executable not found: <command>` | The client executable is not on `PATH`. |
| `Provider CLI could not be started: <command>: <code> (<syscall>) …` | The client exists but could not be launched, for example `EACCES` or `ENOEXEC`. |
| `Provider wrapper failed (runtime): …` | The wrapper hit an unexpected error after it started. |

A message may end with `stderr: …`, the last few lines the wrapper wrote to
stderr. Client stderr passes through the wrapper, so it is included.

Pressing Ctrl+C, sending SIGTERM, or running `session cancel` while a client
starts is a **cancellation**, not a startup failure. It is never reported or
recorded as one. If the wrapper dies from a signal during startup, Migent waits
a short settle window for a cancellation to arrive before it calls the exit a
failure.

## What is recorded

Migent writes `diagnostics.json` in the execution directory, next to
`execution.json`, for every **abnormal client turn**:

- a start failure (the wrapper never became ready, or reported a failure);
- a non-zero exit or signal death, **whether or not stderr had output**;
- a client-reported error at exit 0 (an error event, `is_error`, a failed result);
- a non-zero exit that Migent accepted because the model's reply passed every check
  an exit-0 reply must pass (`provider.exit_anomaly`, `accepted: true`).

A clean exit-0 turn writes nothing. Cancellation and timeouts are not client
failures and write nothing either.

```text
.migent/sessions/<session-id>/executions/<order>-<stage-id>--attempt-<n>/
├── execution.json
├── failure.md              # readable failure report for a failed execution
├── response.md             # model output only, when the model produced one
├── diagnostics.json        # the latest abnormal client turn
└── debug.log               # only when MIGENT_DEBUG is on
```

### Client turn versus execution

`diagnostics.json` describes **one client turn**, the one named by `turn`. It
never says the execution failed because of that turn. Two verdicts exist:

| Verdict | Meaning | Recorded in |
| --- | --- | --- |
| Client-turn verdict | Did this turn pass the client-level decision and the reply checks (outcome, artifact, completion outputs). It is fixed when those checks finish and later verify, question-correction or repair turns never change it. | `diagnostics.json` → `result_state.turn_verdict` (`accepted` or `failed`) |
| Execution verdict | Did the execution as a whole succeed, and if not, at which check on which turn. | `execution.json` → `status`, `error`, `failure_reason`, `final_turn` |

The file holds the **latest** abnormal turn. A later clean turn leaves it alone;
a later abnormal turn replaces it. Earlier abnormal turns stay traceable through
their `provider.exit_anomaly` and `provider.turn_failed` events in `events.jsonl`.

`execution.json` records `final_turn` for every client execution: the last
client turn it ran. `failure.md` uses it to place the diagnostics:

| Relation | What `failure.md` shows |
| --- | --- |
| Diagnostics are for the final turn and `failed` | **Client failure**: exit code, signal, origin, stderr size and drain, reply and artifact state, client session id, and a one-line reading of the evidence. |
| For the final turn but `accepted` (a later verify or question-file failure ended the execution) | **Earlier in this turn**: the client exited non-zero, the reply was accepted, the cause is the error above. |
| For an earlier turn | **Earlier client anomaly**, stated as not the cause. |
| `final_turn` is absent (an execution written by an older version) | **Client diagnostics** pointer; the relation to the failure is stated as unknown. |

`failure.md` is the human-readable companion written for every failed
execution. Read it before the JSON files; `execution.json` and
`diagnostics.json` stay the machine-readable sources.

`diagnostics.json` is separate because `execution.json` cannot change after an
execution ends.

| Field | Content |
| --- | --- |
| `schema_version` | `2`. Version 1 files (wrapper failures only) are still read. |
| `turn` | The client turn this record describes. |
| `recorded_at` | When the turn ended (ISO 8601). |
| `agent_id` | The client session id known for the turn, or `null`. |
| `failure.kind` | `start` (the wrapper never became ready, or reported a failure), `provider-exit` (the client exited non-zero or by signal; stderr may be empty), or `provider-error` (the client reported an error at exit 0). |
| `failure.origin` | `start`, `provider-error` or `exit-only`, as classified for the turn. |
| `failure.exit_code`, `failure.signal` | The process exit code and terminating signal, when there were any. The wrapper reports a client killed by a signal to Migent separately from the shell-style `128 + signal` exit code, so `signal` is set only when a signal was observed: a plain `exit 137` records `signal: null`. It is `null` on Windows. |
| `failure.phase` | `argv`, `ipc`, `listen`, `spawn`, or `runtime` when the wrapper reported one; otherwise `null`. |
| `failure.code`, `errno`, `syscall`, `path` | The underlying error, when known. |
| `failure.message` | The same text as the error message. |
| `stderr_tail` | The last 8 KB of stderr, read after every pipe closed. May be empty. |
| `stderr` | `tail_bytes` (size of the retained tail), `total_bytes` (all stderr observed) and `drain`: `closed`, or `grace-expired` when a process still held a pipe open after the short wait, in which case an empty or short tail is not authoritative. |
| `stream_summary` | The shape of stdout, never its content: `stdout_bytes` and `lines` as received, `non_json_lines`, `events` (label → count), `last_events` (last 10 labels), `labelled` (whether the client names its events), `error_messages` (the classified client error, truncated to 300 characters). |
| `result_state` | What this turn left behind; see below. |
| `command` | `executable` and `argument_count` only. |
| `cwd` | The working directory the client was started in. |
| `endpoint`, `endpoint_length` | The wrapper's socket or pipe, and its length in bytes. |
| `migent_version`, `node_version`, `platform`, `arch` | The environment. |
| `timings` | `spawned_at` and `failed_at`. |

`result_state` is scoped to the turn named by `turn`:

| Field | Content |
| --- | --- |
| `observed.reply` | `source` (`model`, `error`, `none`, `unknown`), `bytes`, and `status_header`: `present` with the status (`complete`, `question`, `blocked`), `invalid`, `absent`, or `not-applicable` (the text was not model output). An unrecognised status value is never copied. |
| `observed.artifact` | `present` (with `bytes`), `empty`, `absent`, or `not-applicable` (the stage declares no artifact). Read directly from the declared path. |
| `observed.response_written` | Whether Migent persisted `response.md` for this turn. Only model-attested replies are. |
| `observed.conversation_turns` | Assistant messages in the conversation after the turn. |
| `gates.outcome`, `gates.artifact`, `gates.completion_outputs` | The result of Migent's own checks: `passed`, `failed` (with `reason`), `not-evaluated` (skipped because the client verdict had already failed) or `not-applicable`. |
| `turn_verdict` | `accepted` or `failed`. |
| `reason` | The rejecting reason, the same text as `provider.exit_anomaly.reason` where that event exists. |

`observed` is read without running the checks, so a client-error turn that left
a complete reply and an artifact shows `status_header: present`, `artifact:
present`, `gates.outcome: not-evaluated` and `turn_verdict: failed`. The work may
be done even though the turn failed; Migent does not accept it.

### What never goes in the file

`stream_summary` holds counts and labels from the CLI client's own vocabulary
(`text`, `tool_use:completed`, `result:error`). Each client lists its
labels in a closed vocabulary and any other value counts as `other`; labels are
also limited to short identifier characters and at most 32 distinct ones per turn. No reply text, tool arguments or prompt text is stored. The
`command` field keeps only the executable and argument count, because other
arguments can carry API keys or prompt text. `stderr_tail` is raw output; read it
before you share the file. A raw stdout tap is not provided.

## Where to look

```bash
# The readable report for a failed execution
cat .migent/sessions/<session-id>/executions/<execution-id>/failure.md

# The error, plus a pointer to the file
migent session show <session-id>

# Recorded diagnostics, latest per stage
migent doctor --session <session-id>
migent doctor --session <session-id> --json
```

`session show` adds a `diagnostics:` line, a path relative to the session
directory, when the file exists. It is a pointer only. The file also exists after
an **accepted** exit-only turn, so a `completed` execution can have one.
An exit-only turn also adds an `exit_anomaly` line (`exit_anomalies` in JSON), and
`metrics.json` counts it under `provider_exit_anomalies`; see
[CLI](cli.md#session-commands) and [Session metrics](session-metrics.md#provider-exit-anomalies).

`doctor --session` adds a **Recorded diagnostics** check when something was
recorded. It prints the message, `kind`, `origin`, `phase`, `code`, the `turn`, the
client-turn `verdict` (so an accepted anomaly reads as accepted), the last five
non-empty lines of `stderr_tail`, and the file path. Recorded diagnostics are
**warnings**, not failures. They describe the past and the cause may already be
fixed, so the exit code still reflects whether the workflow is valid now.

A role session has no workflow. `doctor --session` shows the diagnostics check
for it and reports "Role session: no workflow to validate" for the workflow.

## Debug trace

Set `MIGENT_DEBUG` to `1` or `true` to trace every step of a client start:

```bash
MIGENT_DEBUG=1 migent session run --session <session-id>
```

Each step is printed to stderr as `[migent] debug: …` and appended to
`debug.log` in the execution directory, across turns. The steps are the chosen
endpoint and its length, the wrapper pid, ready or failed, `start` sent, and the
client exit. The wrapper adds its own steps when it inherits the variable.
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
| `CLI executable not found` | The client CLI is not on `PATH`. | Run `migent doctor` and install or fix the path. |
| Execution `completed` although the client exited non-zero | The client reported no error and its reply passed every check an exit-0 reply must pass. No `failure.md` is written, but `diagnostics.json` records the turn with `turn_verdict: accepted`. | Read `diagnostics.json`, and `provider.exit_anomaly` (`exit_code`, `accepted`) in `events.jsonl`. |
| Execution `completed` although the client was killed on Windows | Windows reports no signal identity: a killed client looks like exit code 1, so a valid reply can be accepted as an `exit-only` turn. POSIX signal deaths exit as 128 plus the signal and are never accepted. | Check `provider.exit_anomaly` in `events.jsonl`; this is a known limitation. |
| No `diagnostics.json` after a failure | The run was cancelled or timed out, or the failure came from a clean client turn (for example a missing artifact or a failed verify). | Read `failure.md` and `execution.json`; read `response.md` only when the model produced one. |
| `diagnostics.json` exists but its `turn` is lower than `final_turn` | An earlier client turn was abnormal; a later turn ended the execution. | `failure.md` marks it as an earlier anomaly, not the cause. |

When you report a bug, attach `diagnostics.json` and `debug.log` after you check
them for secrets.
