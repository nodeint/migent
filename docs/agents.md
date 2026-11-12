# Agent configuration

An agent describes execution: a CLI client, a model, an optional effort, and the
options passed to that client. A role describes intent: its responsibilities and
which agent it uses. `migent init` creates the `architect`, `reviewer`, `developer`,
and `operator` roles. They use the named agents `planning`, `review`, and `coding`
(`developer` and `operator` share `coding`):

```yaml
# .migent/config.yaml
schema_version: 7
agents:
  planning:
    model: gpt-5
    client:
      type: codex
      options:
        model_reasoning_effort: high
  review:
    model: grok-4
    client:
      type: grok
  coding:
    model: gpt-5
    client:
      type: codex
      options:
        model_reasoning_effort: medium
roles:
  architect:
    description: Designs the structure and plan for a task before implementation.
    agent: planning
  reviewer:
    description: Reviews plans and implementations against the task.
    agent: review
  developer:
    description: Implements the change and verifies it.
    agent: coding
  operator:
    description: Runs routine repository operations such as commits, pushes, and pull requests.
    agent: coding
```

The generated [config field reference](reference/config.md) lists every field.

Use model IDs and option values supported by your installed CLIs.
`migent get models` lists each client's model IDs, `migent get efforts` lists the
thinking levels per model, and `migent doctor` checks the configuration. The
installed skill's `references/schema-config.yaml` lists configuration fields
(`migent skill path` locates the bundled skill).

`roles.<name>.responsibilities` is an optional list included before stage
instructions in every prompt for that role. A standalone role run includes
the same responsibilities. `roles.<name>.description` is an optional one-line
summary shown by `migent get roles`; it is not part of any prompt.

## Agent fields

| Field | Required | Meaning |
| --- | --- | --- |
| `model` | yes | Model ID passed to the client unchanged. |
| `client.type` | no | CLI client that runs the model: `agy`, `claude-code`, `codex`, `grok`, or `opencode`. When omitted, Migent uses the one installed client whose model list contains `model`; see [Inferred client](#inferred-client). Required when `client.options` is set. |
| `effort` | no | Thinking level; see [Agent effort](#agent-effort). |
| `client.options` | no | Native options for the selected client. |

`client` is always a mapping. The earlier forms `client: <id>` and a top-level
`options` map are not accepted; `migent migrate` moves them.

The historical `provider` field was removed in `schema_version: 6`. A v6 agent
with `provider` is rejected with a hint to set `client.type` and run
`migent migrate`. `migent migrate` maps each legacy provider to its client:
`claude` → `claude-code`, `codex` → `codex`, `grok` → `grok`, `agy` → `agy`, and
`opencode` → `opencode`. `byteplus` has no default client and must name one.

## Inferred client

```yaml
roles:
  planner:
    agent:
      model: opus     # only claude-code lists "opus"
      effort: medium
```

Without `client.type`, Migent runs each installed client's model-list command and picks the
client whose list contains `model` exactly (OpenCode's `#variant` suffix is ignored). This happens
on every resolution that needs the client, with no cache on disk, and only for agents that omit
`client.type`. It costs seconds per client, so set `client.type` when speed matters.

- No client lists the model: `client-not-found`, naming the clients searched, not on PATH, or
  failed. Some lists are incomplete (Claude Code omits pinned IDs, Codex hides some models); set
  `client.type` for those.
- More than one client lists it: `client-ambiguous`. Doctor reports it and a run refuses to start.
  Set `client.type`.
- Inference depends on the machine's installed CLIs and accounts. Pin `client.type` (for example in
  `config.local.yaml`) for a portable config. A local override of a named agent that changes only
  `model` keeps the shared `client.type`.
- Started sessions run on the client frozen at start; resume never re-infers it.
- `--client`/`--model` command-line overrides still need both values.

## Machine-specific overrides

`.migent/config.local.yaml` is optional and uncommitted. It accepts the same
keys as `config.yaml`. A local role agent replaces the shared agent;
supply the complete agent definition:

```yaml
# .migent/config.local.yaml
roles:
  developer:
    agent:
      model: another-model-id
      client:
        type: codex
```

Named agents merge key by key; role agents, scalars, and lists replace shared values. The local
file's `schema_version` is ignored. Sessions use the merged configuration
from when they started; see [Sessions](sessions.md) for adopting later edits.

## Reuse a named agent

When several roles or stages need the same settings, define a named entry
under `agents` and use its name as the role's `agent`:

```yaml
schema_version: 7
agents:
  deep_reasoning:
    model: gpt-5
    client:
      type: codex
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
schema_version: 7
roles:
  developer:
    agent:
      model: gpt-5
      effort: high
      client:
        type: codex
```

No `agents` section is needed for inline-only setups. To reuse an agent, set
`agent` to its name in `agents`. Put `effort` and `client` inside the agent
definition.

To change a role on this machine, set its `agent` in `config.local.yaml`.
Supply the full agent definition or a name; it replaces the shared agent.

## Options

For the client contracts, discovery catalogs, and validation boundaries, see
[Adapters](adpaters.md). The client-specific settings below describe the
existing configuration surface.

Each client names its own options and lists the values for the selected
model. They go in the agent's `client.options`. `migent init` asks for options
marked as prompts. Leaving one unset keeps the client default.

For `agy`, `claude-code`, `grok` and `opencode`, the valid options are the ones
the installed CLI lists in its headless help. A key `autocompact` becomes
`--autocompact`: the key in lowercase snake case, with `_` replaced by `-`.
Numbers and booleans in YAML are accepted and stored as strings. A value of
`true` sends the bare flag, `false` sends nothing, and anything else sends
`--flag value`. `migent doctor`, `migent init` and the agent commands read the
help and report `option-unknown`, `option-value-invalid` and `option-conflict`
(or the warning `option-unverified` when the help cannot be read). Offline,
Migent only refuses the flags it sets itself and non-canonical key spellings.

- Antigravity (`agy`) prompts for `effort` (`low`, `medium`, `high`, `xhigh`, or
  `max`) and sends it as `agy --effort`. `skip_permissions` maps to
  `--dangerously-skip-permissions`; leaving it unset passes that flag for the
  run, and `false` omits it.
- Codex prompts for `model_reasoning_effort`, read from
  `supported_reasoning_levels` in `codex debug models`. Any other option is a
  Codex config override passed as `codex exec -c key=value`.
- Grok prompts for `reasoning-effort`, read from the `grok` CLI for that
  model, and sends it as `--reasoning-effort`. `effort` is refused for Grok:
  use `reasoning-effort`.
- OpenCode's `variant` is rendered as a `#variant` suffix on the model ID for
  OpenCode V2. Only `variant` is overridable and stored on the session. No
  OpenCode option is prompted for.
- Claude Code takes any option its help lists, for example `autocompact: 200000`.
  Migent sets
  `permission_mode=bypassPermissions` when the option is unset, and generates a
  session ID for resume.

Only options the client marks as overridable are part of the session.

## Schema version

`schema_version` on `.migent/config.yaml` and on each workflow file is the
document version; the current version is 7. A missing value is version 0. A command that uses those
files stops while the recorded version is older and tells you to run
`migent migrate`. That command asks before writing. `migent migrate --yes`
writes without asking.

Migration is layer-aware: `config.yaml` and `config.local.yaml` are migrated
against the original merged configuration, and a synthesized client is written
only into the layer that supplied the legacy provider. Locations with neither a
provider nor a client are left unchanged for validation to report.
Documents older than v5 first reach the v5 shape before client equivalence is
checked. Inline role and stage agents keep comments on their retained fields;
the migrated YAML is checked against the intended document before it is written.

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
      model: gpt-5
      effort: high
      client:
        type: codex
```

A stage's `agent` replaces the role's agent entirely: an inline agent inherits
nothing from the role, so restate the client and model even when only the
effort differs. Stages have no `options` of their own in schema version 6.
CLI option overrides apply last.

Migent currently includes clients for the headless `agy`, `claude`, `codex`,
`grok`, and `opencode` CLIs. Those CLIs own authentication, tool use, and agent execution;
Migent owns selection, prompts, routing, and persistence.

## Usage

The shared capture and normalization contract is documented in
[Adapters: Failures and usage](adpaters.md#failures-and-usage).
The table below records client-specific usage behavior.

| Client | What it prints | Tokens | Cost |
| --- | --- | --- | --- |
| claude-code | last `result` event | per process | `total_cost_usd`, cumulative per conversation. This is a client estimate, not a bill. |
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
    model: gpt-5
    effort: high
    client:
      type: codex
```

The alias follows `client.type`: Codex uses `model_reasoning_effort`, Grok uses
`reasoning-effort`, and Claude Code and Antigravity use `effort`. OpenCode V2
uses `variant`, which the client renders as `provider/model#variant` (for
example `openai/gpt-5#high`). Available variants
depend on the selected model. Do not combine effort or `options.variant` with
a model ID that already contains a `#variant` suffix.
Values pass through unchanged and must be supported by the selected client/model.
Omitting `effort` preserves existing behavior. Local effort replaces shared effort.

Use either `effort` or its native option in the agent's `client.options`, never
both (including after shared/local config merge). Unsupported clients, empty
values, and values that are not strings, numbers or booleans are configuration errors. Existing native options
still work. Command-line option overrides apply after the resolved native
option. Sessions freeze the resolved native options.


`migent doctor` checks that the agent's model exists (see
[cli.md](cli.md#model-availability)) and checks model effort against the
selected client's supported values.
Invalid or empty values report the model field and `Valid values`. If the values
cannot be verified, doctor prints a warning instead of rejecting an otherwise
well-formed effort. Empty values and values that are not strings, numbers or booleans remain errors.
