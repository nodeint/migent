# Providers and model configuration

Models describe execution. Roles describe intent. `migent init` creates
`planner`, `reviewer`, and `developer` roles with an independent model object
in each `default_model`:

```yaml
# .migent/config.yaml
schema_version: 3
roles:
  planner:
    default_model:
      provider: codex
      model: gpt-5
      options:
        model_reasoning_effort: high
  developer:
    default_model:
      provider: codex
      model: gpt-5
      options:
        model_reasoning_effort: medium
  reviewer:
    default_model:
      provider: grok
      model: grok-4
```

Use provider/model IDs and option values supported by your installed CLIs.
`migent provider list` lists available choices; `migent doctor` checks the
configuration. The installed skill's `references/schema-config.yaml` lists
configuration fields (`migent skill path` locates the bundled skill).

`roles.<name>.instructions` is an optional list included before stage
instructions in every prompt for that role. A standalone role run includes
the same instructions.

## Machine-specific overrides

`.migent/config.local.yaml` is optional and uncommitted. It accepts the same
keys as `config.yaml`. A local role default replaces the shared default;
supply the complete model definition:

```yaml
# .migent/config.local.yaml
roles:
  developer:
    default_model:
      provider: codex
      model: another-model-id
```

Named models merge key by key; role defaults, scalars, and lists replace shared values. The local
file's `schema_version` is ignored. Sessions use the merged configuration
from when they started; see [Sessions](sessions.md) for adopting later edits.

## Reuse a named model

When several roles or stages need the same model settings, define a named
entry under `models` and use its name as `default_model`:

```yaml
schema_version: 3
models:
  deep_reasoning:
    provider: codex
    model: gpt-5
roles:
  developer:
    default_model: deep_reasoning
  reviewer:
    default_model: deep_reasoning
```

Existing named-model configurations remain supported, including local
mappings for shared empty entries such as `deep_reasoning: {}`. Doctor lists
missing mappings and the YAML to add. Use descriptive names such as
`deep_reasoning` or `code_generation` to keep model choices separate from
role names.

## Inline role defaults

Put a model directly in a role when it does not need a shared alias:

```yaml
schema_version: 3
roles:
  developer:
    default_model:
      provider: codex
      model: gpt-5
      effort: high
```

No `models` section is needed for inline-only setups. To reuse a model, set
`default_model` to its alias in `models`. Put `effort`, `client`, and `options`
inside the model definition.

To change a role on this machine, set its `default_model` in `config.local.yaml`.
Supply the full model definition or an alias; it replaces the shared default.

## Options

Each provider names its own options and lists the values for the selected
model. `migent init` asks for options marked as
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
- OpenCode accepts `agent`, sent as `--agent`; `thinking`, a boolean string
  controlling display of thinking blocks (`true` sends `--thinking`); and
  `variant`, rendered as a `#variant` suffix on the model ID for OpenCode V2.
  Only `variant` is overridable and stored on the provider session. None of
  these options is prompted for. Other keys are rejected.

A stage `options` map overrides the same keys on the model. Only
options the provider marks as overridable are part of the provider session.

## Schema version

`schema_version` on `.migent/config.yaml` and on each workflow file is the
document version. A missing value is version 0. A command that uses those
files stops while the recorded version is older and tells you to run
`migent migrate`. That command asks before writing. `migent migrate --yes`
writes without asking.

## Selection and overrides

A stage normally uses its role's default model. It may select another named
model or override the reasoning level:

```yaml
stages:
  - id: security_review
    role: reviewer
    model: critical_review
    options:
      model_reasoning_effort: high
```

Model options provide the base configuration. A stage `options` map overrides
those keys for that turn, and CLI option overrides apply last.

Migent currently includes providers for the headless `agy`, `claude`, `codex`,
`grok`, and `opencode` CLIs. Those CLIs own authentication, tool use, and agent execution;
Migent owns selection, prompts, routing, and persistence.

## Usage

Each provider selects the usage events from one process and stores them on the
turn. When a workflow session becomes `completed`, Migent asks that same provider to
normalize the capture and writes `metrics.json`. A later change to the provider
does not change that file. A cumulative provider subtracts the previous capture
for the same provider agent. A per-process provider reports the process as
printed.

| Provider | What it prints | Tokens | Cost |
| --- | --- | --- | --- |
| claude | last `result` event | per process | `total_cost_usd`, cumulative per conversation. This is a client estimate, not a bill. |
| codex | each `turn.completed` | cumulative per thread. `input_tokens` includes cache reads, and metrics subtract them. | none |
| grok | `end`, or the last `usage` event when `end` is absent | per process | `total_cost_usd` on `end`, per process. A `usage` event has no cost. |
| opencode | each printed `step_finish` | per process; sum of `tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read`, and `tokens.cache.write`; input is not reduced by cache reads; a missing final `step_finish` undercounts | sum of `part.cost` |
| agy | `result.usage` and each `DONE` step that has `usage` | step usage is per process. `result.usage` is cumulative per conversation. | none. Cache reads were not observable. |

`input_tokens` in metrics excludes cache reads. `reasoning_tokens` is reported
beside `output_tokens` and is not added to it. A field that is missing, not a
finite number, or a negative delta is null.


## Model effort

Set `roles.<role>.default_model.effort` for an inline model, or
`models.<alias>.effort` for a named model, in either config file to adjust
thinking level without using the CLI-specific option name:

```yaml
models:
  code_generation:
    provider: codex
    model: gpt-5
    effort: high
```

The alias follows the selected `client`, or the provider's default CLI client:
Codex uses `model_reasoning_effort`, Grok uses `reasoning-effort`, and Claude
and Antigravity use `effort`. OpenCode V2 uses `variant`, which the client renders
as `provider/model#variant` (for example `openai/gpt-5#high`). Available variants
depend on the selected model. Do not combine effort or `options.variant` with
a model ID that already contains a `#variant` suffix.
Values pass through unchanged and must be supported by the selected client/model.
Omitting `effort` preserves existing behavior. Local effort replaces shared effort.

Use either `effort` or its native option in the model's `options`, never both
(including after shared/local config merge). Unsupported clients, empty values,
and non-string values are configuration errors. Existing native options still work.

This field is supported only on models. Role and stage `options` can still
override the resolved native option, followed by command-line option overrides.
Sessions freeze the resolved native options.


`migent doctor` checks model effort against the selected client's supported values.
Invalid or empty values report the model field and `Valid values`. If the values
cannot be verified, doctor prints a warning instead of rejecting an otherwise
well-formed effort. Empty or non-string values remain errors.
