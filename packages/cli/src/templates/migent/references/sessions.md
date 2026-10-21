# Sessions: uncommon run and resume cases

The everyday commands are in SKILL.md. This file covers the rest.

## Prerequisite session (`--prior`)

If the workflow's `requires` block names a prerequisite workflow and decision,
find the session:

```
migent session list --workflow <workflow-id> --status completed --json
```

Then pass its id with `--prior <session-id>`. `session continue` accepts
`--prior` too.

## Several blocked stages

When more than one stage is blocked, `session continue` needs the stage:

```
migent session continue <session-id> --stage <stage> --reply "<reply>"
```

The other stages stay blocked.

## Cancelled session (exit 130)

Ask the user first. Then `session continue <session-id>` resumes the same
execution: a cut-off provider turn is sent again, and a cut-off verify runs
again.

## Limits

Accepted by workflow `session run` and by `session continue`.

| Flag | Meaning |
| --- | --- |
| `--attempts <n>` | Failed executions allowed for one stage (default 3). On `session continue` it sets a new total, not extra retries. |
| `--max-dispatches <n>` | Stage dispatches allowed in this command (default 20). |
| `--unlimited-dispatches` | Removes the dispatch ceiling. Use only if the user agrees. |

## `--once` and revision counts

`session continue <id>` resets revision counts. `session continue <id> --once`
advances one stage and does not.

## Config changed during a session

A session keeps the workflow, models, and role instructions it started with.
Later edits warn on stderr and do not change it. Run `migent doctor --json`
and tell the user. To adopt the current versions:

```
migent session continue <session-id> --refresh-workflow
migent session run --session <session-id> --workflow <workflow> --refresh-workflow
```

The second form is for starting a prepared session.
