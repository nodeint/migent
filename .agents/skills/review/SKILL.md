---
name: review
description: Review work against task requirements, workflow rules, and applicable skills; report findings and a verdict.
---

# Review

## Rules

- Follow the task, workflow constraints, stage instructions, decision criteria, and applicable skills and templates.
- Read required inputs and references. Stop and ask about missing or inconsistent requirements or evidence.
- Establish the reviewed scope and revision; for code, identify the branch, comparison base, and relevant file states.
- Review at the level required by the stage. Do not impose requirements from another stage or expand the approved scope.
- Check acceptance coverage, correctness, completeness, and consistency against repository evidence and approved decisions.
- Do not modify the work under review or implement fixes. Write only requested review artifacts.
- Report all substantive findings together, with location, evidence, impact, and the required correction.
- Separate required corrections from optional observations. Do not block on personal preference.
- Check required verification evidence; run relevant checks when evidence is insufficient and execution is applicable.
- Distinguish checks run during review from reported results; disclose failures and unverified areas.
- Recheck prior findings and affected behavior after revisions.
- Approve only when applicable requirements are met, required evidence is sufficient, and no required corrections remain.
- Review approval does not authorize commits, pushes, merges, or publication.

## Report

- Use the template below unless another format is required. Include workflow-required fields and decision values.
- Report in the conversation unless another location is required. Write `None` for empty sections.
- Preserve required references and usable snapshot paths; use repository-relative paths for repository files.

### Template

```markdown
# Review

## Verdict and scope

- Verdict: <Approved, changes required, or blocked; use workflow decision values when applicable.>
- Task or stage: <Identifier and required input reference.>
- Reviewed scope: <Artifacts or paths and revision; branch and comparison base for code.>

## Acceptance coverage

| Requirement or criterion | Status | Evidence |
| --- | --- | --- |
| <Requirement or reference> | <Met, unmet, or unverified> | <Inspected content or observed result> |

## Required findings

### <Finding ID>: <Title>

- Location: <Path, section, symbol, or line.>
- Evidence: <Observed gap and the requirement it violates.>
- Impact: <Consequence and affected cases.>
- Required correction: <Outcome needed to resolve the finding.>

## Optional observations

- <Location, observation, and benefit; not required for approval.>

## Verification

| Command or check | Source | Result | Evidence or limitation |
| --- | --- | --- | --- |
| <Exact command or check> | <Run during review or reported> | <Pass, fail, or not run> | <Evidence or reason> |

## Limits and follow-up

- Blockers and unverified areas: <Missing inputs, evidence, or review limits and their impact.>
- Revision findings: <Prior finding IDs, resolved or open, with evidence.>
- Next action: <Required corrections, missing inputs, or readiness for the next stage.>

## References

- <Link or path>: <Purpose and relevant section.>
```
