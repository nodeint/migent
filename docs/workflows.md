# Writing workflows

A workflow is a set of stages connected by dependencies and explicit decision
routes. Definitions live in `.migent/workflows/` as YAML files. The Migent skill
lists every accepted key in `.agents/skills/migent/references/schema-workflow.yaml`.
`id` is optional. When it is omitted, the id is the file name without `.yaml`. When
`id` is set, that value is the workflow name used by `migent session run --workflow`,
`requires`, and sessions. Two files with the same id are an error. A path to
a workflow file also selects that file.

## Stages and artifacts

`depends_on` makes successful upstream artifacts available to a stage. A stage
may produce one named file artifact:

```yaml
- id: plan
  role: planner
  depends_on: []
  instructions:
    - Write an implementation plan.
  produces:
    artifact: plan.md
```

Workflow-level `constraints`, the role's `instructions` from
`.migent/config.yaml`, and stage `instructions` are included in the provider
prompt on the first execution of a stage. Role instructions come before stage
instructions. A later execution that continues the same stage's provider agent
sends only what changed: upstream artifact paths, a route back to this stage,
or a blocked attempt. It does not repeat the task path, role instructions,
stage instructions, constraints, or verify commands. A `session.resume_from`
visit that continues the named dependency's agent receives the full stage
prompt again. That includes the first visit and any later visit that was not
routed back to this stage.

## Decisions and routes

A decision stage declares every accepted value and its destination:

```yaml
- id: review-plan
  role: reviewer
  depends_on: [plan]
  decision:
    values: [approved, revise]
    routes:
      approved: complete
      revise: plan
```

A destination is another declared stage, `complete`, or a non-empty list of
stage ids. `complete` is never in a list. Route keys must exactly match the
declared decision values. Every stage in a list is routed by that decision.
When a decision routes to another stage, Migent includes the decision
execution's `response.md` in the destination prompt. On a return to a stage,
the prompt also references that stage's latest artifact when one exists.
Decision stages do not need to declare an artifact to pass feedback.

A route is not an ordering edge. A stage with incoming routers is routed when
every router that completed since this stage last completed lists it on the
chosen decision. `depends_on` is the join: a stage that depends on two routed
branches waits until both have completed and both latest decisions list it.
Authors who need a routed stage to wait for its router keep that router in
`depends_on`.

```yaml
routes:
  approved: [test, docs]
  revise: implement
```

## Verify commands

A stage can omit `role` when it declares `verify`. Migent then runs that list and
does not start an agent. `description` is an optional one-line label on any
stage. It is printed on the stage's start line and is not part of the provider
prompt.

```yaml
- id: prepare
  description: Check the tree is green before implementation starts.
  verify:
    - pnpm build
    - pnpm test
  verify_timeout: 1800
  depends_on: []
```

All exits 0 complete the stage and publish `artifacts/verify.md`. The first
non-zero exit, a timeout, or a failure to start the shell fails the stage with
`failure_reason: verify_failed`. Dependents do not start. The session stays
active and the command exits 7. `session continue` runs the list again in a
new execution and does not open a provider. `max_verify` is rejected on a
stage with no role, because there is no model to repair. A stage that has a
role keeps the repair loop below.

A stage that edits code can declare `verify` commands. Migent runs them after
the model reports `status: complete`, in the same execution. The exit codes
decide the result.

```yaml
- id: implement
  role: developer
  verify:
    - pnpm gate
    - pnpm test --filter ./plugins/...
  max_verify: 3        # default 3
  verify_timeout: 900  # seconds for the whole list; default none
```

- Each item is one shell line run as `/bin/sh -c <item>` in the workspace,
  without a login profile. Commands that need `nvm` or similar must set it up
  themselves. Verify supports POSIX shells only.
- Commands run in order. The first failure stops the run and skips the rest.
- On a red run the model receives the report with the tail of the failing
  command and continues in the same provider conversation. The execution stays
  `running` and records no outcome until verify passes.
- A `blocked` response runs no verify command.
- A passing run writes `artifacts/verify.md`. Dependent stages list it in
  their prompt. Do not name a stage artifact `verify.md`.
- After `max_verify` red runs the execution fails with
  `failure_reason: verify_exhausted`. The loop stops with stop reason
  `verify_exhausted` and exit code 6. The session stays active. A verify
  failure does not arm a provider wait.
- `migent session continue <session-id>` resumes the same provider conversation with
  the last report and a fresh `max_verify` budget. It keeps the provider, model,
  and options of the exhausted execution. If config changed them, the resume is
  refused with exit code 2. To use a different model, start a new session.
- Put `verify` on the stage that edits code. A stage that both decides and
  edits carries it itself. A stage with `verify` must sit on every path that
  ends a branch: each route to `complete`, and each stage with no dependents
  and no routes, must be that stage or depend on it. Otherwise the workflow
  does not load and `migent doctor` reports it. Migent does not serialize
  stages that run `verify` at the same time.

## Revision limits

Put `max_revisions` on a stage that a route can revisit:

```yaml
- id: plan
  role: planner
  max_revisions: 3
```

With `max_revisions: 3`, the sequence is:

```text
plan -> review -> revise  # revision 1
plan -> review -> revise  # revision 2
plan -> review -> revise  # revision 3
plan -> review -> revise  # refused; session remains active
```

The review after the third revision still runs. Migent stops only when its
decision would exceed the configured limit. Each later visit continues that
stage's provider agent. A route back's prompt points at the routing stage's
response and the previous artifact. A stage with `session.resume_from`
continues the named stage's agent instead, and that visit receives the full
stage prompt unless a route has returned to this stage.
Run `migent session continue <session-id>` to reset the revision count and allow up
to three more revisions in the same session. Each later `session continue` resets the
count again. `migent session continue <session-id> --once` dispatches one stage and
does not reset the count.

## Concurrency

`concurrency` is a positive integer. Missing means 1. It is frozen with the
workflow. There is no CLI flag.

The scheduler walks ready stages in declaration order. A ready stage whose
dependency closure contains another ready stage waits. A stage does not start
while a running stage is in its dependency closure, or while it is in a
running stage's closure. A running downstream stage is not cancelled. A stage
with `session.resume_from` starts only when nothing else is running, and
nothing starts after it in that turn. A stage that continues its own agent on
a later visit is not under that rule. The walk stops at `concurrency`.

When more stages are ready than `concurrency` allows, declaration order is
the schedule. `--once` dispatches the first stage that walk would start.
`--stage` accepts any ready stage. `session continue` resets revision counts
whenever any stage can start. `session continue --once` does not.

Migent does not serialize stages that edit the same files. That is the
workflow author's concern.

A branch stops when its latest execution is blocked, or when verify or
revisions are exhausted, or when a stage fails and continue has not marked
that execution. Other branches keep starting. A provider quota with a reset
time parks that provider until the instant, and other providers may start.
The run ends when nothing is running and nothing can start. The exit code and
`stop_reason` take the first reason in this order: `blocked`, `verify_failed`,
`verify_exhausted`, `stage_failed`, `revisions_exhausted`. A route to `complete` ends that
branch only. A stage with no dependents and no routes ends its branch.
Version 1 workflows stay one stage at a time and still complete on the
completion stage.

## Completion outputs

A version 2 workflow publishes top-level `outputs` when the run is quiet:
nothing is running, nothing is ready or waiting on a ready or running stage,
no stage is blocked or exhausted, at least one execution completed, and every
output resolves. Each output is the latest complete artifact of `from_stage`.
A missing artifact exits 2, leaves the session active, and publishes nothing.
`session continue` reruns the producer.

```yaml
outputs:
  - name: implementation
    from_stage: implement
    artifact: implementation.md
```

A version 1 workflow still completes when its `completion` stage makes the
configured decision, and still publishes `completion.outputs` then.

`requires` names another workflow. It requires a prior session whose status
is `completed`. It has no decision. A declining decision that must not satisfy
`requires` blocks, or routes to a stage that does not end the branch.

## Stage protocol

A workflow stage begins its final response with a structured outcome:

```text
status: complete
decision: approved

The plan covers the required behavior and tests.
```

The status must be `complete` or `blocked`. A blocked stage may include a
reason:

```text
status: blocked
blocker: The required API schema is missing.
```

`migent session continue <session-id>` runs that stage again after the blocker
is fixed. The new attempt's prompt includes the blocker text and the previous
response. `migent session continue <session-id> --reply "<reply>"` sends that
reply as the new attempt's prompt body and does not repeat the blocker. The
earlier execution stays blocked. A cancelled session is resumed
on that same execution. `completed` sessions are not resumed.

If the stage declares `decision.values`, a completed response must include one
of them in the `decision` header.

## Complete example

`review` approves into `test` and `docs` at the same time. `review-test` can
start while `docs` is still running. The session completes when both reviews
approve and nothing else can start.

```yaml
schema_version: 2
id: implement
concurrency: 2
stages:
  - id: implement
    role: developer
    depends_on: []
    produces:
      artifact: implementation.md
  - id: review
    role: reviewer
    depends_on: [implement]
    decision:
      values: [approved, revise]
      routes:
        approved: [test, docs]
        revise: implement
  - id: test
    role: developer
    depends_on: [review]
  - id: docs
    role: writer
    depends_on: [review]
  - id: review-test
    role: reviewer
    depends_on: [test]
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: test
  - id: review-docs
    role: reviewer
    depends_on: [docs]
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: docs
outputs:
  - name: implementation
    from_stage: implement
    artifact: implementation.md
```
