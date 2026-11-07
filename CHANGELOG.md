# Changelog

## Unreleased

### Added

- Every abnormal provider turn now leaves `diagnostics.json` (schema version 2): a non-zero exit even when stderr was empty, a provider-reported error at exit 0, and a non-zero exit accepted as a completed turn. It adds `agent_id`, `failure.origin`, `failure.exit_code`, `failure.signal`, `stderr` sizes with a `drain` state, a content-free `stream_summary` (event labels and counts; CLI clients gain an optional `eventLabel()`), and a `result_state` of what the turn left (reply, artifact, `response.md`) next to Migent's own check results and the provider-turn verdict. `execution.json` records `final_turn` for provider executions, and `failure.md` uses it to name the provider failure as the cause only when the diagnostics belong to the turn that ended the execution. `migent doctor --session` also shows origin, turn and verdict (#72).
- `migent get providers`, `get clients`, `get models [--client <id>]`, `get options [--client <id>] [--native]`, and `get efforts [--client <id>]` expose machine-level discovery as separate resource types, each with a singular lookup, `-o json|yaml|name`, and `--json`. The machine types work outside a project. `get providers` and `get clients` run no subprocess; `get clients` reports PATH findings only. `get models`, `get efforts`, and `get options --native` ask each selected client's own CLI, warn on stderr for a client that is skipped or fails, and still print the other clients' rows and exit 0. A singular model, option, or effort is keyed by (client, name) and asks for `--client` when more than one client matches.
- The doctor package accepts a client-keyed catalog source in `loadCatalog` and `loadOptionValues`, so catalog discovery uses a client's own command, parser, and stdin instead of a provider with the same name. Existing provider callers are unchanged.

### Changed

- **Breaking (implementation snapshot, workflow review pending):** Agents select `client.type` directly; configuration and workflows use schema version 6. Run `migent migrate` and replace provider selection flags with client selection flags.
- **Breaking:** `migent provider list` is removed, including `--json`. It exits 2 and names `migent get providers`, `migent get clients`, `migent get models`, `migent get options`, and `migent get efforts`, and `provider` no longer appears in help. The `{ok, providers}` envelope, `headless_options`, and the exit-1-when-no-models rule are gone; the new lists print a plain array and exit 0, including when every client is skipped or fails.

### Fixed

- Client migration writes inline workflow agents, preserves role-agent comments and inherited v4 client selections, and checks the written document. Resume validates every turn's client evidence before creating or reopening executions. Shared quota waits retry all affected stages once per reset window, and legacy waits and metrics use recorded client evidence.

- Schema v6 migration preserves shared client defaults when local configuration selects another client. Legacy metrics use execution evidence for both the client field and usage parsing.

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

## 0.3.5

### Added

- `migent doctor --session <id>` validates the workflow one session runs without starting it: a prepared session's editable `workflow.yaml`, a started session's `workflow.frozen.yaml` with its pinned roles and targets, or an older session's live workflow. It checks only that workflow and its provider CLIs, is read-only, reports the checked source and path (`--json` adds a `session` object), and warns when a frozen session differs from live files.

- `migent session prepare` now writes an empty `task.md` and an editable `workflow.yaml` in the session directory. The draft is the session's workflow source, so a prepared session can be adjusted without changing `.migent/workflows/`; `session run --session` validates the draft, requires its `id` to match, and freezes it when the session starts.

- `migent session run --session <id>` starts a prepared workflow session from its recorded workflow, so `--workflow` is optional. A given `--workflow` must still match the session's workflow id. Creating a session still requires `--workflow`.

### Changed

- The README explains role sessions, workflow capabilities, and the roadmap, with expanded setup and workflow examples, role instructions, human questions, and published outputs.

- The Migent skill now provides a command guide with usage scenarios and routes detailed workflow, role, resume, reply, and configuration tasks to focused references.

### Fixed

- A session no longer stays stuck in `running` when `migent session run` is killed right after a stage starts. Each execution now records its host and owner pid when it is created, not only after the provider spawns, so `migent session continue` can tell the owner is gone, fail the orphaned execution, and resume instead of refusing with "has an unverified live provider process". Executions created by earlier versions still need manual recovery (#51).

## 0.3.4

### Added

- `migent update` upgrades Migent to the latest published version with the package manager that installed it (npm, pnpm, yarn, or bun), or prints the command when it cannot tell. `--check` (or `--dry-run`) only reports; `--json` prints one object. After an upgrade it suggests `migent migrate` and `migent skill update` (#46).

### Changed

- Stage prompts are restructured as Markdown sections, ordered stable to variable: the response contract (status table, decisions, question rules) first, then the stage (`Role` and `Stage` instructions as separate lists, with stage lines already in the role list dropped, then constraints and verify), then upstream and routing context, then an `Execution` block with the task, session, question file and artifact paths, and a closing `Do` that is the only instruction for the turn. The instruction follows what the turn is (start, revisit, human reply, answers, verify repair, question-file correction); the kind is saved as `turn_kind` in `execution.json` so a resumed turn keeps it. The header format is shown as a block, and prompts no longer mention routing or execution IDs. The contract states that `recommended` holds the option letters Migent assigns (#44).

- Answers to stage questions are structured: every answer is numbered, echoes its question and selection kind, always has `Selected:` (option ID and label, or `none`), and adds `Free text:` only when given (#44).

- A turn that goes back to the same agent under the same response protocol (answering its questions, a verify repair, a question-file correction) no longer resends the full contract. It sends the new `Execution` paths, the previous artifact directory when resuming a question, and a short status reminder (#44).

### Fixed

- `migent session continue <session> --stage <stage> --reply` keeps running the workflow after the answered stage. Before, it dispatched only that stage, like `--once`, and left downstream stages undispatched. `--stage` without `--reply` still dispatches one stage.

## 0.3.3

### Added

- `migent doctor` warns about workflow and role keys Migent does not use, with a suggested key, and about decision `when` text left as the migration placeholder.

- `migent session continue --reply` redirects a stopped (cancelled) workflow stage or role session. The reply runs as a new execution in the same conversation.

### Changed

- Agents ask questions by writing a JSON document to a request file whose path is in the response contract, then answering `status: question`. The response body is a normal report and is never parsed for questions, which removes the contradiction between "the body is JSON" and "use a blank line before the report body". An unusable file gets one correction turn, then the stage fails with `question_file_invalid` and an error that names the file, the problem and how to recover. `parseStageOutcome` from `@nodeint/migent-kernel` now reads response headers only; `resolveStageOutcome` loads the question file. Inline JSON in the response is no longer accepted.

- Prompt templates and renderers live in the new `@nodeint/migent-prompts` package and render from packaged Markdown templates while preserving workflow and conversation behavior.

- Stage prompts state status meanings once, describe the verify gate as engine behavior, name the artifact once, and render answered questions as readable Q/A text. Re-entry prompts name the task, the stage's previous response, and upstream artifacts updated since its last visit.

- `migent init` renders role models and sample workflows from packaged project templates.

## Older versions

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
