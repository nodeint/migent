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
     fast:
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
