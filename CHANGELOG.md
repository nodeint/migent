# Changelog

## Unreleased

## 0.11.0

### Added

- The opt-in `summarizer` plugin (`plugins.summarizer.enabled: true` plus an `agent`) writes
  `plugins/summarizer/summary.md`, an agent-written session summary. By default it runs on completion, a question, a
  blocked stop and an expired stop. ([#191](https://github.com/nodeint/migent/pull/191))
- Setting `plugins.summarizer.triggers` replaces those defaults, so list every trigger you want, such as
  `[completed, execution]`, to also run after each finished execution. ([#191](https://github.com/nodeint/migent/pull/191))
- `migent session show` lists the summary and whether it is `current` or `stale`, and `migent session show --summary`
  prints its text. ([#191](https://github.com/nodeint/migent/pull/191))
- Plugin API 1.3 adds the bounded `artifacts` session read. ([#191](https://github.com/nodeint/migent/pull/191))

### Changed

- An advisory plugin's valid proposals are now applied even when the session advances while its handler runs, instead
  of being discarded as stale. ([#191](https://github.com/nodeint/migent/pull/191))

## 0.10.1

### Breaking

- The prompt-cache-expiry resume policy is now the first-party `prompt_cache_ttl` plugin and the config schema is
  version 8: run `migent migrate` to move `resume_policies`, an agent's `resume_policy`, and a stage's
  `session.on_expired` under `plugins.prompt_cache_ttl` and `prompt_cache_ttl`.
  Sessions started before this release keep their frozen policies.
  ([#184](https://github.com/nodeint/migent/pull/184))
- The stage view of `get workflow --json` no longer has an `on_expired` field, so JSON consumers must stop reading it.
  `migent migrate` does not update JSON consumers. ([#184](https://github.com/nodeint/migent/pull/184))

### Added

- The first-party `next` plugin asks each stage with `downstream` which workflow to run next and records the
  answers in `plugins/next/recommendations.json`. `session show` and `session follow --json` list them as
  `recommendations`; disable the plugin with `plugins.next.enabled: false`. ([#188](https://github.com/nodeint/migent/pull/188))
- New conversations are stamped response protocol 4, which prepares plugin response extensions without changing the
  agent-facing contract. An older Migent reads this stamp as a handoff-file protocol and ignores extensions. ([#187](https://github.com/nodeint/migent/pull/187))
- Stage handoffs accept plugin response extensions: under protocol 4 the stage prompt lists each extension and its
  frozen schema, and `handoff.json` may carry the payload, which the core validates and stores as
  `response_extensions` in `execution.json`. An invalid payload gets one `handoff` correction turn, and protocol 3
  and 2 conversations are unchanged. ([#187](https://github.com/nodeint/migent/pull/187))
- A plugin reads its own stored response extension payload: `execution.response_extension` in the
  `execution.finished` hook input and `responseExtension` on its snapshot execution rows. It never sees another
  plugin's payload. ([#187](https://github.com/nodeint/migent/pull/187))
- Plugin API 1.2: a plugin may declare a pure `responseContract` that the session freeze evaluates per stage and
  records as `response_contracts` in `workflow.frozen.yaml`. ([#187](https://github.com/nodeint/migent/pull/187))
- Plugin API 1.1: a plugin may declare an optional pure `validate`, which `migent doctor`, session creation, and
  role creation run against the config. ([#184](https://github.com/nodeint/migent/pull/184))
- Contracts declare a static plugin extension catalog (`PLUGIN_EXTENSIONS`) that lets a plugin claim flat keys on
  workflows, stages, agents, and roles. `createPluginRegistry` checks a manifest's `extensions` against it. ([#182](https://github.com/nodeint/migent/pull/182))
- The workflow parser, draft collector, and the session freeze accept, validate, and keep plugin-claimed keys on
  workflows and stages. ([#182](https://github.com/nodeint/migent/pull/182))
- Config loading, `migent doctor`, and agent and role resolution accept, validate, and carry plugin-claimed keys on
  named agents, inline agents, and roles. ([#182](https://github.com/nodeint/migent/pull/182))
- The session freeze records plugin-claimed keys on workflows, stages, resolved agents, and roles, and reads them
  without the current extension catalog. ([#182](https://github.com/nodeint/migent/pull/182))
- Resuming a session refuses when a plugin that owns frozen extension keys is unregistered or declares another
  extension version, and a plugin with an extension catalog entry may change its semver when its frozen entry still
  validates. ([#182](https://github.com/nodeint/migent/pull/182))
- Plugins read their own frozen extension keys through `config.extensions` (`workflow()`, `stage(id)`, `agent(id)`,
  `role(name)`), and no other plugin read, including `call.session.snapshot()` and `config.core`, exposes
  plugin-owned keys. ([#182](https://github.com/nodeint/migent/pull/182))

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

## Older versions

- [0.6.0](https://github.com/nodeint/migent/releases/tag/v0.6.0)
- [0.5.6](https://github.com/nodeint/migent/releases/tag/v0.5.6)
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
