# Roles and model configuration

Write commands take `--no-input --json`. The JSON includes the doctor result.

Run `migent provider list --json` to see which provider CLIs are available
and what model ids each supports. Use that output to pick a provider and
model id before using `config model` or `init`.

## Per-machine override

`.migent/config.local.yaml` is an optional, uncommitted file with the same keys
as `config.yaml`. Mappings merge key by key; scalars and lists, such as
`instructions`, replace the value from `config.yaml`. Its `schema_version` is
ignored. Runs, `doctor`, and `config show` read the merged result.
`config model` and `config role` edit `config.yaml` only, never the local file.
`doctor` warns if git tracks the local file.

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

## Model names

Provider options on a model name: `--option KEY=VALUE` to set,
`--clear-option KEY` to remove.

```
migent config model <name> --provider <provider> --model <model-id> --no-input --json
```

## Point roles at an existing model name

The value is a name from `models`, not a provider model id.

```
migent config role <role>... --model-name <name> --no-input --json
```

## Override one role without touching the shared name

```
migent config role <role> --provider <provider> --model <model-id> --no-input --json
```

## Role instructions

`roles.<name>.instructions` is an optional list of strings. A stage prompt
includes it before that stage's instructions. A role run prepends it to the
prompt.
