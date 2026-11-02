# Session handoff

Workflows run independently and hand context to each other through `next.json` and `--prior`. For the session directory and resume behavior, see [Sessions](sessions.md).

Workflows run independently. A completed producer with `downstream` publishes
`next.json` under its session directory and prints its path and runnable commands:

```text
next: <absolute-session-directory>/next.json
migent session run --workflow implement --prior <plan-session-id>
```

The JSON contains no hashes and does not freeze target workflows:

```json
{
  "schema_version": 1,
  "source_session_id": "<plan-session-id>",
  "next": [{
    "workflow": "implement",
    "task": "Implement the approved plan.",
    "artifacts": {
      "plan": { "output": "approved_plan", "path": "outputs/plan.md" }
    },
    "argv": ["migent", "session", "run", "--workflow", "implement", "--prior", "<plan-session-id>"]
  }]
}
```

Artifact paths are relative to the source session. `argv` provides shell-independent
arguments; printed commands use PowerShell quoting on Windows and POSIX quoting
elsewhere. No file is written when no suggestions exist. Suggestions are derived
from the source's frozen workflow and published output records; editing `next.json`
does not change the handoff. A write failure warns without changing completion or
exit status; available commands are still printed. Continuing an already completed
session recreates the file and prints suggestions without dispatching any stages.

`--prior` always identifies a completed source session. A suggestion matching the
target workflow supplies the default task and mapped artifacts. Explicit `--task`
overrides the suggestion. If none matches, `--task` is required and all published
outputs become context under their original output names. A standalone run needs
only its own task; no `--prior` or mandatory input declaration is required.

At target start, Migent validates the source and artifacts, snapshots context into
`handoff/`, calculates SHA-256 hashes and records provenance in the manifest and
event log. Every agent stage receives named snapshot paths. Resume uses those
snapshots rather than reading mutable source files. Historical sessions without
handoff records retain their original live context behavior.

`prepare --prior` records the source ID without snapshotting artifacts or freezing
the target workflow. Starting the prepared session uses current workflow/model
settings and binds context. A failed bind leaves it prepared. Its manually written
`task.md` remains the task; suggestions do not overwrite it.
