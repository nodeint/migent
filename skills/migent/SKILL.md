---
name: migent
description: Set up, configure, run, inspect, and resume Migent workflows and role sessions with the migent CLI.
---

# Migent

Migent runs agent workflows and individual roles through a CLI. Each run is a
session with saved progress, decisions, and artifacts that you can inspect or resume.

Work from the project root. Read the reference for the current job before acting;
use `migent <command> --help` for unfamiliar flags.

## Common commands

| When | Command |
| --- | --- |
| Check project setup after configuration edits or diagnose a configuration error | `migent doctor --json` |
| Check a session's edited draft or effective frozen workflow | `migent doctor --session <id> --json` |
| Inspect effective project settings, including local overrides | `migent config --json` |
| Look up a workflow's stages and resolved agents | `migent get workflow <id> --json` |
| Look up roles and agents | `migent get roles --json` / `migent get agents --json` |
| Start a workflow with a one-line task | `migent session run --workflow <workflow> --task "<task>"` |
| Prepare a longer task or customize a workflow for one session | `migent session prepare "<title>" --workflow <workflow>` |
| Start a prepared session after filling its task and validating its draft | `migent session run --session <id>` |
| Run one configured role without a workflow | `migent session run --role <role> --prompt "<prompt>" --json` |
| Find the most recent session when its ID is unknown | `migent session list --latest --json` |
| Check a known session's status, decisions, and outputs | `migent session show <id> --json` |
| Resume stopped work after resolving its blocker or failure | `migent session continue <id>` |
| Change a session's display title (works during a run) | `migent session rename <id> "<title>"` |
| Finish a stopped workflow session the user says is done, without another stage | `migent session complete <id>` |

For preparation steps and status-specific resume behavior, read the matching
reference below. Obtain the user's answers before continuing questions, and
approval before resuming a cancelled session.

## Job references

| Job | Reference |
| --- | --- |
| Initialize a project or update the skill | [setup.md](references/setup.md) |
| Configure models, roles, local overrides, or client options | [config.md](references/config.md), [configuration fields](references/schema-config.yaml) |
| Run or prepare a workflow | [workflow-sessions.md](references/workflow-sessions.md) |
| Run one role or send it a new prompt | [role-sessions.md](references/role-sessions.md) |
| Inspect sessions, usage, or progress | [inspect.md](references/inspect.md) |
| Resume stopped work | [session-resume.md](references/session-resume.md) |
| Handle workflow failures, quotas, or execution limits | [workflow-results.md](references/workflow-results.md) |
| Answer questions or blockers | [session-replies.md](references/session-replies.md) |
| Use prior outputs as context | [session-context.md](references/session-context.md) |
| Validate or change a session workflow | [session-workflow.md](references/session-workflow.md) |
| Write workflow YAML | [workflow fields](references/schema-workflow.yaml) |
