# Validate and change a session workflow

Use the matching diagnostic scope:

| Command | Validates |
| --- | --- |
| `migent doctor --json` | Project config and project workflows. |
| `migent doctor --session <id> --json` | The session's effective draft, frozen, or live workflow and required bindings; read-only. |

## Before the first run

Edit the file at `workflow_path`, keeping its `id`. Set stage `model` to a
configured alias, or omit it for the role default; see
[schema-workflow.yaml](schema-workflow.yaml). Follow the
[prepare flow](workflow-sessions.md#prepare-a-longer-task) to validate and start.

Startup freezes the workflow, model targets, and role instructions without a
refresh flag. Prepared sessions use their own `workflow.yaml`; older sessions
may reference a project workflow.

## After the workflow has started

Wait for the session to stop. Edit its recorded `workflow_path` and any required
model mappings in project or local config. Apply the changes and resume:

```bash
migent session continue <session-id> --refresh-workflow
```

Refresh adopts the current workflow, model targets, and role instructions;
otherwise frozen settings remain in use. Completed or cancelled sessions cannot
be refreshed.

`doctor --session` checks frozen settings and reports live drift as warnings.
A passing check does not validate live edits before refresh.
Sessions without a freeze use their live source; role-only sessions have no
workflow for this diagnostic.
