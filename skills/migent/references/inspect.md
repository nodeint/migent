# Inspecting many sessions

For one session use `migent session show <session-id> --json` (SKILL.md).

## List

```
migent session list --workflow <id> --status completed --limit 5 --json
```

- Output is a JSON array. `--latest` gives one object, or `null`; do not
  combine it with `--limit`.
- `--status` is one of `active|prepared|completed|blocked|cancelled|corrupt`.
  A session whose `status.json` does not parse is listed as `corrupt`.
- JSON rows omit the task text.

## Metrics

```
migent session metrics --json
```

- One session prints its `metrics.json`. Several print one object per
  line, newest first. Only a completed session has this file. `--workflow`,
  `--status`, and `--limit` filter those rows.
- Read `usage_missing`, `cost_partial`, and `uncaptured_turns` before comparing totals.
- `stage_attempt` is not a retry count.

## Follow

`session follow` streams the event trace for a person at a terminal. Do not use
it or `--cursor` to coordinate a run.
