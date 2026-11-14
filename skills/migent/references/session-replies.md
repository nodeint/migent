# Answer questions and blockers

Reply to the waiting question or blocker:

```bash
migent session continue <session-id> --reply "<reply>"
```

When several workflow stages are waiting, add `--stage <stage>` to select one;
other stages remain pending. `session show --json` lists pending questions even
when the session is blocked. Each execution's `questions.json` contains context, options, and
selection mode, and the `input.json` of the execution that received the answers
records them (`executions/<execution-id>/`). Identify questions by execution ID
and question ID.

Present each question's context and `single`/`multiple` selection mode. Number
questions from 1 and letter options A, B, C in recorded order:

| Answer | Example |
| --- | --- |
| Single selection | `1A` |
| Multiple selections, when allowed | `2A+C` |
| Free text, always allowed | `3 explain further` |
| Combined reply | `--reply "1A, 2B, 3 explain further"` |

Numbering restarts per stage batch. `--reply-file` also accepts a JSON object
mapping question numbers to letters, arrays, or free text. Invalid or partial
answers do not resume the agent. Obtain the user's answer; recommendations and
continuing without `--reply` do not answer a question.

For `question_file_invalid`, inspect the reported request file and error, then
rerun with `session continue <id>`.
