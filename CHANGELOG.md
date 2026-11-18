# Changelog

## Unreleased

### Breaking

- The plugin contract changes shape, in the first step of the shared `MigentContext` API. A plugin is
  `{ manifest, activate }` instead of `{ manifest, handlers }`. The manifest gains `apiVersion` and `uses`, and
  `uses.agents` replaces `capabilities: ['invokeAgent']`. The `output` intent becomes the `artifact` proposal, which
  an invocation may propose at most once and which must match a `uses.artifacts` claim. `plugin.failed` gains the
  `stale` reason, and `plugin.decision` and `plugin.failed` gain `notes`. No plugin is registered, so no session
  changes. ([#166](https://github.com/nodeint/migent/issues/166))

### Changed

- Plugins run in configuration order instead of id order, and `plugins.frozen` and `session show` list them in chain
  order. A registered `defaultEnabled` plugin that `plugins:` does not name runs first with empty options, is
  pinned by new freezes and `--refresh-workflow`, and runs implicitly (`source: implicit` in `session show`) in a
  session frozen before it was registered. No default plugin is registered, so no session changes.
  ([#166](https://github.com/nodeint/migent/issues/166))

### Added

- Plugin host core. The `plugins` config section is registered: sessions freeze it per entry, record a
  `plugins.frozen` event at every freeze, and check the frozen plugins on resume, and `migent doctor` validates the
  entries against the plugin registry. Registered plugins run at `session.started`, `execution.finished` and
  `session.stopped`; the core validates and applies their intents, and every failure follows the `ignore`, `stop` or
  `fail` policy. The plugin manifest, hook, intent and event contracts and the leaf package
  `@nodeint/migent-plugins` with an empty registry are new. A plugin that declares `invokeAgent` can run one
  provider turn, stopped on timeout or cancellation. `session show` gains a `plugins` section (active set,
  invocations, failures, holds, interrupted invocations) and `session follow` streams `plugin.*` records.
  Without a `plugins` section, behavior is unchanged.
  ([#150](https://github.com/nodeint/migent/issues/150))

## 0.8.0

### Breaking

- Migent no longer writes or reads the session-level `questions.json`;
  old files stay as they are and the `SessionQuestions` schema stays published as historical.
  Migrate by reading pending questions from `status.json` or `migent session show --json`, each asked batch from
  `executions/<id>/questions.json`, and answers from `executions/<id>/input.json`.
  ([#146](https://github.com/nodeint/migent/pull/146))

### Added

- `executions/<id>/input.json` records the human input an attempt opened with:
  what the agent received, what the human typed, and structured answers.
  Replies to a blocked stage add `data.reply` to its `session.active` resume event, and replies to a cancelled stage add
  `data.origin` (`human` or `cut_off`). ([#146](https://github.com/nodeint/migent/pull/146))
- TypeBox schemas, generated JSON Schema and a
  [reference page](https://github.com/nodeint/migent/blob/main/docs/reference/session-files.md) for the session files
  and every `events.jsonl` event, a typebox-free `@nodeint/migent-contracts/data` subpath.
  ([#144](https://github.com/nodeint/migent/pull/144))
- `migent session delete` removes stopped sessions by ID or by `--older-than` and `--status` filters, with `--dry-run`,
  `--yes`, and `--json`.
  It never deletes a running session, and a deleted numeric ID is never reissued
  ([CLI](https://github.com/nodeint/migent/blob/main/docs/cli.md#inspect-sessions)).
  ([#139](https://github.com/nodeint/migent/pull/139))

## 0.7.0

### Added

- Once the prompt cache has expired, a resumed role can ask, start fresh or resume anyway.
  Define a `resume_policies` entry with `cache_ttl`, then set `resume_policy` on an agent or let `default` apply;
  answer a pending `ask` with `migent session resume <session> <decision>`
  ([configuration](https://github.com/nodeint/migent/blob/main/docs/agents.md#resume-policies)).
  ([#135](https://github.com/nodeint/migent/pull/135))

## 0.6.0

### Breaking

- `migent init` now takes agents from the project template, and the per-role flags (`--planner-*`, `--reviewer-*`,
  `--developer-*`, `--client`, `--model`, `--effort`, `--option`, `--*provider`) are rejected.
  Use `--agent NAME=CLIENT:MODEL`, `--agent-effort NAME=EFFORT` and `--agent-option NAME:KEY=VALUE` with the names
  `planning`, `review` and `coding`, e.g. `--agent planning=codex:gpt-5`.
  ([#128](https://github.com/nodeint/migent/pull/128))
- Stage `verify` commands now run in cmd.exe (`%ComSpec%`) on Windows instead of `sh`;
  other systems still use `/bin/sh`.
  On Windows, rewrite POSIX-only `verify` commands (`&&` chains with `$VAR`, `test`, `grep`, `rm`) in cmd.exe syntax or
  call a script that works there, e.g. `node scripts/check.mjs`. ([#127](https://github.com/nodeint/migent/pull/127))

### Changed

- The generated project has an `agents` section (`planning`, `review`, `coding`) that roles refer to by name;
  `planner` is renamed `architect` and a new `operator` role shares `coding` with `developer`.
  Existing projects are unchanged. ([#128](https://github.com/nodeint/migent/pull/128))
- For `agy`, `claude-code`, `grok` and `opencode`, valid options now come from the installed CLI's headless help, and
  `migent doctor`, `migent init` and the agent commands report `option-unknown`, `option-value-invalid`,
  `option-conflict` and `option-unverified`.
  Offline checks only refuse flags Migent sets itself, so a wrong option value reaches the client CLI unless doctor ran
  first. ([#124](https://github.com/nodeint/migent/pull/124))

### Fixed

- A Claude Code role can set any option `claude -p --help` lists, such as `autocompact: 200000`, and pass
  `migent doctor`. Numbers and booleans in YAML option values are stored as strings.
  ([#124](https://github.com/nodeint/migent/pull/124))
- Windows no longer needs Git Bash's `sh` on `PATH` to run `verify` commands, which previously failed with "Unable to
  start the verify shell". ([#127](https://github.com/nodeint/migent/pull/127))

## 0.5.6

### Added

- `migent session rename <session> "<title>"` changes a session's display title at any time, including during a live
  run. It writes only `title.json`;
  the task, events, and status are untouched, and `session list`, `show`, and `follow` show the new title at once.
  `--json` prints `{session_id, title, previous_title}`.

### Changed

- New sessions get short incrementing numeric ids (`1`, `2`, `3`, …) instead of UUIDs:
  the next id is the highest numeric session directory name plus one, starting at `1`.
  Sessions written by earlier versions (UUID, timestamp or `session_<hex>` ids) keep working unchanged and do not affect
  numbering.
  `session_id` and `prior_session_id` are now written as quoted strings in `manifest.yaml`, and the manifest reader also
  accepts an unquoted integer. A role run without a session id (library use) now also gets a numeric id.

## 0.5.5

### Added

- Stage replies that the agent can fix get one correction turn per failure kind instead of failing at once:
  a response-contract violation, a missing or empty required artifact or completion output, and an unusable question
  file.
  Exhausted corrections fail the stage with `response_contract_invalid`, `stage_output_missing` or
  `question_file_invalid`. `execution.json` records them under `corrections`;
  older `question_correction` entries are still read. New events: `response.contract_invalid`, `stage.output_missing`.

### Changed

- **Response protocol 3.** A stage now reports its outcome (`complete`, `blocked` or `question`) by writing one JSON
  file, `handoff.json`, in its execution directory, instead of `status:`/`decision:`/`blocker:` header lines plus a
  separate `question-request.json`. The response text is a free-form report.
  An unusable handoff (missing, empty, not JSON, not matching the schema, a decision the stage does not allow, or a
  question on a stage without `ask: human`) gets one correction turn, recorded as `corrections.handoff`, then fails with
  `handoff_file_invalid`. New event: `handoff.file_invalid`.
  The handoff document's JSON Schema is published as `HandoffDocument` in `@nodeint/migent-contracts`.
  A conversation keeps the protocol it started with:
  existing sessions finish their conversations on protocol 2 (headers and `question-request.json`, with the earlier
  corrections), and `execution.json` records `response_protocol`.
  Only a stage that starts with no source execution uses protocol 3.
  Custom clients and scripts that fake a stage reply must now write `handoff.json`.
- The missing-status error lists every status the stage allows, including `question` when the stage has `ask: human`.

## Older versions

- [0.5.4](https://github.com/nodeint/migent/releases/tag/v0.5.4)
- [0.5.3](https://github.com/nodeint/migent/releases/tag/v0.5.3)
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
