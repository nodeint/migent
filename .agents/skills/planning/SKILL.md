---
name: planning
description: Organize implementation work into reviewable, independently verifiable phases from available requirements and design decisions.
---

# Implementation planning

Plan outcomes and boundaries; leave implementation details to coding.
Use the [template](references/template.md).

## Establish the basis

- Confirm goal, scope, constraints, and acceptance criteria from available inputs and repository evidence.
- Preserve settled decisions. Resolve choices affecting scope, behavior, contracts, architecture, or phase boundaries before approval; ask the human when needed.
- Follow repository baseline requirements. Distinguish checks run from checks planned and record anything unverified.

## Define phases

- Give each phase one complete outcome, reviewable and verifiable on its own; aim for one commit.
- Split parts that can each merge green and be reviewed without reading the other's implementation. Explain why coupled parts belong together.
- Order by dependency, then risk. Confirm assumptions before phases that rely on them.
- Leave the codebase coherent after every phase. Do not defer a phase's promised behavior or verification to a later phase; later phases may extend completed outcomes.
- Include rules, enforcement, and the documentation needed to use the outcome in the same phase. Reserve only cross-phase integration and overview documentation for the end.
- Make each phase self-contained for its implementer: scope, exclusions, dependencies, relevant decisions and references, runnable verification commands, and measurable expected results.
- Exclude code, pseudocode, signatures, and file-by-file edit instructions.

## Hand off

- Map every acceptance criterion to phases and concrete verification; check that the phases actually provide that coverage.
- Leave no open decisions that block implementation. Planning does not authorize implementation.
- Keep the plan in the conversation unless saving is requested. Retain usable references to required inputs.
- Treat a workflow artifact as a snapshot, not a progress tracker. For a live plan, track actual progress separately and revise remaining phases when evidence changes; explain changes to completed outcomes or settled decisions.
