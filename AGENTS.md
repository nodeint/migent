# Agent Instructions

## Working principles

### Scope and evidence

1. Define the goal, scope, constraints, acceptance criteria, and verification method before planning or implementation.
2. If the request, scope, or goal is unclear, stop and ask the user instead of choosing an interpretation independently.
3. Review the proposed approach against repository evidence;
   surface material weaknesses, assumptions, risks, and trade-offs before proceeding.
4. Before implementation, run tests, lint, typecheck, build, and gate checks relevant to the estimated change scope;
   report any failure and stop so the user can decide whether to continue.

### Implementation discipline

1. Address the root cause with the smallest change that satisfies the acceptance criteria, and avoid opportunistic work.
2. Follow established architecture, ownership, and patterns;
   use an ad hoc workaround only when no better structural option remains and the user approves the trade-off.
3. Preserve unrelated work and user changes, and do not reformat, revert, or overwrite files outside the task scope.
4. Do not create, remove, weaken, or bypass repository rules without the user's explicit approval.

### Blocking and safety

1. When blocked, report the blocker and ask the user how to proceed;
   do not bypass, reinterpret, or work around it independently.
2. Obtain explicit user approval before destructive, irreversible, or externally visible actions.
3. Protect secrets and sensitive data, and access or expose only what the authorized task requires.

### Verification and handoff

1. After implementation, test the changed behavior and run the checks relevant to the actual change scope.
2. Never delete, skip, weaken, or rewrite verification merely to make the implementation pass.
3. Compare final results with the baseline so pre-existing failures remain distinguishable from introduced regressions.
4. Report the changes, commands run, results, unresolved risks, and anything not verified without overstating completion.

## Skills

Skills own task-specific procedures, references, and verification rules.
Before acting, load every skill whose trigger matches the request or intended changes;
a task may require more than one skill.
Read each selected `SKILL.md` completely and follow any narrower references it routes to.
Do not load a skill only because its subject appears incidentally in context.
Explicit user instructions take precedence over skill guidance.

| Skill | Load when |
| :--- | :--- |
| `migent` | Setting up Migent, or configuring, running, inspecting, or resuming its workflows, roles, models, sessions, stages, or outputs |
| [`checkout-issue`](.agents/skills/checkout-issue/SKILL.md) | Reading or starting work on a repository GitHub issue |
| [`create-pr`](.agents/skills/create-pr/SKILL.md) | Committing, pushing, and opening a pull request into `next` |
| [`release`](.agents/skills/release/SKILL.md) | Preparing or publishing an extension release and synchronizing `main` |

## Documentation entry point

For every task, read the [documentation load map](docs/README.md#start-here) before opening any other repository documentation.
Follow every matching route when a task touches multiple areas.
