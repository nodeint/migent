# Documentation map

Use this map to select the smallest set of documents relevant to a task. Follow
the topic owner below before reading adjacent documents. Implementation details
must be checked against the current source when changing behavior.

## Documents

| Document | Owns | Read when | Search terms |
| --- | --- | --- | --- |
| [CLI](cli.md) | Commands, flags, exit behavior, init, config inspection, draft authoring, migration, skills, doctor, registry service | Running Migent, changing a command, or checking invocation syntax | `session run`, `prepare`, `continue`, `--stage`, `config`, `get`, `doctor`, `workspace` |
| [Workflows](workflows.md) | Workflow YAML, stage protocol, artifacts, decisions, routes, conditions, verification, revision limits, concurrency, outputs | Creating or editing a workflow, changing stage execution semantics | `stages`, `needs`, `run_when`, `verify`, `routes`, `outputs`, `downstream` |
| [Agent configuration](agents.md) | Shared/local agent configuration, role agents, named agents, client options, effort, client-specific settings | Selecting agents or changing configuration resolution | `agent`, `agents`, `responsibilities`, `config.local.yaml`, `client`, `effort` |
| [Adapters](adpaters.md) | Shared adapter architecture, client contracts, command building, discovery, parsing, validation boundaries, failure and usage contracts | Implementing a client or changing headless option discovery | `CliClient`, `CommandSpec`, `parseOptions`, `value_mode`, `normalizeUsage` |
| [Sessions](sessions.md) | Session files, manifests, frozen configuration, execution records, published artifacts, inspect/resume, workflow composition | Understanding persisted state or changing session lifecycle and resume | `manifest.json`, `execution.json`, `status.json`, `workflow.yaml`, `resume_from`, `outputs` |
| [Session handoff](session-handoff.md) | Cross-workflow suggestions, prior context, artifact snapshots, provenance | Connecting completed producer sessions to new workflows | `next.json`, `--prior`, `handoff/`, `downstream`, `SHA-256` |
| [Human interaction](human-in-the-loop.md) | Agent questions, user replies, blockers, question history, resume and verification | Adding human input or diagnosing a session waiting for an answer | `questions`, `--reply`, `single`, `multiple`, `blocked` |
| [Session metrics](session-metrics.md) | Metrics JSON, aggregation, timing, usage completeness, cost, revisions | Reading metrics or changing totals and accounting | `metrics.json`, `usage_missing`, `cost_partial`, `uncaptured_turns`, `wall_seconds` |
| [Diagnostics](diagnostics.md) | Process startup, wrapper failures, diagnostic artifacts, debug traces, troubleshooting | Investigating failed launches, permissions, timeouts, or client exits | `diagnostics.json`, `failure.md`, `stderr_tail`, `MIGENT_DEBUG`, `EACCES`, `ENOEXEC` |
| [Backlog](backlogs.md) | Dated proposals and priorities for long refactor workflows | Evaluating planned work or historical motivation | `P0`, `P1`, `P2`, `budget`, `scope`, `for_each`, `hooks` |

## Task lookup

| Task or symptom | Read first | Then read if needed |
| --- | --- | --- |
| Start, prepare, continue, cancel, or inspect a session | [CLI: Session commands](cli.md#session-commands) | [Sessions](sessions.md) |
| Change workflow stages, routing, verification, or concurrency | [Workflows](workflows.md) | [Sessions](sessions.md) |
| Configure a role, agent, client, or effort | [Agent configuration](agents.md) | [CLI: Init](cli.md#init), [CLI: Config](cli.md#config) |
| Find model IDs, options, or effort values on this machine | [CLI: Get](cli.md#get) | [Adapters: Listing and JSON output](adpaters.md#listing-and-json-output) |
| Implement or extend an adapter | [Adapters](adpaters.md) | [Agent configuration](agents.md), [Diagnostics](diagnostics.md) |
| Parse CLI help or inspect native option JSON | [Adapters: Headless option discovery](adpaters.md#headless-option-discovery) | [Adapters: Listing and JSON output](adpaters.md#listing-and-json-output) |
| Validate option configuration or change option precedence | [Adapters: Configuration and validation](adpaters.md#configuration-and-validation) | [Agent configuration: Options](agents.md#options) |
| Diagnose unavailable models or CLIs | [CLI: Doctor](cli.md#doctor) | [Adapters: Model and version discovery](adpaters.md#model-and-version-discovery), [Diagnostics](diagnostics.md) |
| Explain frozen settings or resumed conversations | [Sessions](sessions.md) | [Adapters: Sessions and interruption](adpaters.md#sessions-and-interruption) |
| Pass artifacts between independent workflows | [Session handoff](session-handoff.md) | [Workflows: Downstream handoff](workflows.md#downstream-handoff) |
| Answer an agent question or unblock a run | [Human interaction](human-in-the-loop.md) | [CLI: Session commands](cli.md#session-commands) |
| Diagnose missing tokens, partial costs, or cumulative usage | [Session metrics](session-metrics.md) | [Adapters: Failures and usage](adpaters.md#failures-and-usage) |
| Investigate a failed process start or client exit | [Diagnostics](diagnostics.md) | [Adapters: Failures and usage](adpaters.md#failures-and-usage) |
| Validate, render, or save draft configuration/workflows | [CLI: Authoring drafts](cli.md#authoring-drafts) | [Agent configuration](agents.md), [Workflows](workflows.md) |
| Find proposals rather than implemented behavior | [Backlog](backlogs.md) | Verify current source before relying on a proposal |

## Reading and maintenance rules

| Rule | Application |
| --- | --- |
| Keep one topic owner | Put adapter contracts in `adpaters.md`, command syntax in `cli.md`, and session persistence in `sessions.md`; link instead of duplicating explanations. |
| Separate current behavior from proposals | `backlogs.md` is a dated proposal, not a specification of available features. Explicit limitations in implementation docs describe current boundaries. |
| Distinguish native discovery from accepted configuration | A discovered headless option does not automatically become a supported model option; consult the adapter validation section. |
| Preserve existing paths | The adapter document is named `adpaters.md`; use that exact filename in links. |
| Update this map with documentation changes | Add or revise a row when a document is added, renamed, or takes ownership of a topic. |

For installation and the product overview, see the [root README](../README.md).
For repository setup, package structure, development checks, and release work,
see [Contributing](../CONTRIBUTING.md).
