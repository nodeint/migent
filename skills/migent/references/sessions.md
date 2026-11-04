# Additional session controls

For ordinary run, inspect, and continue commands, use [SKILL.md](../SKILL.md).

## Use a prior session as context

Workflows run independently. A completed workflow with `downstream` prints a
`next.json` path and commands you can copy, for example:

```bash
migent session run --workflow implement --prior <plan-session-id>
```

A matching suggestion supplies the task and named artifact mapping. `--task`
overrides the suggested task. Without a matching suggestion, pass `--task`;
all published prior outputs become context under their output names. The prior
session must be completed and its artifacts present. Context is snapshotted
when the target starts; resume keeps that snapshot. No automatic dispatch occurs.

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

Agents write questions to a request file named in their response contract, not in the
response body. If a stage fails with `question_file_invalid`, the file stayed unusable
after one correction turn; the error names the file and the problem. Run
`migent session continue <session-id>` to rerun the stage.

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

`migent doctor --json` checks project config and project workflows, not a
session's own workflow file. That file is validated when starting or refreshing.

### Before the first run

Edit the prepared session's `workflow_path` (`workflow.yaml`), keeping its `id`.
To change one stage's model, set its `model` to a configured model name (see
[schema-workflow.yaml](schema-workflow.yaml)); omit it to use the role default.
Run `migent doctor --json`, then start:

```bash
migent session run --session <session-id>
```

The session freezes current model settings at startup; no refresh flag is needed.
Older prepared sessions use the project workflow path recorded in their manifest.

### After the workflow has started

Once the session stops, edit the workflow at its recorded `workflow_path`
(the session's `workflow.yaml` for newly prepared sessions). Set the stage's
`model` as above, and update its model mapping in project or local config if
needed. Run `migent doctor --json`, then apply the changes and resume:

```bash
migent session continue <session-id> --refresh-workflow
```

Without refresh, the session keeps its frozen workflow, models, and role
instructions. Refresh adopts all current settings, not just the edited stage's
model. Completed or cancelled sessions cannot be refreshed.
