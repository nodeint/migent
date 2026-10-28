# Additional session controls

For ordinary run, inspect, and continue commands, use [SKILL.md](../SKILL.md).

## Use a prerequisite

When the workflow requires an earlier workflow, find its completed session:

```bash
migent session list --workflow <workflow-id> --status completed --json
```

Pass the chosen ID as `--prior <session-id>` to `session run` or
`session continue`.

## Answer one of several blocked stages

Input: the session ID, blocked stage, and user's answer.

```bash
migent session continue <session-id> --stage <stage> --reply "<reply>"
```

Only the selected stage receives the reply; other stages remain blocked.

## Control execution limits

These flags apply to workflow `session run` and `session continue`:

| Flag | Effect |
| --- | --- |
| `--max-dispatches <n>` | Allow up to this many stage dispatches in this command; default 20. |
| `--unlimited-dispatches` | Remove that ceiling; use only with the user's agreement. |

`session continue <id>` starts another batch and resets revision counts.
Add `--once` to advance one stage without resetting those counts.
Review why a limit was reached before continuing; keep the same session.

## Apply configuration changes to a session

Existing sessions keep their original workflow, models, and role instructions.
Edits alone do not update them. To adopt the current settings, validate with
`migent doctor --json`, then run:

```bash
migent session continue <session-id> --refresh-workflow
```

For a prepared session that has not started:

```bash
migent session run --session <session-id> --workflow <workflow> --refresh-workflow
```
