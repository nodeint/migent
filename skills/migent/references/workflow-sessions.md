# Run or prepare a workflow

Read `.migent/config.yaml`, optional `config.local.yaml`, and the selected workflow
before running. For a new project, follow [setup.md](setup.md).

Pass the user's task unchanged. Leave reading `task.md` and its referenced
documents to the stage agent; do not edit `task.md` after stages start.

## Run a one-line task

Pass a workflow ID or file path:

```bash
migent session run --workflow <workflow> --task "<task>"
```

## Prepare a longer task

```bash
migent session prepare "<title>" --workflow <workflow>
```

Output: `session_id`, `task_path`, and `workflow_path`. Write the unchanged task
to `task_path`, with supporting files beside it. If needed, read
[workflow fields](schema-workflow.yaml), then edit the file at `workflow_path`,
keeping its `id`. Validate the draft, then start:

```bash
migent doctor --session <session-id> --json
migent session run --session <session-id>
```

Edit the prepared task and workflow source only as described above. Do not edit
generated state such as `manifest.yaml`, `status.json`, `workflow.frozen.yaml`,
`events.jsonl`, or `executions/`. Use [session workflow changes](session-workflow.md)
to adopt later edits.

## Wait for the result

The command runs until the session stops. Add `--once` to dispatch one stage.
If it runs in the background, wait for completion; do not add another watcher.
Do not pass `--verbose` or `--progress`, or use `session follow` to wait.

Progress is printed on stderr, not JSON on stdout. Use the reported `session_id`,
outcome, decision, and diagnostic paths. Only report completion when `completed`
is printed; exit 0 with `--once` may mean just one stage finished. Report each
published `artifact:` path exactly.

For other outcomes, follow [workflow results](workflow-results.md) and
[resume the same session](session-resume.md).
