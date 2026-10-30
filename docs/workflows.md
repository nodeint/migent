# Writing workflows

A workflow is a set of stages connected by dependencies and explicit decision
routes. Definitions live in `.migent/workflows/` as YAML files. The Migent skill
lists every accepted key in `references/schema-workflow.yaml` in the installed Migent skill (`migent skill path` prints the bundled copy).
`id` is optional. When it is omitted, the id is the file name without `.yaml`. When
`id` is set, that value is the workflow name used by `migent session run --workflow`,
`requires`, and sessions. Two files with the same id are an error. A path to
a workflow file also selects that file.

## Naming

Write every key and id in YAML in `snake_case`: workflow ids, stage ids, and model
aliases (`review_plan`, `code_generation`). Roles are a single word (`planner`,
`reviewer`). Provider option keys are the exception; use the spelling the provider
defines, such as `reasoning-effort` for Grok and `model_reasoning_effort` for
Codex. Execution directories join the order, stage id, and attempt with `-` and
`--` (`0003-review_work--attempt-01`), which snake_case ids keep unambiguous.

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

A schema v3 decision stage declares each choice with `when` instructions for
the agent and a `navigate` destination:

```yaml
- id: review_plan
  role: reviewer
  depends_on: [plan]
  decision:
    - approved:
        when: The work meets the task and required checks pass.
        navigate: complete
    - revise:
        when: Required fixes remain. List each fix and its impact.
        navigate: plan
```

A destination is another declared stage, `complete`, or a non-empty list of
stage ids. `complete` is never in a list. Each list entry declares exactly one
unique decision name with a non-empty `when` and a valid `navigate` destination.
Every stage in a destination list is routed by that decision.
The agent chooses one decision using `when` and returns its name in the
`decision` header. Migent validates the name and follows `navigate`; `when` is
natural-language guidance, not an expression evaluated by the engine.
Several decisions can share a destination, such as `approved` and
`approved-with-note` both navigating to `complete`.
When a decision routes to another stage, Migent includes the decision
execution's `response.md` in the destination prompt. On a return to a stage,
the prompt also references that stage's latest artifact when one exists.
Decision stages do not need to declare an artifact to pass feedback.

A route is not an ordering edge. A stage with incoming routers is routed when
every router that completed since this stage last completed lists it on the
chosen decision. A router that depends on the stage (a route back) is ignored
when its decision goes elsewhere. A route back to a completed stage dispatches
it again, and the stages that depend on it run again after it completes,
because their dependency is newer. `depends_on` is the join: a stage that depends on two routed
branches waits until both have completed and both latest decisions list it.
Authors who need a routed stage to wait for its router keep that router in
`depends_on`.

```yaml
decision:
  - approved:
      when: The implementation is ready for testing and documentation.
      navigate: [test, docs]
  - revise:
      when: Required implementation fixes remain.
      navigate: implement
```

Run `migent migrate --yes` to upgrade config and workflow files to schema v3.
Migration converts old `values` and `routes` into decision entries. It preserves
stage instructions and supplies `when: Choose <name> according to the stage
instructions.` Review these placeholders and move your decision criteria into
`when` as appropriate. A v1 workflow first receives the v2 completion/output
migration, then the v3 decision migration. Config files only advance their
version for this step. Running migration again leaves current files unchanged.
Existing sessions keep their frozen workflow and original decision format.

## Conditional stages

A stage in a version 2 or newer workflow can run only when the session changed certain
files. `run_when.changed_paths` is a list of Git path globs. The stage runs when
any changed path matches any glob (OR). Otherwise Migent records a skip and
starts no provider.

```yaml
- id: review_docs
  role: reviewer
  depends_on: [docs]
  run_when:
    changed_paths:
      - "docs/**/*"
      - "**/README.md"
```

Quote every glob. A plain YAML scalar that starts with `*` is an alias, and
`migent doctor` reports that YAML error unchanged. `run_when` needs
`schema_version: 2` or newer, a non-empty list, and no duplicates. Other keys under
`run_when` are rejected.

**Globs.** A pattern is a path relative to the Git repository root, with `/`
separators, matched case-sensitively on every platform. `*` matches zero or
more characters inside one path segment, and `?` matches one. A segment that
is exactly `**` matches zero or more whole segments. Nothing else is special,
and dotfiles get no special rule. The whole path must match.

| Pattern | Matches | Does not match |
| --- | --- | --- |
| `docs/**/*` | `docs/a.md`, `docs/x/y.md`, `docs/.nojekyll` | `docs`, `src/docs/a.md` |
| `**/README.md` | `README.md`, `a/README.md`, `a/b/README.md` | `readme.md`, `README.mdx` |
| `*.md` | `CHANGELOG.md` | `docs/CHANGELOG.md` |
| `src/*` | `src/a.ts` | `src/a/b.ts` |

These are rejected when the workflow loads: `\`, a leading `/`, a trailing `/`
(use `dir/**`), an empty segment, a `.` or `..` segment, `**` inside a longer
segment, `[ ] { }`, and a leading `!`. There are no negative patterns.

When the Migent workspace sits inside a larger repository, paths are still
relative to the repository root. In `packages/app`, write
`packages/app/docs/**/*`. Paths outside the project can match too.

**What counts as a change.** Migent records one baseline per session: the
commit that `HEAD` pointed at just before the session's first stage ran. A
prepared session captures it at its first dispatch, not at `prepare`. The
baseline never moves. Resume, retries, `session continue`, routes back, and
`--refresh-workflow` keep it. When the stage is about to start, Migent compares
the working tree with the baseline commit. The change set holds files changed
by commits made after the baseline, staged and unstaged edits, deletions, and
untracked files that Git does not ignore. A rename counts as both paths. A file
edited and restored to its original content is not a change. Ignored files and
Migent's own `.migent/sessions/` files are never changes.

Accepted limits:

- Changes that existed before the first stage (a dirty start) count.
- Edits by you or by another workflow count, and so do edits made by stages
  that are still running at that moment. There is no file locking.
- A file removed from the index with `git rm --cached` but left on disk counts
  as changed.
- Only the commit of a submodule counts, not files inside it.
- Non-UTF-8 file names are decoded lossily, so only `*` and `**` can match them.

**Git errors are not skips.** No Git work tree, no `git` binary, a baseline
commit that no longer exists, a timeout, or output above 64 MiB stops the
command with exit 2. No execution is written and the session stays `active`.
Fix Git and run `session continue`. A session that started before Migent
recorded baselines cannot evaluate `run_when`; start a new session. A workflow
that uses `run_when` needs a Git commit at the first dispatch. A workflow
without it records a missing baseline and carries on.

**Skip semantics.** A skip is an execution with status `skipped` and
`kind: skip`. It calls no provider, runs no verify, and writes no artifact or
decision. It stores why it was skipped, the baseline commit, the patterns, and
how many paths changed. It counts as one dispatch toward `--max-dispatches`.

- A stage that depends on the skipped stage does not run, and neither does
  anything further downstream. If a stage must always run, do not make it
  depend on a `run_when` stage.
- A skipped stage that declares a `decision` follows no route. Its forward
  route targets are blocked as if the decision had listed none of them. A route
  back to a stage the skipped stage depends on does not start again.
- A skip supersedes the stage's earlier completion. Until the stage completes
  again, dependents do not run on its old artifact, and its old decision routes
  nothing. This reaches the stage's transitive dependents and its forward route
  targets, whose completions from before the skip are treated the same way.
- The stage is evaluated again only after a dependency completes newer than the
  skip, or a router lists it. Resuming a session does not repeat a skip. A
  retry after a failure, and a resumed block, do not evaluate the condition
  again; the visit already matched.

**Restrictions.** `run_when` cannot be combined with `verify` on the same stage.
A stage that the skip can leave without a current completion is part of the
conditional set: the `run_when` stage, every stage that depends on a member, and
every forward route target of a member (a target that is not already in the
member's dependency closure). Routes back are not forward targets. No stage in
the conditional set may have `verify`, and no top-level `outputs` entry may
come from the conditional set, so a skip never bypasses verify and never
leaves an output missing. Migent rejects such a workflow when it loads.

**Example.** `docs` answers `updated` or `no-docs`. `review_docs` runs only
when documentation files changed, and `revise` sends the work back to `docs`.

```yaml
schema_version: 3
id: docs_flow
stages:
  - id: implement
    role: developer
    produces:
      artifact: implementation.md
  - id: docs
    role: developer
    depends_on: [implement]
    decision:
      - updated:
          when: Documentation changes need review.
          navigate: review_docs
      - no-docs:
          when: No documentation changes need review.
          navigate: complete
  - id: review_docs
    role: reviewer
    depends_on: [docs]
    run_when:
      changed_paths:
        - "docs/**/*"
        - "**/README.md"
    decision:
      - approved:
          when: The work meets the task and required checks pass.
          navigate: complete
      - revise:
          when: Required fixes remain. List each fix and its impact.
          navigate: docs
outputs:
  - name: implementation
    from_stage: implement
    artifact: implementation.md
```

`no-docs` means that no documentation change needs review, not merely that the
docs stage made no edits. If `implement` already changed a README and `docs`
adds nothing, `docs` should still answer `updated` so the review runs.

Downgrading Migent in the middle of a session is not supported.

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

A route back to any completed stage, including one several stages upstream, is a
revision of that stage and counts against its `max_revisions`. `session
continue` (without `--once`) writes a `revisions.reset` event before it
dispatches, when a stage can start. The event records each stage's current
completed count as its new baseline. It does not choose or dispatch a stage; it
only lifts the cap.

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

A branch stops when its latest execution is blocked or asks a question, or when verify or
revisions are exhausted, or when a stage fails and continue has not marked
that execution. Other branches keep starting. A provider quota with a reset
time parks that provider until the instant, and other providers may start.
The run ends when nothing is running and nothing can start. The exit code and
`stop_reason` take the first reason in this order: `blocked`, `question`, `verify_failed`,
`verify_exhausted`, `stage_failed`, `revisions_exhausted`. A route to `complete` ends that
branch only. A stage with no dependents and no routes ends its branch. A
skipped `run_when` stage ends its branch too.
Version 1 workflows stay one stage at a time and still complete on the
completion stage.

## Completion outputs

A version 2 workflow publishes top-level `outputs` when the run is quiet:
nothing is running, nothing is ready or waiting on a ready or running stage,
no stage is blocked, waiting for an answer, or exhausted, at least one execution completed, and every
output resolves. Each output is the latest complete artifact of `from_stage`.
A missing artifact exits 2, leaves the session active, and publishes nothing.
`session continue` reruns the producer. An output cannot come from a `run_when`
stage, its dependents, or its forward route targets.

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

The status must be `complete`, `blocked`, or (with `ask: human`) `question`. A blocked stage may include a
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

If the stage declares decisions, a completed response must include one of their
names in the `decision` header. The decision instructions are included on each
turn, including resume, reply, and repair after verification fails.

### Questions and human decisions

For the user interaction guide, CLI examples, and question history, see
[Human-in-the-loop interaction](human-in-the-loop.md).

Enable questions on any stage with a role:

```yaml
- id: plan
  role: planner
  ask: human
```

`ask` selects the recipient. Only `human` is supported today; other values,
including role names, are configuration errors. Omit `ask` to disable questions.
A stage without a role cannot declare it. Use `instructions` to describe when
the agent should ask. The recipient is independent of the question protocol,
so an agent recipient can be added later without introducing another stage.

```text
status: question

{
  "schema_version": 1,
  "questions": [
    {
      "question": "Should the plan support existing sessions?",
      "context": "Existing sessions require migration.",
      "selection": "single",
      "options": [
        { "label": "New sessions only" },
        { "label": "Include existing sessions" }
      ],
      "recommended": ["A"]
    }
  ]
}
```

The response body is a validated JSON document, not a prose list of choices.
Each question requires `question`, `context`, `selection`, and 2 to 26 `options`.
Migent assigns question IDs `1`, `2`, `3`, ... and option IDs `A`, `B`, `C`, ...
by their order. Agents omit IDs; if supplied, IDs must match that order.
Each option requires `label`, with optional `description`.
`single` means exactly one selection; `multiple` means one or more distinct
selections. Optional `recommended` is an array of option IDs, with at most one
entry for single selection. A recommendation is never an answer.

Migent writes the full questions, context, and options to
`.migent/sessions/<session-id>/questions.json`. This file contains all rounds,
including each question's `stage_id`, `execution_id`, `recipient`, `status`
(`pending`, `answered`, or `superseded`), and structured `answer` when answered.
The pair `(execution_id, id)` identifies a question across rounds. Question
numbering restarts at 1 for each stage's new batch. The original
batch is also stored in `executions/<execution-id>/questions.json`. Neither
humans nor programs need to read `response.md` to obtain the questions.
`session show` prints the options and selection mode; `--json` exposes full
pending questions in `questions`. Repair can rebuild both question files.

Use `blocked` for an obstacle the agent cannot resolve (missing resources or
an unrecoverable command error); use `question` to ask for information or a
decision. Commands the agent can repair do not require either outcome.

The execution ends, but the stage stays unfinished. There is no final artifact
requirement, verification, routing, or output publication for a question.
Dependent stages wait; independent branches can continue. `session show`
lists pending questions even when another branch determines the session status.
When no work can run, `blocked` takes priority over `question`. With no blockers,
a session waiting for answers has status `question` and the run exits 9.
For `--once` or `--stage`, a selected execution that asks a question exits 9.
Inspection commands still exit 0 when they successfully read the session.

```bash
migent session continue <session-id> --stage plan --reply "1A, 2B, 3 chưa rõ - giải thích thêm"
```

Use the question number followed by an option letter or free text. Separate
answers with commas or newlines. For multiple selections, use `2A+C`.
Letters are case-insensitive. Duplicate question entries, unknown numbers,
unknown option letters, and too many selections are rejected. Other commas
inside a free-text answer are preserved. If free text contains a comma followed
by what looks like another numbered answer, use the JSON form below.

For one question, a bare letter or `A+C` also works. Programs can still send a
JSON object mapping question numbers to letters, arrays, or text:

```json
{
  "1": "A",
  "2": ["A", "C"],
  "3": "chưa rõ - giải thích thêm"
}
```

Save this as `answers.json` and pass `--reply-file answers.json`, or pass the
JSON through `--reply`. Invalid IDs in selection arrays, repeated IDs, missing answers, and multiple
selections for a single-choice question are rejected before the agent resumes.
Free text is always accepted for every question and replaces its option selection.
In a batch, use a text string as that question's value. No configuration flag is needed.

A reply targets a pending question or a blocked stage regardless of the overall
session status. When multiple stages can receive it, `--stage` is required.
Without a reply, a question stays pending. A reply starts a new execution on the
same provider conversation and carries forward the declared working artifact.
The answer does not automatically choose a workflow decision.

An agent can also ask during a verification repair turn. Asking runs no checks
and consumes no verification failure or revision. Failures already recorded
still count toward `max_verify` after the reply. After repairing, the agent must
report `complete` again, and the full verification list runs before completion.

## Complete example

`review` approves into `test` and `docs` at the same time. `review_test` can
start while `docs` is still running. The session completes when both reviews
approve and nothing else can start.

```yaml
schema_version: 3
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
      - approved:
          when: The work meets the task and required checks pass.
          navigate: [test, docs]
      - revise:
          when: Required fixes remain. List each fix and its impact.
          navigate: implement
  - id: test
    role: developer
    depends_on: [review]
  - id: docs
    role: writer
    depends_on: [review]
  - id: review_test
    role: reviewer
    depends_on: [test]
    decision:
      - approved:
          when: The work meets the task and required checks pass.
          navigate: complete
      - revise:
          when: Required fixes remain. List each fix and its impact.
          navigate: test
  - id: review_docs
    role: reviewer
    depends_on: [docs]
    decision:
      - approved:
          when: The work meets the task and required checks pass.
          navigate: complete
      - revise:
          when: Required fixes remain. List each fix and its impact.
          navigate: docs
outputs:
  - name: implementation
    from_stage: implement
    artifact: implementation.md
```
