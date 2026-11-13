---
name: planning
description: >
  Organize implementation work into coherent phases for coding, review,
  verification, and progress tracking. Create or revise plans from available
  context without requiring a design document or another skill.
---

# Implementation planning

Divide work sensibly, not as finely as possible. Plan outcomes and boundaries;
leave implementation details to coding.

## Establish context

- Use available context to establish the goal, scope, constraints, and acceptance criteria.
  Ask only for missing information that affects the plan; no input format is required.
- Read relevant repository guidance and inspect responsibilities, dependencies,
  and verification evidence. Follow repository baseline requirements.
- Preserve settled decisions; surface unresolved choices instead of inventing a solution.

## Plan phases

Use the [template](references/template.md), scaled to the work.

- Group tightly coupled changes; separate outcomes that can be meaningfully reviewed
  on their own. Avoid arbitrary size limits or unnecessary fragmentation.
- Order phases by dependency. Leave a coherent, verifiable codebase after each phase,
  including any required intermediate compatibility.
- Give each phase an outcome, scope, boundary rationale, dependencies, completion
  evidence, and review conditions for proceeding. Add outcome-level tasks only if useful.
- Cover every acceptance criterion, documentation need, and final integration check.
- Reference modules or contracts only as needed to clarify scope. Exclude code,
  pseudocode, signatures, file-by-file edits, and test implementations.

## Track and hand off

- Track phase status, actual verification evidence, blockers, and the next action.
  Distinguish baseline results and planned checks from completed verification.
- Revise remaining phases when evidence changes the plan; retain completed outcomes
  and explain material revisions. Surface decisions affecting scope or solution.
- Planning alone does not authorize implementation or create new approval gates.
- Keep the plan in the conversation unless saving is requested. When saving, update
  the owning plan and retain references needed to resume, using repository-relative
  links or supplied artifact snapshots.
