# Providers and agent configuration

An agent describes execution: a provider, a model, an optional effort, and the
CLI client that runs it with its options. A role describes intent: its
responsibilities and which agent it uses. `migent init` creates `planner`,
`reviewer`, and `developer` roles with an independent agent object in each
`agent`:

```yaml
# .migent/config.yaml
schema_version: 5
roles:
  planner:
    description: Designs the approach and writes the plan.
    agent:
      provider: codex
      model: gpt-5
      client:
        options:
          model_reasoning_effort: high
  developer:
    description: Implements the change and verifies it.
    agent:
      provider: codex
      model: gpt-5
      client:
        options:
          model_reasoning_effort: medium
  reviewer:
    description: Reviews plans and implementations against the task.
    agent:
      provider: grok
      model: grok-4
```

Use provider/model IDs and option values supported by your installed CLIs.
`migent provider list` lists available choices; `migent doctor` checks the
configuration. The installed skill's `references/schema-config.yaml` lists
configuration fields (`migent skill path` locates the bundled skill).

`roles.<name>.responsibilities` is an optional list included before stage
instructions in every prompt for that role. A standalone role run includes
the same responsibilities. `roles.<name>.description` is an optional one-line
summary shown by `migent get roles`; it is not part of any prompt.

## Agent fields

| Field | Required | Meaning |
| --- | --- | --- |
| `provider` | yes | Provider ID, such as `codex` or `grok`. |
| `model` | yes | Model ID for that provider. |
| `effort` | no | Thinking level; see [Agent effort](#agent-effort). |
| `client.type` | no | CLI client that runs the model. Required by `byteplus`. |
| `client.options` | no | Native options for the selected client. |

`client` is always a mapping. The earlier forms `client: <id>` and a top-level
`options` map are not accepted; `migent migrate` moves them.

## Machine-specific overrides

`.migent/config.local.yaml` is optional and uncommitted. It accepts the same
keys as `config.yaml`. A local role agent replaces the shared agent;
supply the complete agent definition:

```yaml
# .migent/config.local.yaml
roles:
  developer:
    agent:
      provider: codex
      model: another-model-id
```

Named agents merge key by key; role agents, scalars, and lists replace shared values. The local
file's `schema_version` is ignored. Sessions use the merged configuration
from when they started; see [Sessions](sessions.md) for adopting later edits.

## Reuse a named agent

When several roles or stages need the same settings, define a named entry
under `agents` and use its name as the role's `agent`:

```yaml
schema_version: 5
agents:
  deep_reasoning:
    provider: codex
    model: gpt-5
roles:
  developer:
    agent: deep_reasoning
  reviewer:
    agent: deep_reasoning
```

Local mappings for shared empty entries such as `deep_reasoning: {}` remain
supported. Doctor lists missing mappings and the YAML to add. Use descriptive
names such as `deep_reasoning` or `code_generation` to keep agent choices
separate from role names.

## Inline role agents

Put an agent directly in a role when it does not need a shared name:

```yaml
schema_version: 5
roles:
  developer:
    agent:
      provider: codex
      model: gpt-5
      effort: high
```

No `agents` section is needed for inline-only setups. To reuse an agent, set
`agent` to its name in `agents`. Put `effort` and `client` inside the agent
definition.

To change a role on this machine, set its `agent` in `config.local.yaml`.
Supply the full agent definition or a name; it replaces the shared agent.

## Options

For the shared client/provider contracts, discovery catalogs, and validation
boundaries, see [Adapters](adpaters.md). The client-specific settings below
describe the existing configuration surface.

Each provider names its own options and lists the values for the selected
model. They go in the agent's `client.options`. `migent init` asks for options
marked as prompts. Leaving one unset keeps the provider default.

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

Only options the provider marks as overridable are part of the provider session.

## Schema version

`schema_version` on `.migent/config.yaml` and on each workflow file is the
document version; the current version is 5. A missing value is version 0. A command that uses those
files stops while the recorded version is older and tells you to run
`migent migrate`. That command asks before writing. `migent migrate --yes`
writes without asking.

## Selection and overrides

A stage normally uses its role's agent. It may select another named agent, or
carry a complete inline agent:

```yaml
stages:
  - id: security_review
    role: reviewer
    agent: critical_review
  - id: final_check
    role: reviewer
    agent:
      provider: codex
      model: gpt-5
      effort: high
```

A stage's `agent` replaces the role's agent entirely: an inline agent inherits
nothing from the role, so restate the provider and model even when only the
effort differs. Stages have no `options` of their own in schema version 5.
CLI option overrides apply last.

Migent currently includes providers for the headless `agy`, `claude`, `codex`,
`grok`, and `opencode` CLIs. Those CLIs own authentication, tool use, and agent execution;
Migent owns selection, prompts, routing, and persistence.

## Usage

The shared capture and normalization contract is documented in
[Adapters: Failures and usage](adpaters.md#failures-and-usage).
The table below records client-specific usage behavior.

| Provider | What it prints | Tokens | Cost |
| --- | --- | --- | --- |
| claude | last `result` event | per process | `total_cost_usd`, cumulative per conversation. This is a client estimate, not a bill. |
| codex | each `turn.completed` | cumulative per thread. `input_tokens` includes cache reads, and metrics subtract them. | none |
| grok | `end`, or the last `usage` event when `end` is absent | per process | `total_cost_usd` on `end`, per process. A `usage` event has no cost. |
| opencode | each printed `step_finish` | per process; sum of `tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read`, and `tokens.cache.write`; input is not reduced by cache reads; a missing final `step_finish` undercounts | sum of `part.cost` |
| agy | `result.usage` and each `DONE` step that has `usage` | step usage is per process. `result.usage` is cumulative per conversation. | none. Cache reads were not observable. |

## Agent effort

Set `roles.<role>.agent.effort` for an inline agent, or
`agents.<name>.effort` for a named agent, in either config file to adjust
thinking level without using the CLI-specific option name:

```yaml
agents:
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

Use either `effort` or its native option in the agent's `client.options`, never
both (including after shared/local config merge). Unsupported clients, empty
values, and non-string values are configuration errors. Existing native options
still work. Command-line option overrides apply after the resolved native
option. Sessions freeze the resolved native options.


`migent doctor` checks that the agent's model exists (see
[cli.md](cli.md#model-availability)) and checks model effort against the
selected client's supported values.
Invalid or empty values report the model field and `Valid values`. If the values
cannot be verified, doctor prints a warning instead of rejecting an otherwise
well-formed effort. Empty or non-string values remain errors.
