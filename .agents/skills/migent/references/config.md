# Roles and model configuration

Migent has no commands that edit config. Edit the YAML files and run
`migent doctor --json`. `migent config` prints the effective (merged) config;
`migent config --json` also lists the model names the local file sets.

Run `migent provider list --json` to see which provider CLIs are available
and what model ids each supports. Use that output to pick a provider and
model id before writing `config.local.yaml` or running `init`.

## Per-machine override

`.migent/config.local.yaml` is an optional, uncommitted file with the same keys
as `config.yaml`. Mappings merge key by key; scalars and lists, such as
`instructions`, replace the value from `config.yaml`. Its `schema_version` is
ignored. Runs, `doctor`, and `config` read the merged result.
`doctor` warns if git tracks the local file.

## Name aliases for the work

Name a model alias for the work it does, not for a provider or a role:
`code_generation`, `deep_reasoning`, `critical_review`, `fast`, `general`,
`long_context`. Then a role keeps its alias when you move to another provider.
Write ids in `snake_case`, as everywhere in Migent YAML (stage ids such as
`review_plan` too). Only provider option keys keep the provider's spelling, such
as `reasoning-effort`.

`migent init` uses `code_generation` for `implement`, and `deep_reasoning` and
`critical_review` for `plan`. Reuse these names; do not add `default`, a provider
name, or a role name as an alias.

## Set up a shared project on a dev machine

Do not reinitialize an existing project's config. Keep role defaults and
workflow choices in the committed `config.yaml`; map its model aliases to the
provider CLIs and model IDs available on each machine in
`.migent/config.local.yaml`.

1. Read `.migent/config.yaml` and note the aliases under `models`.
2. Run `migent provider list --json` and choose available providers and model IDs.
3. Create `.migent/config.local.yaml`. It may contain only aliases that need
   local mappings; matching values override the shared config while other
   shared mappings remain in effect. For example:

   ```yaml
   models:
     code_generation:
       provider: codex
       model: gpt-5
     deep_reasoning:
       provider: claude
       model: opus
   ```

   Replace the example aliases and model IDs with the project's actual names
   and this machine's available values. The file is uncommitted and ignored by
   Git.
4. Run `migent doctor --json` and resolve reported issues before starting a
   workflow. An alias that is still `{}` in the shared config is reported with
   the YAML to add.

## Run one role

Without `--workflow`, `session run` runs a single role:

```
migent session run --role <role> --prompt "<prompt>"
```

| Flag | Meaning |
| --- | --- |
| `--file <path>`, `--stdin` | Supply a long prompt. |
| `--task` | Labels a new role session. Cannot be combined with `--session`. |
| `--session <session-id>` | Sends a new prompt to an earlier role session. `session continue <session-id>` resumes a stopped role session. |
| `--provider`, `--model` | Override the role for this turn. Pass together. |
| `--option KEY=VALUE` | Override a provider option for this turn. |
| `--json` | Print one result object (the role result, with `outcome_status`; not the workflow result). |

Without `--json` it prints a table. Exit 0 means the outcome is complete, 1
not complete. `roles.<role>.instructions`, when set, is prepended to the prompt.

## Change a model

Edit `models.<alias>` in `.migent/config.local.yaml`: `provider`, `model`, and
optional `options`. Every role and stage that uses the alias follows. Delete an
option key to clear it.

## Point a role at another alias

Set `roles.<role>.default_model` in `.migent/config.yaml` to a name from
`models`. It is an alias, not a provider model id. Add the alias to `models` as
`{}` and map it in `.migent/config.local.yaml`.

## Override options for one role

Set `roles.<role>.options` in `.migent/config.yaml`. They merge over the
alias options.

## Role instructions

`roles.<name>.instructions` is an optional list of strings. A stage prompt
includes it before that stage's instructions. A role run prepends it to the
prompt.


## Model effort

Set `models.<alias>.effort` in `config.yaml` or `config.local.yaml` to adjust
thinking level:

```yaml
models:
  code_generation:
    provider: codex
    model: gpt-5
    effort: high
```

Use a non-empty string supported by the selected client/model, such as `low`,
`medium`, or `high`. Omit it to keep the client default. This field is model-only.

Do not also set the equivalent model `options` setting, even across shared and
local config. With OpenCode V2, use either `effort` or a model ID with `#variant`.
Validate changes with `migent doctor --json`; invalid effort reports valid values.
If supported values cannot be verified, doctor reports a warning.
