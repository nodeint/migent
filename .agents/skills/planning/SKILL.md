---
name: planning
description: Split requirements and design into independently verifiable phases.
---

# Implementation planning

## Steps

1. Read requirements, design decisions, and repository evidence. State goal,
   scope, constraints, exclusions, and acceptance criteria with stable IDs.
2. Resolve choices affecting behavior, contracts, architecture, or phase
   boundaries. Keep settled decisions; ask when a required one is missing.
3. Group work into complete outcomes, each independently reviewable and
   verifiable; aim for one commit per phase. Split outcomes that can merge
   green independently; explain why coupled parts stay together.
4. Order phases by dependency, then risk; confirm assumptions before
   dependent work. Each phase leaves the repository coherent and delivers
   its behavior and verification without relying on a later phase.
5. Fill each phase in the [plan template](#plan-template): outcome, scope,
   exclusions, boundary rationale, dependencies, decisions, references,
   runnable verification commands, expected results, and completion criteria.
6. Put rules, enforcement, tests, and usage docs in the phase delivering the
   outcome. Leave only cross-phase integration and overview docs for the end.
7. Map every acceptance criterion to phases and verification. Check for
   missing coverage, incomplete outcomes, and open implementation decisions.
8. Deliver the plan only after blocking decisions are resolved. Exclude code,
   pseudocode, signatures, and file-by-file edit instructions.

## Output

Keep the plan in the conversation unless asked to save it; retain usable
input references. Planning does not authorize implementation.
Treat an approved saved handoff as a snapshot and track live progress
separately. Revise remaining phases when evidence changes; explain changes
to settled outcomes.

## Plan template

Keep applicable sections concise; omit empty sections unless a required
format says otherwise. Repeat the phase block as needed.

```markdown
# Plan: <outcome>

## Goal and scope

<Goal, constraints, exclusions, and acceptance criteria with stable IDs.>

## Current state

<Relevant behavior and constraints from repository evidence.>

## Phases

### P1: <one complete outcome>

- Outcome and scope: <Result, boundaries, and coherent end state.>
- Boundary rationale: <Why one review unit; why coupled parts stay together.>
- Dependencies and inputs: <Earlier phases, confirmed assumptions,
  decisions, and references this phase needs.>
- Verify: <Runnable commands and the behavior each must demonstrate.>
- Done: <Measurable completion and review criteria, incl. rules and docs.>

## Acceptance coverage

<Each criterion → phase(s) → concrete verification; include final integration.>

## Open decisions

<Choices that block implementation and who must resolve them. None at approval.>

## References

<Required inputs and their purpose, as repository or supplied input paths.>
```
