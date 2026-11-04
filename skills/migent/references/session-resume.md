# Resume a session

Inspect the session before choosing how to continue:

```bash
migent session show <session-id> --json
migent session continue <session-id>
```

Resume the same session after errors or limits; do not create a replacement to
bypass them. Ask before resuming a cancelled session. Do not edit generated
state (`manifest.yaml`, `status.json`, `workflow.frozen.yaml`, `events.jsonl`, or
`executions/`) to make a session resumable.

| Session | Action |
| --- | --- |
| Workflow prepared | Follow [prepare a longer task](workflow-sessions.md#prepare-a-longer-task); use `session run --session <id>`. |
| Question | Obtain the user's answer through [question replies](session-replies.md), then continue with `--reply`. |
| Workflow stopped, including a resolved blocker | Continue; add `--reply "<reply>"` when the user answered a blocker. The reply is the whole prompt body. |
| Workflow, one stage only | Continue with `--once`. |
| Role or workflow stage cancelled | After approval to resume, continue without `--reply` for the interrupted turn, or with `--reply "<text>"` for a new execution in the same conversation. |
| Role active | Continue to resend the last prompt. |
| Role blocked | Continue with `--reply "<reply>"` for the user's answer; without it, the agent is told to continue. |
| Role completed | Leave stopped unless the user supplies a new turn with `--reply`. |
| Corrupt | Report the diagnostic; do not edit generated state to resume. |

For a long reply, use `--reply-file <path>`. Do not use `--once` or `--stage` with
a role session. For workflow exit codes and retry limits, see
[workflow results](workflow-results.md).
