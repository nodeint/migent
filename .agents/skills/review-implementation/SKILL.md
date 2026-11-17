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
7. Report using the Output template.
8. Approve only when implementation is complete, verified, and has no required fixes.
   Approval does not authorize commits, pushes, or pull requests.

## Output

- Use the template below unless another format is requested; report in the conversation
  unless another location is requested. Include additional fields required by the workflow.
- Keep reports concise and usable without conversation history; write `None` for empty sections.
- Preserve supplied links and usable snapshot paths; use repository-relative paths for repository files.

### Summary template

```markdown
# Implementation review

## Verdict and scope

- Verdict: <Approved, changes required, or blocked; explain the reason.>
- Task or phase: <Identifier and approved input reference.>
- Reviewed scope: <Branch, comparison base, and inspected changes or paths;
  include revision or file state when requested.>

## Acceptance coverage

| Criterion | Status | Evidence |
| --- | --- | --- |
| <Approved criterion or reference> | <Met, unmet, or unverified> | <Inspected code, test, or observed result> |

## Required findings

### <Finding ID>: <Title>

- Location: <Path, symbol, or line.>
- Evidence: <Observed behavior and the requirement it violates.>
- Impact: <Consequence and affected cases.>
- Required correction: <Outcome needed to resolve the finding.>

## Optional suggestions

- <Location, suggested improvement, and benefit; not required for approval.>

## Verification

| Command or check | Source | Result | Evidence or limitation |
| --- | --- | --- | --- |
| <Exact command or check> | <Run during review or reported by implementer> | <Pass, fail, or not run> | <Result, report path, or reason not run> |

## Limits and follow-up

- Blockers and unverified areas: <Missing evidence, review limits, and their impact.>
- Revision findings: <For each prior required finding, resolved or open with evidence.>
- Next action: <Required fixes, missing inputs, or readiness for the next workflow stage.>

## References

- <Required input link or path>: <Purpose and relevant section.>
```
