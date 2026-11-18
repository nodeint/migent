---
name: implement
description: Implement and verify a task or plan phase.
---

# Implementation

## Steps

1. Check the branch with `git branch --show-current` and the workspace with
   `git status --short`. Follow repository branch rules and preserve unrelated changes.
2. Read the selected task or phase, required references, and prior review findings.
   Stop and ask if required inputs are missing or inconsistent.
3. State the scope, acceptance criteria, and verification commands. Read the affected
   code and package documentation. Treat issue proposals as unapproved until decided.
4. Follow the approved design and plan. If neither supplies a solution, investigate
   the cause and identify the smallest change. Ask before making consequential
   structural or contract decisions, or changing the agreed scope or solution.
5. Edit only the selected scope. Add or update the tests and documentation needed
   to demonstrate the acceptance criteria. Address required review findings.
6. Run the relevant tests, lint, build, and repository gates for the changed
   scope. For bugfixes, demonstrate the reported failure is fixed. Report failed checks
   and stop according to repository rules; do not weaken verification to pass.
7. Inspect the final diff against the acceptance criteria. Check for unrelated edits,
   missing tests or documentation, and unresolved findings. After revisions, rerun
   affected checks.
8. Report using the Output template.

## Verification selection

- Follow [CONTRIBUTING.md](../../../CONTRIBUTING.md#verify-changes) for scoped commands and required gates.
- Verify selected files and tests actually ran; ignored files and empty selections
  do not count. Report exact commands, coverage, results, and reasons for checks not run.

## Output

- Use the template below; report in the conversation unless another location is requested.
  Include additional fields required by the workflow.
- Keep reports concise and usable without conversation history; write `None` for empty sections.
- Preserve supplied links and usable snapshot paths; use repository-relative paths for repository files.

### Summary template

```markdown
# Implementation summary

## Scope and outcome

- Task or phase: <Identifier and approved input reference.>
- Scope: <Selected behavior, boundaries, and relevant constraints.>
- Outcome: <Complete, partial, or blocked; describe the resulting behavior.>
- Git context: <Branch and base HEAD when required; commit SHA only if committed.>

## Changes

- <Path and relevant symbol or contract>: <What changed and why.>

## Acceptance coverage

| Criterion | Status | Evidence |
| --- | --- | --- |
| <Approved criterion or reference> | <Met, unmet, or unverified> | <Code, test, or observed result> |

## Verification

| Command or check | Result | Evidence or limitation |
| --- | --- | --- |
| <Exact command and working directory if different from repo root> | <Pass, fail, or not run> | <Result, report path, or reason not run> |

## Decisions and deviations

- <Implementation choice and rationale; reference any required approval.>
- <Deviation from approved inputs and its impact, or None.>

## Handoff

- Entry points: <Paths and symbols the next task or phase should start from.>
- Contracts and invariants: <Interfaces, behavior, fixtures, or ordering constraints
  downstream work must preserve; include still-relevant earlier decisions.>
- Assumptions and limits: <What was confirmed, what remains unverified, and risks.>
- Remaining work: <Unfinished selected-scope obligations and blockers, or None;
  distinguish work explicitly assigned to later phases by the approved plan.>
- Next action: <Next approved task or phase and prerequisites, or None.>

## References

- <Required input link or path>: <Purpose and relevant section.>
```
