# Additional session controls

For ordinary run, inspect, and continue commands, use [SKILL.md](../SKILL.md).

## Use a prerequisite

When the workflow requires an earlier workflow, find its completed session:

```bash
migent session list --workflow <workflow-id> --status completed --json
```

Pass the chosen ID as `--prior <session-id>` to `session run` or
`session continue`.

## Answer one of several waiting stages

Input: the session ID, stage with a question or blocker, and user's answer.

```bash
migent session continue <session-id> --stage <stage> --reply "<reply>"
```

Only the selected stage receives the reply; other stages keep their questions
or blockers. `session show` lists pending questions even when a blocker determines
the overall status. A question requires the user's answer; continuing without
`--reply` does not answer it. A recommendation is not the user's decision.

Read `.migent/sessions/<session-id>/questions.json` for the full machine-readable
question history, including context, options, selection mode (`single` or
`multiple`), status, and answer. `session show --json` lists pending questions.
The original batch is in `executions/<execution-id>/questions.json`; reading
`response.md` is unnecessary. The pair of execution ID and question ID identifies
each question across rounds.

Questions are numbered from 1 and options lettered A, B, C, ... by order. Reply
with `--reply "1A, 2B, 3 explain further"`; multiple selections use `2A+C`.
Numbering restarts in each stage's new batch. Programs can also pass a JSON
object mapping question numbers to letters, arrays, or free text through
`--reply-file`. Respect the selection mode when
selecting options. Free text is always allowed as a question's value. Invalid or partial
answers do not resume the agent.

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
