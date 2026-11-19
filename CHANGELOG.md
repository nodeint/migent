# Changelog

## Unreleased

### Added

- Contracts declare a static plugin extension catalog (`PLUGIN_EXTENSIONS`, empty today) that lets a plugin claim flat
  keys on workflows, stages, agents, and roles, and `createPluginRegistry` checks a manifest's `extensions` against
  it. ([#174](https://github.com/nodeint/migent/issues/174))
- The workflow parser, draft collector, and the session freeze accept, validate, and keep plugin-claimed keys on
  workflows and stages. ([#174](https://github.com/nodeint/migent/issues/174))
- Config loading, `migent doctor`, and agent and role resolution accept, validate, and carry plugin-claimed keys on
  named agents, inline agents, and roles. ([#174](https://github.com/nodeint/migent/issues/174))
- The session freeze records plugin-claimed keys on workflows, stages, resolved agents, and roles, and reads them
  without the current extension catalog. ([#174](https://github.com/nodeint/migent/issues/174))

## 0.9.0

### Breaking

- A plugin is now `{ manifest, activate }` instead of `{ manifest, handlers }`, the manifest gains `apiVersion` and
  `uses` (`uses.agents` replaces `capabilities: ['invokeAgent']`), and the `output` intent becomes the `artifact`
  proposal. Migrate each plugin to `activate` and declare its `uses`, including a `uses.artifacts` claim for each file.
  ([#169](https://github.com/nodeint/migent/pull/169))

### Added

- Plugin host: the `plugins` config section is frozen per session, checked on resume and validated by `migent doctor`,
  and registered plugins run at `session.started`, `execution.finished` and `session.stopped`.
  `session show` gains a `plugins` section and `session follow` streams `plugin.*` records.
  ([#164](https://github.com/nodeint/migent/pull/164))
- Operation interception: a plugin registers `operations.intercept('agent.turn', { before, after })` and a `before`
  interceptor can patch `prompt`. Invalid or failing interceptors leave the value unchanged and follow the plugin
  failure policy. ([#169](https://github.com/nodeint/migent/pull/169))
- Plugins can read the session through `call.session` with freshness checks and observe a new `session.completed`
  event. Plugin artifacts are durable, and `session show` lists unmatched ones as `unrecorded`.
  ([#169](https://github.com/nodeint/migent/pull/169))

### Changed

- Session metrics are now written by the first-party `metrics` plugin to `plugins/metrics/metrics.json` instead of the
  root `metrics.json`, on normal completion and `session complete`. `session metrics` reads the new path first and
  falls back to the legacy root file. ([#177](https://github.com/nodeint/migent/pull/177))
- Sessions without a frozen workflow no longer get metrics, and if plugin selection fails, `session complete`
  completes the session without plugins and warns on stderr. ([#177](https://github.com/nodeint/migent/pull/177))
- Plugins run in configuration order instead of id order. A registered `defaultEnabled` plugin, such as `metrics`,
  runs first when `plugins:` does not name it, including implicitly in sessions frozen before it was registered.
  ([#169](https://github.com/nodeint/migent/pull/169))

### Fixed

- A workflow file that exists but fails validation is now reported as `Workflow <id> is invalid` with the validation
  error, instead of `Workflow not found`. ([#170](https://github.com/nodeint/migent/pull/170))
- Agent stage prompts now always list the execution artifact directory, even when the stage declares no artifact.
  ([#172](https://github.com/nodeint/migent/pull/172))
- The resume gate now measures cache age from the source execution's last provider activity instead of its end time.
  ([#178](https://github.com/nodeint/migent/pull/178))
- A stage prompt lists decision-scoped artifacts under their own lead, so a reviewer that chooses `revise` is no
  longer told to write a file that only another decision needs.
  ([#179](https://github.com/nodeint/migent/pull/179))

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

## Older versions

- [0.5.5](https://github.com/nodeint/migent/releases/tag/v0.5.5)
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
