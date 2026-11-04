# Use a prior session as context

Use `--prior` to start a workflow with context from a completed session:

```bash
migent session run --workflow implement --prior <plan-session-id>
```

`downstream` suggestions in `next.json` supply the task and artifact mapping;
`--task` overrides the suggested task. Without a matching suggestion, pass
`--task`; all published prior outputs become context under their output names.

The prior session must be completed with artifacts present. Context is snapshotted
at startup and retained on resume. Suggestions do not dispatch work.
