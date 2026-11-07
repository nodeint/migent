# Handle workflow results

Read the reported `response:` or `verify:` file for failures. A stopped session
is not necessarily complete; retain its ID when resolving the cause and retrying.

| Exit | Result | Next action |
| --- | --- | --- |
| 0 | Completed, or one stage finished with `--once` | Confirm `completed` before reporting the session complete. |
| 1 | Blocked or incomplete | Resolve the blocker or obtain the user's reply, then continue. |
| 2 | Configuration error | Run `migent doctor --session <id> --json` for the session or `migent doctor --json` for the project; fix and retry. |
| 3 | Stage failed | Read the response, fix the cause, and continue. |
| 4 | Revision limit | Review repeated feedback before continuing another batch. |
| 5 | Dispatch limit | Continue if more stages are appropriate. |
| 6 | Agent stage failed verification | Read the response, fix the cause, and continue. |
| 7 | Verification-only stage failed | Read the verify report, fix the workspace, and continue. |
| 8 | Client quota reached with `--once` or `--stage` | The stage failed on a client quota. Check the reported reset time, then continue. Migent does not wait or retry. |
| 9 | Questions pending | Follow [Answer questions and blockers](session-replies.md). |
| 130 | Cancelled | Ask before resuming; follow [resume behavior](session-resume.md). |

`session continue` reruns a failed stage immediately, including one that failed on quota; it ignores the recorded reset time.
If diagnostics report an outdated schema, run `migent migrate --yes`, then validate again.

## Control execution limits

These flags apply to workflow `session run` and `session continue`:

| Flag | Effect |
| --- | --- |
| `--max-dispatches <n>` | Allow up to this many stage dispatches in this command; default 20. |
| `--unlimited-dispatches` | Remove that ceiling; use only with the user's agreement. |

Review the cause and keep the same session. `session continue <id>` resets
revision counts for a new batch; `--once` advances one stage without resetting.
