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
execution. A cancelled role execution sends a cut-off provider turn again, or
reruns verify when the reply was already saved. A cancelled stage with no
role reruns its verify list in place and does not open a provider.

## Limits

Accepted by workflow `session run` and by `session continue`.

| Flag | Meaning |
| --- | --- |
| `--max-dispatches <n>` | Stage dispatches allowed in this command (default 20). |
| `--unlimited-dispatches` | Removes the dispatch ceiling. Use only if the user agrees. |

A failed stage stays stopped until `session continue`. That command runs the
stage and does not sleep until an old `retry_at`. Exit 3 is `stage_failed`.
Exit 8 is `quota` for `--once` and `--stage`, which do not wait. Exit 130
during a wait disarms the timer. A single role result uses 0, 1, and 130.
Exit 6 remains only the path that reopened more than one role execution.

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
