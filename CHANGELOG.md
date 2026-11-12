# Changelog

## Unreleased

## 0.6.0

### Breaking

- `migent init` now takes agents from the project template, and the per-role flags (`--planner-*`, `--reviewer-*`, `--developer-*`, `--client`, `--model`, `--effort`, `--option`, `--*provider`) are rejected. Use `--agent NAME=CLIENT:MODEL`, `--agent-effort NAME=EFFORT` and `--agent-option NAME:KEY=VALUE` with the names `planning`, `review` and `coding`, e.g. `--agent planning=codex:gpt-5`. ([#128](https://github.com/nodeint/migent/pull/128))
- Stage `verify` commands now run in cmd.exe (`%ComSpec%`) on Windows instead of `sh`; other systems still use `/bin/sh`. On Windows, rewrite POSIX-only `verify` commands (`&&` chains with `$VAR`, `test`, `grep`, `rm`) in cmd.exe syntax or call a script that works there, e.g. `node scripts/check.mjs`. ([#127](https://github.com/nodeint/migent/pull/127))

### Changed

- The generated project has an `agents` section (`planning`, `review`, `coding`) that roles refer to by name; `planner` is renamed `architect` and a new `operator` role shares `coding` with `developer`. Existing projects are unchanged. ([#128](https://github.com/nodeint/migent/pull/128))
- For `agy`, `claude-code`, `grok` and `opencode`, valid options now come from the installed CLI's headless help, and `migent doctor`, `migent init` and the agent commands report `option-unknown`, `option-value-invalid`, `option-conflict` and `option-unverified`. Offline checks only refuse flags Migent sets itself, so a wrong option value reaches the client CLI unless doctor ran first. ([#124](https://github.com/nodeint/migent/pull/124))

### Fixed

- A Claude Code role can set any option `claude -p --help` lists, such as `autocompact: 200000`, and pass `migent doctor`. Numbers and booleans in YAML option values are stored as strings. ([#124](https://github.com/nodeint/migent/pull/124))
- Windows no longer needs Git Bash's `sh` on `PATH` to run `verify` commands, which previously failed with "Unable to start the verify shell". ([#127](https://github.com/nodeint/migent/pull/127))

## 0.5.6

### Added

- `migent session rename <session> "<title>"` changes a session's display title at any time, including during a live run. It writes only `title.json`; the task, events, and status are untouched, and `session list`, `show`, and `follow` show the new title at once. `--json` prints `{session_id, title, previous_title}`.

### Changed

- New sessions get short incrementing numeric ids (`1`, `2`, `3`, …) instead of UUIDs: the next id is the highest numeric session directory name plus one, starting at `1`. Sessions written by earlier versions (UUID, timestamp or `session_<hex>` ids) keep working unchanged and do not affect numbering. `session_id` and `prior_session_id` are now written as quoted strings in `manifest.yaml`, and the manifest reader also accepts an unquoted integer. A role run without a session id (library use) now also gets a numeric id.

## 0.5.5

### Added

- Stage replies that the agent can fix get one correction turn per failure kind instead of failing at once: a response-contract violation, a missing or empty required artifact or completion output, and an unusable question file. Exhausted corrections fail the stage with `response_contract_invalid`, `stage_output_missing` or `question_file_invalid`. `execution.json` records them under `corrections`; older `question_correction` entries are still read. New events: `response.contract_invalid`, `stage.output_missing`.

### Changed

- **Response protocol 3.** A stage now reports its outcome (`complete`, `blocked` or `question`) by writing one JSON file, `handoff.json`, in its execution directory, instead of `status:`/`decision:`/`blocker:` header lines plus a separate `question-request.json`. The response text is a free-form report. An unusable handoff (missing, empty, not JSON, not matching the schema, a decision the stage does not allow, or a question on a stage without `ask: human`) gets one correction turn, recorded as `corrections.handoff`, then fails with `handoff_file_invalid`. New event: `handoff.file_invalid`. The handoff document's JSON Schema is published as `HandoffDocument` in `@nodeint/migent-contracts`. A conversation keeps the protocol it started with: existing sessions finish their conversations on protocol 2 (headers and `question-request.json`, with the earlier corrections), and `execution.json` records `response_protocol`. Only a stage that starts with no source execution uses protocol 3. Custom clients and scripts that fake a stage reply must now write `handoff.json`.
- The missing-status error lists every status the stage allows, including `question` when the stage has `ask: human`.

## 0.5.4

### Added

- `@nodeint/migent-contracts` publishes a JSON Schema file for every contract under `schemas/` (importable as `@nodeint/migent-contracts/schemas/…`), and exports `EXIT_CATALOG`, which describes every exit code per command family. Generated field tables for CLI output, config, workflow files, exit codes, and environment variables are in `docs/reference/`. Run `pnpm generate` after changing a contract.

### Changed

- **Breaking for `@nodeint/migent-kernel` consumers:** workflow definition code moved to the new `@nodeint/migent-workflow` package (model, strict parser, draft collector, catalog, file loading, `SCHEMA_VERSION`, `unknownWorkflowKeyEntries`, `parseYamlDocument`). The kernel no longer re-exports these symbols; import them from `@nodeint/migent-workflow`. `ConfigurationError` and `AskTarget` are still exported by the kernel, and `ConfigurationError` is the same class. Behavior, messages, and codes are unchanged.
- `@nodeint/migent-workflow` is a new package released with the others.
- Schema `$id`s now use the raw GitHub URL of the schema file on `main` instead of `https://migent.dev/schemas`. A schema added on `next` is served at its URL only after a release. `StageView` is now exported. CLI `--help` exit text now comes from `EXIT_CATALOG` and is unchanged.

## 0.5.3

### Added

- `client.type` is optional on an agent. When omitted, Migent runs each installed client's model-list command and uses the one client that lists the agent's `model` (OpenCode's `#variant` suffix is ignored), on every resolution and with no cache on disk. `effort` maps to the inferred client. No client listing the model is a `client-not-found` error, and several clients listing it is a `client-ambiguous` error; doctor reports both and a run refuses to start. `client.type` stays required when `client.options` is set (even an empty mapping). Inference is slower and depends on the machine's installed CLIs; set `client.type` to avoid both. Started sessions keep their frozen client.

## Older versions

- [0.5.2](https://github.com/nodeint/migent/releases/tag/v0.5.2)
- [0.5.1](https://github.com/nodeint/migent/releases/tag/v0.5.1)
- [0.5.0](https://github.com/nodeint/migent/releases/tag/v0.5.0)
- [0.4.1](https://github.com/nodeint/migent/releases/tag/v0.4.1)
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
