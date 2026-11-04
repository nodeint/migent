# Inspect sessions and usage

## Find sessions

```bash
migent session list --workflow <id> --status completed --limit 5 --json
```

Output: a JSON array of matching sessions, without task text.
Use `session show <session-id> --json` for details.

`show` returns status, latest execution, decisions, and outputs. Report the session
ID, title when present, status, stop reason, and relevant decisions and outputs.
Its paths are relative to `.migent/sessions/<session-id>/`.

- `--latest` returns one object or `null`; do not combine it with `--limit`.
- Status filters: `active`, `prepared`, `completed`, `blocked`, `question`, `cancelled`,
  or `corrupt`. A corrupt session cannot be read normally; report it rather
  than editing generated state.

## Compare usage

```bash
migent session metrics --json
```

Use `--workflow`, `--status`, and `--limit` to select sessions.
`--json` is required. A list returns one object per line; no matches print nothing.
For one completed workflow session, use `migent session metrics <id> --json`.
Missing or corrupt metrics produce an error.

Check `totals.usage_missing`, `totals.cost_partial`, and `totals.uncaptured_turns`
before comparing totals. `stage_attempt` counts executions, including revisions,
rather than retries alone.

## Watch progress

`migent session follow` displays live progress for a person at a
terminal. For agent execution, wait on the running command and inspect its
result; do not use `follow` or `--cursor` to coordinate a run.
