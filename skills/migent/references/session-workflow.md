# Validate and change a session workflow

## Commands

### Check the workflow in use

| Command | Checks |
| --- | --- |
| `migent doctor --json` | Project config and project workflows. |
| `migent doctor --session <id> --json` | The session's effective draft, frozen, or live workflow and required bindings; read-only. |

For a prepared session, `doctor --session` checks its draft. Once the session
has started, it checks the frozen workflow and reports live drift as warnings.
A passing check does not validate edits intended for the next refresh.
Sessions without a freeze use their live source; role-only sessions have no
workflow for this diagnostic.

### Validate, render, or save an edited draft

```bash
migent workflow validate <draft> --session <id> --json
migent workflow render <draft> --session <id> --preserve-comments --json
migent workflow save <draft> --session <id> --base-hash <sha256> --preserve-comments --json
```

`<draft>` is a YAML or JSON input file. To read stdin instead, use `-` and
specify `--format yaml` or `--format json`.

| Operation | Result |
| --- | --- |
| `validate` | Checks the supplied draft against document rules and current config, including before a refresh. |
| `render` | Returns the YAML that would be saved, without writing it. |
| `save` | Validates and replaces the session's editable `workflow.yaml`; returns its new hash. |

These commands require an existing session-owned draft, as created by
`session prepare`. They do not support a session whose `workflow_path` points
to a project workflow. Keep the workflow `id` unchanged. `--session` and
`--target` are mutually exclusive.

For `save`, use the SHA-256 of the current destination file's raw bytes as
`--base-hash`. A stale hash rejects the save; after a successful save, use the
returned hash for the next edit. `--preserve-comments` keeps the destination's
comments and formatting where possible.

Saving changes only the editable draft. It does not start, resume, or refresh
the session. Save requires a prepared or refreshable stopped session and
rejects a held session lock, completed sessions, and cancelled sessions.

### Start or apply changes

```bash
migent session run --session <session-id>
migent session continue <session-id> --refresh-workflow
```

Use `run --session` to start a prepared session. Use
`continue --refresh-workflow` to adopt changes for a started, stopped session
and resume it.

Refresh adopts the current workflow, agent targets, and role responsibilities;
otherwise frozen settings remain in use. Completed or cancelled sessions cannot
be refreshed.
