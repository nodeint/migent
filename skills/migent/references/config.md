# Configure agents and roles

Read `.migent/config.yaml` and optional `.migent/config.local.yaml` before editing.
Read [schema-config.yaml](schema-config.yaml) before editing; use its documented fields.

## Choose and validate settings

| Command | Purpose |
| --- | --- |
| `migent provider list --json` | Discover CLI clients, model IDs, and options available on this machine. |
| `migent config --json` | Inspect the merged project and local configuration. |
| `migent get roles --json` / `migent get agents --json` | Look up roles and agents with resolved targets. |
| `migent doctor --json` | Validate edits; follow diagnostics for invalid settings or missing model mappings. |

## Set up this machine

Keep shared agents and roles in `.migent/config.yaml`, workflows in
`.migent/workflows/`, and machine overrides in `.migent/config.local.yaml`.
Do not commit the local file or reinitialize an existing project.

Set a role's agent with an inline object:

```yaml
# .migent/config.yaml (or config.local.yaml for a local override)
schema_version: 5
roles:
  developer:
    agent:
      provider: codex
      model: gpt-5
```

For shared named agents, preserve the project's existing names:

```yaml
# .migent/config.local.yaml
schema_version: 5
agents:
  code_generation:
    provider: codex
    model: gpt-5
```

Replace example names and model IDs with the project's choices and available
models. Resolve doctor errors before running.

The local file accepts the same keys. Mappings merge recursively, except a role's
`agent`, which replaces the entire selection: supply a complete agent object or
name. Scalars and lists replace shared values. To remove an option, delete it
wherever set in both files. Keep `schema_version: 5` in each file; use
`migent migrate --yes` when diagnostics report an outdated schema.

## Change a role or agent

- Change `agents.<name>.provider`, `model`, or `client` to update every role or
  stage using that named agent. Use the local file for machine-only changes.
- Set `roles.<role>.agent` to an inline object or a configured agent name.
  Set a workflow stage's `agent` to a name, or to a complete inline agent, to
  override that default.
- Use `roles.<role>.responsibilities` for standards shared by all work in that
  role, and `roles.<role>.description` for a one-line summary (not prompted).
  Put native options in the agent's `client.options`;
  `roles.<role>.options` and stage `options` are no longer supported.
- Keep existing agent and role names and the client's spelling for option keys.
  A provider requiring an explicit CLI client, such as BytePlus, also needs
  `client.type`.

Started workflows retain frozen settings. To adopt edits, follow
[session configuration changes](session-workflow.md).

## Thinking effort

Set inline agent `effort` or `agents.<name>.effort` to a value supported by the
client and model, such as `high`; omit it for the client default.

Do not also set the equivalent `client.options` key, including in the local file.
With OpenCode V2, choose either `effort` or a model ID with `#variant`.
Doctor reports valid values for invalid effort, or a warning if values cannot
be verified.

## Client options

Options go in the agent's `client.options` and follow the selected CLI client,
including when a provider uses an explicit `client.type`. Values are non-empty strings; keep the client's key spelling.

| Client | Option keys |
| --- | --- |
| `grok` | `reasoning-effort`, `max_turns`, `tools`, `disallowed_tools`, `permission_mode`, `rules`, `allow`, `deny`, `sandbox` |
| `agy` | `effort`, `mode`, `agent`, `sandbox`, `skip_permissions` |
| `claude-code` | `effort`, `permission_mode`, `tools`, `allowed_tools`, `disallowed_tools`, `max_budget_usd`, `fallback_model`, `append_system_prompt` |
| `codex` | `model_reasoning_effort`; other option keys may contain letters, digits, dots, underscores, and hyphens, starting with a letter. |
| `opencode` | `agent`, `thinking`, `variant` |

Use `migent provider list --json` for available choices and doctor to validate
values. To execute a configured role, see [Run one role](role-sessions.md).
