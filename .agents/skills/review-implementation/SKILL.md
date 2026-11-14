---
name: review-implementation
description: Review implementation and verification evidence. Report required fixes or approval. Excludes product, design, and plan review.
---

# Implementation review

Review only the task or plan phase selected by the user.
Do not modify project code or implement fixes while reviewing.

## Review

- Read the supplied report and required references, including approved design and plan inputs.
- Stop if required inputs are missing or inconsistent.
- Establish the scope and Git comparison base from the task, report, and repository evidence.
- Ask if the intended diff is ambiguous. Do not assume all working-tree changes belong to the task.
- Inspect staged, unstaged, and new files against acceptance criteria and approved decisions.
- Flag unrelated work without changing it.
- Check correctness, edge cases, regressions, maintainability, tests, documentation, and references.
- Support design concerns with evidence. Do not block on personal preference.
- Compare verification commands and results with repository and task requirements.
- Separate baseline failures from regressions, and planned checks from completed checks.
- Run relevant checks when evidence is insufficient. Note anything unverified.
- On revision, recheck required findings and look for regressions from the fixes.

## Report

- Use the requested format and location; otherwise report in the conversation.
- Report required fixes together, with locations, evidence, impact, and corrections.
- Separate optional suggestions from required fixes.
- State scope, comparison base, checks or evidence inspected, blockers, and anything unverified.
- Record the reviewed revision or file state when requested.
- Approve only when the implementation is complete, verified, and has no required fixes.
- Approval does not authorize commits, pushes, or pull requests.
