# Changelog

## Unreleased

### Added

- `@nodeint/migent-contracts` publishes a JSON Schema file for every contract under `schemas/` (importable as `@nodeint/migent-contracts/schemas/…`), and exports `EXIT_CATALOG`, which describes every exit code per command family. Generated field tables for CLI output, config, workflow files, exit codes, and environment variables are in `docs/reference/`. Run `pnpm generate` after changing a contract.

### Changed

- **Breaking for `@nodeint/migent-kernel` consumers:** workflow definition code moved to the new `@nodeint/migent-workflow` package (model, strict parser, draft collector, catalog, file loading, `SCHEMA_VERSION`, `unknownWorkflowKeyEntries`, `parseYamlDocument`). The kernel no longer re-exports these symbols; import them from `@nodeint/migent-workflow`. `ConfigurationError` and `AskTarget` are still exported by the kernel, and `ConfigurationError` is the same class. Behavior, messages, and codes are unchanged.
- `@nodeint/migent-workflow` is a new package released with the others.

- Schema `$id`s now use the raw GitHub URL of the schema file on `main` instead of `https://migent.dev/schemas`. A schema added on `next` is served at its URL only after a release. `StageView` is now exported. CLI `--help` exit text now comes from `EXIT_CATALOG` and is unchanged.

## 0.5.3

### Added

- `client.type` is optional on an agent. When omitted, Migent runs each installed client's model-list command and uses the one client that lists the agent's `model` (OpenCode's `#variant` suffix is ignored), on every resolution and with no cache on disk. `effort` maps to the inferred client. No client listing the model is a `client-not-found` error, and several clients listing it is a `client-ambiguous` error; doctor reports both and a run refuses to start. `client.type` stays required when `client.options` is set (even an empty mapping). Inference is slower and depends on the machine's installed CLIs; set `client.type` to avoid both. Started sessions keep their frozen client.

## 0.5.2

### Added

- `migent session complete <session-id>` marks a stopped workflow session completed without dispatching another stage. Takes the session lock and applies to `active`, `blocked`, `question`, or `cancelled` sessions. Rejects `prepared` and role sessions, and any session a live process is running. Completes manually by appending `session.completed` (with `data.manual: true`) to the event log; the fold derives this and survives `session repair`. Publishes outputs by normal rules (schema 7: artifact registry, schema 2–6: top-level outputs, v1: completion.outputs), records `published_by_execution_id: "manual"`, seals metrics.json, and writes next.json. Warns on stderr about each missing required artifact but completes anyway. Idempotent on already-completed sessions. Exit 0 on success or already-completed; exit 2 when the session is missing, prepared, a role, running (with live lock), or unreadable. A completed session's `status.json` records `completion_method`: `"manual"` for this command (with `manual_completion` holding the timestamp and previous status), and `"agent"` when stage executions completed it; sessions completed earlier gain `"agent"` the next time their status is folded, for example by `migent session repair`.

## 0.5.1

### Changed

- **Breaking:** A client quota failure is no longer handled automatically. Migent still detects it and records `failure_reason: quota`, the reset time (`retry_at`), the window (`quota_window`), and the `provider.quota` event (also shown in `failure.md`, and in `session watch`/`session show` for each stage whose latest execution failed on quota), but the stage now fails like any other: no client parking, shared waits, sleeping, or automatic retry after reset, and role sessions no longer wait and rerun. Full runs report it as `stage_failed` (exit 3); `--once` and `--stage` still exit 8. `session continue` reruns the stage.

- **Breaking:** Workflows use schema version 7. A top-level `artifacts` registry (`file`, `description`, `required`) replaces `stages[].produces` and top-level `outputs`; stages list artifact ids, and a decision may reference registry ids or define decision-local artifacts. Run `migent migrate`; it refuses without writing when two stages would publish the same file name or an id cannot be derived, and reports artifacts that are now published, `run_when` artifacts that become `required: false`, and merged output aliases.
- Every registry artifact is published when the session completes. Required artifacts are guaranteed and hold completion until they exist; optional ones are copied only when present. Sources are the producer's current eligible completion, so a skipped stage or an unselected decision never supplies a stale file.
- Prompts list every file a stage writes, with descriptions, and give dependents and routed stages the artifacts of the decision that was chosen. `downstream[].artifacts` is optional and, when omitted, passes every published artifact under its id. A mapping to an optional artifact is best-effort; doctor notes it, and `session show` lists absent optional artifacts as not produced.
- `migent migrate` also upgrades each session's `workflow.yaml` draft and `workflow.frozen.yaml` pin, under the session lock. It skips symlinked session directories and files, and refuses to write if a session is running or a file changed since planning.
- The bundled `plan` workflow records non-blocking review comments as `plan-comments.md`.

## 0.5.0

### Changed

- The README lists supported CLIs with links to their project pages.
- **Breaking:** Agents select a CLI through `client.type`; the provider abstraction is removed and configuration/workflows use schema version 6. Run `migent migrate` to preserve existing client selections and options. Replace provider selection flags with `--client` and use `migent get clients` instead of `get providers`.
- Role sessions honor the configured client. Claude Code's session identity and default `permission_mode=bypassPermissions` follow `claude-code`; quota waits are grouped by client.

### Fixed

- Migration preserves layered client selections from v4/v5, writes inline workflow agents, keeps comments on retained role/stage fields, and verifies the resulting YAML before writing.
- Legacy resume checks every turn's client evidence before creating or reopening executions, refusing missing or conflicting evidence without sending native IDs to another CLI. Metrics parse each turn with its launched client and count captures with no identifiable client as uncaptured.
- Shared quota waits retry all affected stages after reset within the concurrency limit, stop repeated quota failures for the same window, and resolve legacy wait keys from execution evidence.

## 0.4.1

### Added

- `migent workflow validate|render|save --session <id>` validates, renders, and saves the editable `workflow.yaml` of an existing prepared or stopped session. The draft may share its id with its project template, must keep the session's recorded id, and is checked against live config bindings and downstream references. `save` takes the session lock, needs the draft's `--base-hash`, and writes only the draft: a prepared session adopts it at start, a started session after `--refresh-workflow`.
- Exit-only provider anomalies (non-zero exit, no provider error) are now visible without opening executions: `metrics.json` counts `provider_exit_anomalies` and `provider_exit_anomalies_accepted` in `totals` and per execution, and `session show` / `session follow` print an `exit_anomaly` line per affected stage (`exit_anomalies` in JSON) that points to `diagnostics.json` (#73).
- Every abnormal provider turn now leaves `diagnostics.json` (schema version 2): a non-zero exit even when stderr was empty, a provider-reported error at exit 0, and a non-zero exit accepted as a completed turn. It adds `agent_id`, `failure.origin`, `failure.exit_code`, `failure.signal`, `stderr` sizes with a `drain` state, a content-free `stream_summary` (event labels and counts; CLI clients gain an optional `eventLabel()`), and a `result_state` of what the turn left (reply, artifact, `response.md`) next to Migent's own check results and the provider-turn verdict. `execution.json` records `final_turn` for provider executions, and `failure.md` uses it to name the provider failure as the cause only when the diagnostics belong to the turn that ended the execution. `migent doctor --session` also shows origin, turn and verdict (#72).
- `migent get providers`, `get clients`, `get models [--client <id>]`, `get options [--client <id>] [--native]`, and `get efforts [--client <id>]` expose machine-level discovery as separate resource types, each with a singular lookup, `-o json|yaml|name`, and `--json`. The machine types work outside a project. `get providers` and `get clients` run no subprocess; `get clients` reports PATH findings only. `get models`, `get efforts`, and `get options --native` ask each selected client's own CLI, warn on stderr for a client that is skipped or fails, and still print the other clients' rows and exit 0. A singular model, option, or effort is keyed by (client, name) and asks for `--client` when more than one client matches.
- The doctor package accepts a client-keyed catalog source in `loadCatalog` and `loadOptionValues`, so catalog discovery uses a client's own command, parser, and stdin instead of a provider with the same name. Existing provider callers are unchanged.

### Changed

- **Breaking:** `migent provider list` is removed, including `--json`. It exits 2 and names `migent get providers`, `migent get clients`, `migent get models`, `migent get options`, and `migent get efforts`, and `provider` no longer appears in help. The `{ok, providers}` envelope, `headless_options`, and the exit-1-when-no-models rule are gone; the new lists print a plain array and exit 0, including when every client is skipped or fails.

### Fixed

- Stderr is read after the provider's pipes close, so lines written just before a non-zero exit are no longer lost (#72).

- A provider process that exits non-zero without reporting an error no longer fails a stage whose reply passes the checks an exit-0 reply must pass. The turn is recorded `completed`, keeps `response.md`, and logs a `provider.exit_anomaly` event. Provider-reported errors, start failures and signal exits still fail, and a rejected turn's error is now the model's own text. A `continue` prompt after such a failed attempt references its reply (#71).

## Older versions

- [0.4.0](https://github.com/nodeint/migent/releases/tag/v0.4.0)
- [0.3.6](https://github.com/nodeint/migent/releases/tag/v0.3.6)
- [0.3.5](https://github.com/nodeint/migent/releases/tag/v0.3.5)
- [0.3.4](https://github.com/nodeint/migent/releases/tag/v0.3.4)
- [0.3.3](https://github.com/nodeint/migent/releases/tag/v0.3.3)
- [0.3.1](https://github.com/nodeint/migent/releases/tag/v0.3.1)
- [0.3.0](https://github.com/nodeint/migent/releases/tag/v0.3.0)
- [0.2.1](https://github.com/nodeint/migent/releases/tag/v0.2.1)
- [0.2.0](https://github.com/nodeint/migent/releases/tag/v0.2.0)
- [0.1.11](https://github.com/nodeint/migent/releases/tag/v0.1.11)
- [0.1.10](https://github.com/nodeint/migent/releases/tag/v0.1.10)
- [0.1.9](https://github.com/nodeint/migent/releases/tag/v0.1.9)
- [0.1.8](https://github.com/nodeint/migent/releases/tag/v0.1.8)
- [0.1.7](https://github.com/nodeint/migent/releases/tag/v0.1.7)
- [0.1.6](https://github.com/nodeint/migent/releases/tag/v0.1.6)
- [0.1.5](https://github.com/nodeint/migent/releases/tag/v0.1.5)
