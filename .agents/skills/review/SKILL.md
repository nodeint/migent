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
- Report in the conversation unless another location is required. Omit sections with nothing to report.
- Keep the report short: record results and evidence once, cite earlier reviews by path instead of restating them,
  and list only unmet or unverified requirements.
- Preserve required references and usable snapshot paths; use repository-relative paths for repository files.

### Template

```markdown
# Review

- Verdict: <Approved, changes required, or blocked; use workflow decision values when applicable.>
- Scope: <Task or stage, artifacts or paths, and revision; branch and comparison base for code.>
- Summary: <One or two sentences on why the verdict follows.>

## Findings

### <Finding ID>: <Title>

- Location: <Path, section, symbol, or line.>
- Evidence: <Observed gap and the requirement it violates.>
- Impact: <Consequence and affected cases.>
- Required correction: <Outcome needed to resolve the finding.>

## Notes

- <Optional observations, prior finding status, unverified areas, and next action; not required for approval.>

## Verification

- <Exact command or check>: <Pass, fail, or not run>; <run during review or reported; limitation if any.>

## References

- <Link or path>: <Purpose.>
```
