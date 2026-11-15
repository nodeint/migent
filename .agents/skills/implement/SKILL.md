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
6. Run the relevant tests, lint, typecheck, build, and repository gates for the changed
   scope. For bugfixes, demonstrate the reported failure is fixed. Report failed checks
   and stop according to repository rules; do not weaken verification to pass.
7. Inspect the final diff against the acceptance criteria. Check for unrelated edits,
   missing tests or documentation, and unresolved findings. After revisions, rerun
   affected checks.
8. Report the changes, affected paths, commands and results, deviations, blockers,
   and anything unverified. Distinguish completed checks from checks not run.

## Output

Report in the conversation unless another location is requested. End saved reports
with `References`: required inputs and their purpose, including the issue when available.
Preserve supplied links and input paths; use repository-relative paths for repository
files. Write `None` when there are no references.
