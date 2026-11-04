# Run one role

Read `.migent/config.yaml` and optional `config.local.yaml`. Pass a configured
role and the user's prompt unchanged; no workflow is required:

```bash
migent session run --role <role> --prompt "<prompt>" --json
```

Output: a role result with `session_id` and `outcome_status`; without `--json`,
a table. Exit 0 means complete, 1 incomplete, 2 configuration error, 6 verification
failure, and 130 cancelled. For resume behavior, see
[Resume a session](session-resume.md).

| Flag | Use |
| --- | --- |
| `--file <path>`, `--stdin` | Supply a longer prompt. |
| `--task <label>` | Label a new session; cannot be combined with `--session`. |
| `--session <id>` | Send a new prompt to an earlier role session. Use `session continue` to resume stopped work. |
| `--provider`, `--model` | Override the role for this turn; pass together. |
| `--option KEY=VALUE` | Override a provider option for this turn. |
