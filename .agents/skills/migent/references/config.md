# Configure models and roles

Read the project's `config.yaml` and optional `config.local.yaml` before editing.
Use [schema-config.yaml](schema-config.yaml) for configuration fields.

## Choose and validate settings

| Command | Input / purpose | Output / next action |
| --- | --- | --- |
| `migent provider list --json` | Discover providers and model IDs available on this machine | Choose an available provider/model pair. |
| `migent config --json` | Inspect project and local settings together | Effective configuration and model names set locally. |
| `migent doctor --json` | Validate setup after editing YAML | Fix reported errors; missing model mappings include YAML to add. |

## Set up this machine

Keep shared roles and workflows in `.migent/config.yaml`. Put machine-specific
overrides in `.migent/config.local.yaml`; do not commit that file or
reinitialize an existing project.

New projects store model objects directly in each role. To change a role's
provider, model, options, or effort, edit `roles.<role>.default_model`:

```yaml
# .migent/config.yaml (or config.local.yaml for a local override)
roles:
  developer:
    default_model:
      provider: codex
      model: gpt-5
```

For a project using named models, keep its existing names:

```yaml
# .migent/config.local.yaml
models:
  code_generation:
    provider: codex
    model: gpt-5
```

Replace the example name and model ID with the project's name and an available
model. Run doctor and resolve missing mappings before starting a workflow.

The local file accepts the same keys as the shared file. Named models merge
key by key; a local role `default_model` replaces the shared default, so supply
a complete model or an alias. Scalars and lists replace shared values. Omit
`schema_version` from the local file. Delete an unwanted option from both files
if it is set in both.

## Change a role or model

- Change `models.<name>.provider`, `model`, or `options` to update every role
  or stage using that named model. Use the local file for machine-only changes.
- Set `roles.<role>.default_model` to a model object, or a configured model
  name when reusing a named model. New names need a model mapping.
- Use `roles.<role>.instructions` for instructions shared by all work in that
  role. Put provider options inside the inline or named model;
  `roles.<role>.options` is no longer supported.
- Use `snake_case` for model, role, and stage names. Keep provider option keys
  in the provider's spelling. Descriptive model names include
  `code_generation`, `deep_reasoning`, and `critical_review`.

## Thinking effort

Set `roles.<role>.default_model.effort` (or `models.<name>.effort` for a named
model) to a value supported by the chosen client and model,
such as `high`. Omit it to use the client default.

Do not also set the equivalent model option, including in the local file.
With OpenCode V2, choose either `effort` or a model ID with `#variant`.
Doctor reports valid values for invalid effort, or a warning if values cannot
be verified.

## Run one role

Input: a configured role and a prompt. No workflow is required.

```bash
migent session run --role <role> --prompt "<prompt>" --json
```

Output: a role result with `outcome_status`; without `--json`, a table.
Exit 0 means complete, 1 means incomplete, and 130 means cancelled.
For incomplete work, inspect the result and continue the same session;
ask before resuming cancellation. Role instructions are included in the prompt.

| Flag | Use |
| --- | --- |
| `--file <path>`, `--stdin` | Supply a longer prompt. |
| `--task` | Label a new session; cannot be combined with `--session`. |
| `--session <session-id>` | Send a new prompt to an earlier role session. To resume stopped work, use `session continue`. |
| `--provider`, `--model` | Override the role for this turn; pass together. |
| `--option KEY=VALUE` | Override a provider option for this turn. |
