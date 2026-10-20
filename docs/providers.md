# Providers and model configuration

Models describe execution. Roles describe intent. Both are declared in
`.migent/config.yaml`. The Migent skill lists every accepted key in
`.agents/skills/migent/references/schema-config.yaml`.

```yaml
schema_version: 2
models:
  implementation:
    provider: codex
    model: gpt-5
    options:
      model_reasoning_effort: medium

roles:
  developer:
    default_model: implementation
    instructions:
      - Implement the change described in the task.
      - Leave unrelated files unchanged.
```

`roles.<name>.instructions` is an optional list of strings. Migent includes
that list in every prompt for the role, before the stage's own `instructions`.
`migent session run --role` prepends the same list to the prompt.

Use model identifiers and option values supported by the installed provider
CLI.

Roles can point at different providers. A planner on Codex and a reviewer on
Grok:

```yaml
schema_version: 2
models:
  planner-model:
    provider: codex
    model: gpt-5
    options:
      model_reasoning_effort: medium

  reviewer-model:
    provider: grok
    model: grok-4
    options:
      reasoning-effort: high

roles:
  planner:
    default_model: planner-model
  reviewer:
    default_model: reviewer-model
```

`migent init --preset plan` writes this kind of file. In a terminal it can
give the reviewer its own model entry. The names above are an example. Init
uses `default` and, when the reviewer has a second model, `review`.

## Options

Each adapter names its own options and lists the values for the selected
model. `migent init` and `migent config` ask for options marked as
prompts. Leaving one unset keeps the provider default.

- Antigravity prompts for `effort` (`low`, `medium`, `high`, `xhigh`, or
  `max`) and sends it as `agy --effort`. `mode` is `accept-edits`, `auto`, or
  `plan`. `agent` selects a named agent. `sandbox` and `skip_permissions` are
  `true` or `false`. Other keys are rejected. Leaving `skip_permissions` unset
  passes `--dangerously-skip-permissions` for that run.
- Codex prompts for `model_reasoning_effort`, read from
  `supported_reasoning_levels` in `codex debug models`. Any other option is a
  Codex config override passed as `codex exec -c key=value`.
- Grok prompts for `reasoning-effort`, read from the `grok` CLI for that
  model, and sends it as `--reasoning-effort`. Grok also accepts `max_turns`,
  `tools`, `disallowed_tools`, `permission_mode`, `rules`, `allow`, `deny`,
  and `sandbox`. Other keys are rejected.

A role or stage `options` map overrides the same keys on the model. Only
options the adapter marks as overridable are part of the provider session.

## Schema version

`schema_version` on `.migent/config.yaml` and on each workflow file is the
document version. A missing value is version 0. A command that uses those
files stops while the recorded version is older and tells you to run
`migent migrate`. That command asks before writing. `migent migrate --yes`
writes without asking.

The kernel walks one version at a time. A file at version 1 that is moving to
version 3 runs the version 1 function, then the version 2 function. Each
adapter defines those functions itself, separately for a model entry, a role,
and a workflow stage. Grok version 0 moves `thinking` to `reasoning-effort`.
Codex version 0 moves `thinking` to `model_reasoning_effort`. A project's own
`version` field is left as it is.

## Selection and overrides

A stage normally uses its role's default model. It may select another named
model or override the reasoning level:

```yaml
stages:
  - id: security-review
    role: reviewer
    model: security-model
    options:
      model_reasoning_effort: high
```

Model options provide the base configuration. A role `options` map overrides
those keys, and a stage `options` map overrides them for that turn.

Migent currently includes adapters for the headless `agy`, `claude`, `codex`,
and `grok` CLIs. Those CLIs own authentication, tool use, and agent execution;
Migent owns selection, prompts, routing, and persistence.

## Usage

Each adapter selects the usage events from one process and stores them on the
turn. Metrics ask that same adapter to normalize the capture when they are
read. A cumulative provider subtracts the previous capture for the same
provider agent. A per-process provider reports the process as printed.

| Provider | What it prints | Tokens | Cost |
| --- | --- | --- | --- |
| claude | last `result` event | per process | `total_cost_usd`, cumulative per conversation. This is a client estimate, not a bill. |
| codex | each `turn.completed` | cumulative per thread. `input_tokens` includes cache reads, and metrics subtract them. | none |
| grok | `end`, or the last `usage` event when `end` is absent | per process | `total_cost_usd` on `end`, per process. A `usage` event has no cost. |
| agy | `result.usage` and each `DONE` step that has `usage` | step usage is per process. `result.usage` is cumulative per conversation. | none. Cache reads were not observable. |

`input_tokens` in metrics excludes cache reads. `reasoning_tokens` is reported
beside `output_tokens` and is not added to it. A field that is missing, not a
finite number, or a negative delta is null.
