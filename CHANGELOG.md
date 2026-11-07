# Changelog

## Unreleased

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

## 0.4.0

### Added

- `migent config render|save` and `migent workflow render|save` accept `--preserve-comments`, keeping the target's comments, key order, and line endings. Unchanged data writes the base bytes verbatim; when preservation is impossible the file falls back to canonical YAML with a `comments-not-preserved` warning. `render --preserve-comments` prints exactly the bytes `save --preserve-comments` would write.

### Changed

- `migent config validate|render|save` and `migent workflow validate|render|save` report every independent draft diagnostic in one run instead of stopping at the first, including multiple entries in one stage. Each diagnostic keeps its own `path`, and a draft diagnostic whose path resolves in the draft text now carries one-based, exclusive `end_line`/`end_column`. An unreadable companion config layer or an unrelated broken workflow field no longer hides other findings, because each graph rule gates only on the fields and dependency chain its finding needs. Without `--preserve-comments`, saved bytes and `comments-dropped` warnings are unchanged.
- **Schema version 5: "agents".** An agent is a provider, a model, an effort, and a CLI client with its options, and it is called an agent everywhere. Run `migent migrate` to upgrade config and workflow files; comments and layout are kept, and sessions that already started keep running from their frozen copy. The migration makes these changes:
  - `models` becomes `agents`, and `roles.<role>.default_model` becomes `roles.<role>.agent` (a name in `agents` or a complete inline agent).
  - `roles.<role>.instructions` becomes `roles.<role>.responsibilities`. A role also accepts an optional one-line `description`, shown by `migent get roles` and not added to prompts.
  - An agent's `client: <id>` becomes `client.type`, and its `options` become `client.options`. `client` is now always a mapping. `model` stays required on every agent.
  - A stage's `model` becomes `agent`. It takes a name from `agents` or a complete inline agent, which replaces the role's agent entirely.
  - **Stage `options` are removed.** The migration deletes them and lists every deleted option in its notes; recreate any you still need as an inline `stages.<id>.agent` with `client.options`.
  - Unknown workflow keys are errors in schema version 5 (they were warnings). A v4 key in a v5 file is rejected with the key that replaces it.
- `migent get agents` and `migent get agent <name>` replace `get models` and `get model <alias>`; role views show `agent`, `description`, and `responsibilities`, and the workflow view reports `role_responsibilities`. `migent config --json` reports the local file's `agents`.
- Kernel and doctor exports follow the new names: `loadAgentTarget`, `loadAgentDefinition`, `listAgentDefinitions`, `loadRoleResponsibilities`, `loadRoleDescription`, `validateRoleKeys`, `upsertAgent`, `placeRoleAgent`, `matchingAgentName`, `getAgentView`, and `listAgentViews`. A parsed role stage carries `agent` (`{ kind: "named" | "inline" }`) instead of `modelName`. Doctor findings use the new paths, for example `agents.<name>.client.options`.
- Deferred: named and multiple artifacts per stage and the changed `outputs` shape are not part of this change.

## 0.3.6

### Added

- `migent provider list --json` includes a native headless option catalog discovered from each installed CLI, with flag aliases, descriptions, argument metadata, choices, defaults, and per-provider discovery errors. Added adapter contracts and a documentation map.

- `migent config validate|render|save <draft|->` and `migent workflow validate|render|save <draft|->` validate unsaved YAML or JSON drafts against the workspace's config layers and workflow references. `render` prints canonical YAML; `save` writes the same bytes atomically, creates files without overwriting by default, and requires a matching raw-content SHA-256 via `--base-hash` for updates. Comments are not preserved; replacing a commented file reports a warning. `--json` returns versioned results with structured diagnostics, field paths, and source locations where available (#62).
- `migent get <type> [name]` is a read-only lookup of workflows, roles, model aliases, and the effective config (`-o json|yaml|name`, `--json`). `migent get workflow --session <id>` shows the draft, frozen, or live workflow a session runs, with each stage's resolved provider and model. See `docs/cli.md`.
- `migent init` accepts `--planner-effort`, `--reviewer-effort`, and `--developer-effort` to configure effort separately for each role. Developer flags also have explicit `--developer-` names; the existing short names remain aliases.
- Provider wrapper startup failures now explain themselves. The wrapper reports its own failures (arguments, IPC, listen, provider spawn, runtime) to the owner, and the error names the cause with a short stderr excerpt instead of "did not start". A failed turn writes `diagnostics.json` in the execution directory (executable and argument count only, never other arguments). `MIGENT_DEBUG=1` adds a step trace on stderr and in `debug.log`. `migent doctor --session <id>` lists recorded diagnostics as warnings and now accepts role sessions.
- Every failed execution writes `failure.md`: a readable report with the stage, attempt, provider, `failure_reason`, the error message, and pointers to `diagnostics.json` or the verify report. CLI output names each one as `failure: executions/<id>/failure.md`, including an attempt that a later retry recovered from.

- `migent doctor` checks that each configured model name exists in the provider's model list.
- `migent session run` runs the `doctor --session` checks before a workflow session starts and exits 2 on a problem. `--skip-preflight` bypasses it.

### Changed

- `migent init` offers a searchable list of models across installed providers, reuses each catalog during setup, and stores selected effort in the role effort field. Generated instructions remain on single lines.
- Health checks moved out of the kernel into a new package, `@nodeint/migent-doctor` (CLI â†’ doctor â†’ kernel). The kernel no longer exports `diagnose`, `doctor`, `diagnoseSession`, `sessionEffortKeys`, `sessionDiagnosticsCheck`, `Check`, `DiagnoseOptions`, `ModelEffortCheck`, `DiagnoseSessionOptions`, or `SessionDiagnosis`; import them from the doctor package. Session workflow selection stays in the kernel. The kernel gains `mergeConfigLayers`, `readConfigLayer`, `listModelDefinitions`, and `resolveEffectiveProvider`, and `ConfigurationError` carries optional `code`, `path`, `layer`, and `position`. `migent doctor` output is unchanged.
- `migent init` stores selected role models in the shared config, starts local configuration with empty model and role overrides, and includes explicit decision criteria and outputs in workflow templates.
- Decision `when` guidance is optional. Migration no longer generates placeholder guidance, and doctor no longer warns about existing placeholders.
- A signal-like exit of the wrapper during startup no longer reports a startup failure when a cancellation arrives within a short window; it is reported as a cancellation.
- `CommandExecutor.run` now takes an options object and returns `{ stdout, error, exitCode, failure? }` instead of a tuple. Callers of the exported class must update.

### Fixed

- OpenCode sessions retain their identity before provider startup. Cancellation and timeout explicitly interrupt the server-side turn before local process cleanup, retry early session-creation races, and warn when remote cleanup cannot be confirmed.
- `response.md` holds only the model's response. A provider that cannot start leaves it absent instead of writing the error text there. A failed turn also no longer stores Migent's error as an assistant message in `conversation.json`, so a later resume cannot replay that error as something the model said.

## Older versions

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
