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

A destination is another declared stage or `complete`. Route keys must exactly
match the declared decision values.
When a decision routes to another stage, Migent includes the decision
execution's `response.md` in the destination prompt. On a return to a stage,
the prompt also references that stage's latest artifact when one exists.
Decision stages do not need to declare an artifact to pass feedback.

## Verify commands

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
  `verify_exhausted` and exit code 6. The session stays active and
  `--attempts` is not consumed.
- `migent session continue <session-id>` resumes the same provider conversation with
  the last report and a fresh `max_verify` budget. It keeps the provider, model,
  and options of the exhausted execution. If config changed them, the resume is
  refused with exit code 2. To use a different model, start a new session.
- Put `verify` on the stage that edits code. A stage that both decides and
  edits carries it itself. A stage with `verify` must be on every path to
  `complete`: the completion stage must be that stage or depend on it. Otherwise
  the workflow does not load and `migent doctor` reports it.

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

## Completion outputs

`completion` defines the terminal stage and publishes selected artifacts:

```yaml
completion:
  stage: review-plan
  decision: approved
  outputs:
    - name: plan
      from_stage: plan
      artifact: plan.md
```

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
response. The earlier execution stays blocked. A cancelled session is resumed
on that same execution. `completed` sessions are not resumed.

If the stage declares `decision.values`, a completed response must include one
of them in the `decision` header.

## Complete example

`.migent/workflows/plan.yaml` for a plan that is reviewed and sent back for
revision:

```yaml
schema_version: 1
id: plan
constraints:
  - Do not write implementation code.

stages:
  - id: plan
    role: planner
    depends_on: []
    max_revisions: 3
    instructions:
      - Analyze the task and write an implementation plan.
      - When revising, edit the existing plan.md in place. Do not replace the whole file.
    produces:
      artifact: plan.md

  - id: review-plan
    role: reviewer
    depends_on: [plan]
    instructions:
      - Review the plan for correctness, missing risks, and unnecessary scope.
      - Report every gap of the same kind in one response.
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: plan

completion:
  stage: review-plan
  decision: approved
  outputs:
    - name: plan
      from_stage: plan
      artifact: plan.md
```

`migent init --preset plan` writes the same stages. Its file omits
`constraints` and uses block lists for `depends_on` and `decision.values`.
