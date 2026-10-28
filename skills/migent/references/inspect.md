# Inspect sessions and usage

## Find sessions

```bash
migent session list --workflow <id> --status completed --limit 5 --json
```

Output: a JSON array of matching sessions, without task text.
Use `session show <session-id> --json` for details.

- `--latest` returns one object or `null`; do not combine it with `--limit`.
- Status filters: `active`, `prepared`, `completed`, `blocked`, `cancelled`,
  or `corrupt`. A corrupt session cannot be read normally; report it rather
  than editing generated state.

## Compare usage

```bash
migent session metrics --json
```

Use `--workflow`, `--status`, and `--limit` to select sessions.
Output: metrics for completed sessions; one JSON object per line when there
are several. Check `usage_missing`, `cost_partial`, and `uncaptured_turns`
before comparing totals. Do not interpret `stage_attempt` as a retry count.

## Watch progress

`migent session follow` displays live progress for a person at a
terminal. For agent execution, wait on the running command and inspect its
result; do not use `follow` or `--cursor` to coordinate a run.
