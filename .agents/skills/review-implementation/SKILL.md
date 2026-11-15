---
name: review-implementation
description: Review implementation and verification; report fixes or approval.
---

# Implementation review

## Steps

1. Read the selected task or phase, implementation report, and required design and
   plan inputs. Stop if required inputs are missing or inconsistent.
2. Establish scope and Git comparison base from the request and repository evidence.
   Check branch and status; ask if the intended diff is ambiguous.
3. Inspect relevant committed, staged, unstaged, and new files. Flag unrelated work
   without changing it. Do not modify project code or implement fixes during review.
4. Compare behavior with acceptance criteria and approved decisions. Check correctness,
   failure paths, regressions, maintainability, tests, docs, and references.
   Support findings with evidence rather than personal preference.
5. Compare reported verification with task and repository requirements. Distinguish
   completed checks from planned checks and known failures from introduced regressions
   where evidence permits. Run relevant checks when evidence is insufficient.
6. For revisions, recheck required findings and inspect the fixes for regressions.
7. Report required fixes together, each with location, evidence, impact, and correction.
   Separate optional suggestions. State scope, comparison base, inspected evidence,
   blockers, and anything unverified; include revision or file state when requested.
8. Approve only when implementation is complete, verified, and has no required fixes.
   Approval does not authorize commits, pushes, or pull requests.

## Output

Use the requested format and location; otherwise report in the conversation.
