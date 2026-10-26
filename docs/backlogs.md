# Migent backlog for long multi-wave refactors

Status: proposal, 2026-10-17.
Source version: Migent 0.1.4, read from `/Users/nguyentung/Dev/migent`.

## Purpose

This file lists the Migent features needed to run a long, multi-wave refactor with an agent as the main operator.
Each item states the problem, the evidence, why it matters, the proposal, and the workaround without it.
Use it to decide what to build and in which order.

## Driving case

- The driving case is [the plugin API roadmap](plans/plugin-api/roadmap.md): eight waves, from W0 to W7.
- Each wave needs a `plan` session and an implementation session, so the roadmap needs about 15 to 20 sessions.
- Between sessions the operator must branch, verify, commit, take owner decisions, and update the wave log.
- Wave 5 is a big-bang migration across 12 plugins and about 216 SDK symbols.
- The current workflows are `.migent/workflows/plan.yaml` and `.migent/workflows/implement.yaml`.

## Priority levels

| Level | Meaning |
| :--- | :--- |
| P0 | Required. Without it the operator cannot trust a session result, so every session needs a full manual re-check. |
| P1 | Strongly needed. Without it sessions run, but the operator must watch them closely and repair failures by hand. |
| P2 | Useful. The operator can do this outside Migent with a script at modest cost. |

## Summary

| # | Requirement | Level | Main risk it removes |
| :--- | :--- | :--- | :--- |
| 1 | Command stages with exit-code routing | P0 | An `approved` decision with red checks |
| 2 | Git branch, worktree, diff, and commit per session | P0 | Dirty trees, lost work, and blind reviews |
| 3 | Human decision stages | P0 | Owner decisions taken by an agent or skipped |
| 4 | Change scope guards and command deny lists | P0 | Edits outside the wave and destructive git commands |
| 5 | Stage timeouts and session budgets | P1 | Hung sessions and unbounded spend |
| 6 | Structured, evidence-checked reviews | P1 | Reviews that claim checks they never ran |
| 7 | `for_each` stages over a list | P1 | One agent turn trying to migrate 12 plugins |
| 8 | Multi-session pipelines | P2 | Manual chaining of 15 to 20 sessions |
| 9 | Task files and variables | P2 | Long, error-prone `--task` strings |
| 10 | Completion hooks for external progress logs | P2 | A wave log that drifts from session results |

## P0 requirements

### 1. Command stages with exit-code routing

**Problem.**

- A workflow stage must name a role, and every role is a model.
- The schema accepts `role`, `model`, `options`, `depends_on`, `decision`, `produces`, `max_revisions`, and `session.resume_from`.
- No stage can run a shell command such as `pnpm gate`.
- A decision is the header the agent writes in its own response (`packages/kernel/src/runtime.ts:43`).

**Why it is needed.**

- Every wave in the roadmap has exit criteria that a command can check: `pnpm gate`, unit tests, typecheck, and lint.
- Today a reviewer can write `decision: approved` while the gate is red, and Migent completes the session.
- The operator must then re-run every check by hand, so a passed session proves nothing.
- A deterministic check is the only thing that makes the review loop safe to leave unattended.

**Proposal.** Implemented as `verify` on a role stage instead of a command stage. See "Verify commands" in `docs/workflows.md`.

**Acceptance.**

- A red verify command sends its log to the same stage as a repair turn, up to `max_verify` (see "Verify commands" in `docs/workflows.md`).
- A stage with `verify` must be on every path to `complete`, and a decision is not published until verify passes.

**Workaround without it.** The operator runs the checks after each session and starts a new session on failure.

### 2. Git branch, worktree, diff, and commit per session

**Problem.**

- Agents run in the current working directory with no isolation.
- Grok runs with `--cwd <workspace> --always-approve` (`packages/adapters/src/grok-adapter.ts:291-295`).
- Migent records no base commit, creates no branch, makes no commit, and cannot roll back an attempt.
- The prompt passes artifact paths only (`packages/kernel/src/prompt.ts`), so the reviewer receives no diff.
- File locks cover session records, not the workspace.

**Why it is needed.**

- Each wave must start from the green, committed state of the wave before it.
- A failed revise loop leaves a dirty tree, and the next wave then builds on broken code.
- The roadmap allows W1 to run in parallel with W2, and two sessions on one tree overwrite each other.
- A reviewer that must discover changes with its own `git diff` can miss files, and nothing records what it saw.
- Wave 5 touches about 12 plugins, so a complete diff in front of the reviewer matters most there.

**Proposal.**

```yaml
git:
  branch: plugin-api/{wave}
  worktree: true
  commit_on: approved
```

- At start, Migent records the base commit and creates the branch, or a worktree when `worktree: true`.
- After each stage that changes files, Migent writes `diff.patch` from the base commit as an execution artifact.
- Reviewer prompts reference the latest `diff.patch` and the list of changed files.
- With `commit_on`, Migent commits after the named decision, with the session id in the message.
- `migent rollback <session> --to <execution-id>` restores the tree to the state after that execution.
- A workspace lock refuses a second session that targets the same tree.

**Acceptance.**

- Two sessions with `worktree: true` run at the same time without touching each other's files.
- Every reviewer prompt names a diff artifact that matches `git diff <base>` at that moment.

**Workaround without it.**

- The operator creates branches and worktrees by hand, then commits after verification.
- The operator also instructs reviewers in the task text to run `git diff`.

### 3. Human decision stages

**Problem.**

- A stage can only end as `complete` or `blocked`, and only an agent produces outcomes.
- There is no stage that waits for a person.

**Why it is needed.**

- Each wave section in the roadmap lists decisions the wave plan must make.
- Some decisions belong to the owner, not to the planner or the reviewer.
- Examples are the final field list in W2, the permission tiers in W4, and the commit split in W0.
- Today the operator must stop after `plan`, ask the owner, and start a separate session for implementation.
- The owner's answer is then lost unless the operator copies it into the next `--task`.
- `blocked` is the wrong signal here, because it means the agent failed, not that it is waiting.

**Proposal.**

```yaml
- id: owner_approve
  await: human
  depends_on: [review_plan]
  decision:
    values: [approved, revise]
    routes:
      approved: implement
      revise: plan
```

- The session stops with status `awaiting_input` and a distinct exit code.
- `migent decide <session> <value> --note "<text>"` records the decision and resumes the session.
- The note is stored like a `response.md` and is referenced in the destination stage prompt.

**Acceptance.**

- `migent session list --json` lists sessions waiting for input apart from blocked sessions.
- A `revise` note from the owner reaches the planner prompt word for word.

**Workaround without it.** The operator splits each wave into two sessions and copies the owner's answer by hand.

### 4. Change scope guards and command deny lists

**Problem.**

- Nothing checks which files a stage changed.
- Provider permission options differ by adapter, and the Grok default approves every tool call.

**Why it is needed.**

- The roadmap invariants forbid some changes in some waves.
- For example, W2 must not change the public API, and W3a must log without enforcing.
- An agent that "helpfully" edits outside its wave breaks the order of the roadmap.
- That kind of damage is hard to see in review, because the diff looks reasonable on its own.
- A destructive command such as `git reset --hard`, `git checkout .`, or `git clean` can erase other uncommitted work.
- The W0 working tree held exactly that kind of uncommitted work.

**Proposal.**

```yaml
scope:
  allow: [plugins/**, packages/framework/plugin/**]
  deny: [packages/sdk/**]
deny_commands:
  - git reset
  - git checkout
  - git clean
  - git push
```

- After each stage, Migent compares changed paths with `scope` and routes to `revise` with the offending paths.
- `deny_commands` is a workflow-level rule that Migent maps to each adapter's own permission flags.
- When an adapter cannot enforce a rule, `migent doctor` reports it.

**Acceptance.**

- A stage that edits a denied path cannot complete, and the next prompt names that path.
- `doctor` fails when a provider in use cannot enforce `deny_commands` and the workflow requires it.

**Workaround without it.**

- The operator lists the forbidden paths and commands in `constraints` and hopes the agent obeys.
- The operator also checks `git diff --name-only` by hand after each session.

## P1 requirements

### 5. Stage timeouts and session budgets

**Problem.**

- `DEFAULT_TIMEOUT_SEC` is `null` (`packages/kernel/src/command-executor.ts:10`).
- The only brake is `--max-dispatches`, 20 by default. A failed stage stays stopped until `session continue`.
- Neither current workflow sets `max_revisions`.

**Why it is needed.**

- A stuck provider process hangs the session forever, and an unattended run never reports it.
- A plan and review loop with no `max_revisions` can spend all 20 dispatches on one disagreement.
- Wave 5 sessions are long and expensive, so the owner needs a hard ceiling before starting them.

**Proposal.**

- Add `timeout` to stages, with a workflow default.
- Add idle detection that stops a stage after N minutes without provider events.
- Add a session `budget` in tokens or cost, where the adapter can report usage.
- A spent timeout or budget stops the session with `stop_reason: timeout` or `budget_exhausted`, and the session stays resumable.

**Workaround without it.** The operator watches sessions with `--follow` and kills them by hand.

### 6. Structured, evidence-checked reviews

**Problem.**

- A review is free prose plus a decision header.
- In the current configuration the developer and the reviewer are both `grok-4.7`.

**Why it is needed.**

- A free-text review can say "gate passes" without running it.
- When the reviewer shares a model family with the developer, it tends to share the same blind spots.
- Migent already parses provider stream events, so it can see whether a command really ran.

**Proposal.**

- An optional `findings` schema for decision stages has `severity`, `file`, `line`, and `summary`.
- A rule such as `revise_if: severity == blocker` derives the decision from the findings.
- `require_evidence: [pnpm gate]` rejects an `approved` decision when no matching tool call appears in the stage events.
- `migent doctor` warns when a reviewer role uses the same model as the role it reviews.

**Workaround without it.**

- The operator assigns a different model to the reviewer.
- The operator asks in `instructions` for the commands run and their exit codes, then checks them by hand.

### 7. `for_each` stages over a list

**Problem.** One implementation stage is one provider agent run, which has context and turn limits.

**Why it is needed.**

- Wave 5 migrates 12 plugins in one big-bang change.
- One agent run is unlikely to finish it without losing context or hitting `max_turns`.
- Splitting it into four sessions by hand leaves the tree red between sessions.
- A red tree means the per-session reviews cannot use "gate is green" as a criterion.

**Proposal.**

```yaml
- id: migrate
  role: developer
  for_each: [markdown, theme, wallhaven, prompt, settings, workbench]
  instructions:
    - Migrate plugin {item} to the nodeint API.
```

- Each item runs as its own execution with a fresh provider context on the same branch.
- With requirement 2, each item is committed on its own.
- A short summary of earlier items is passed to later ones.
- A per-item `run` check, from requirement 1, can be scoped to that package while the full gate runs once at the end.

**Workaround without it.** The operator runs one session per group of plugins and re-states earlier progress in each task.

## P2 requirements

### 8. Multi-session pipelines

**Problem.**

- `requires` names one prerequisite workflow and decision (`packages/kernel/src/workflow.ts:36`).
- Nothing chains sessions or runs them in parallel.

**Why it is needed.**

- The roadmap is a graph: W0, then W1 in parallel with W2, then W3 to W6, with W7 after W5.
- Chaining 15 to 20 sessions by hand is slow, and it is easy to start one from the wrong prior.

**Proposal.**

- A `pipeline.yaml` lists nodes, each with a workflow, a task file, dependencies, and a parallel flag.
- `migent run <pipeline>` starts each node once its dependencies complete.
- `requires` accepts several priors.

**Why this is P2.** An operator agent can drive the graph with a short script once requirements 1 to 3 exist.

### 9. Task files and variables

**Problem.** `--task` takes one string, and the roadmap task template is long.

**Proposal.**

- Add `--task-file <path>` and `--var key=value`.
- Make variables such as `{wave}` usable in task text, branch names, scope globs, and output names.

**Why this is P2.** Shell quoting is a nuisance, not a blocker.

### 10. Completion hooks for external progress logs

**Problem.** Session results stay under `.migent/sessions/`, so the wave log in the roadmap is updated by hand.

**Proposal.**

- Add an `on_complete` hook that runs a command with the session snapshot path.
- Alternatively, add an output target that appends a summary line to a named file.

**Why this is P2.** The operator can update the log in the same step as the commit.

## Recommended build order

1. Build requirement 1 first, because every later safety feature reuses its execution and routing.
2. Build requirement 2 next, because diffs, rollback, and parallel waves all depend on a known base commit.
3. Build requirements 3 and 4, which close the remaining paths for unreviewed changes and owner decisions.
4. Build requirements 5 to 7 before Wave 5 starts.
5. Build requirements 8 to 10 when the manual operator loop becomes the bottleneck.

## Minimum set for this roadmap

- With requirements 1, 2, and 3, the operator can run each wave and trust its result without a full manual re-check.
- Without them, Migent remains useful for the plan and review loop.
- Every wave then needs manual branching, verification, and commits.
