---
name: planning
description: Split requirements and design into independently verifiable phases.
---

# Implementation planning

## Steps

1. Read requirements, design decisions, and repository evidence. State goal,
   scope, constraints, exclusions, and acceptance criteria with stable IDs.
   Confirm prerequisites such as branch, base, and design approval.
2. Resolve choices affecting behavior, contracts, architecture, or phase
   boundaries. Keep settled decisions; ask when a required one is missing.
3. Use the fewest phases that preserve meaningful review and verification
   boundaries; aim for one commit per phase. Split only for a concrete risk
   or verification benefit. Independent mergeability alone is insufficient.
   Consider proving shared machinery on a small flow first; state when any
   temporary legacy path is removed.
4. Order phases by dependency, then risk; confirm assumptions before
   dependent work. Each phase leaves the repository coherent and delivers
   its behavior and verification without relying on a later phase.
   When before/after evidence is needed, commit reviewable baselines before
   refactoring; specify comparison commands and normalize only volatile fields.
   Inventory existing coverage first and add tests only for gaps. If a
   baseline contradicts approved inputs, stop for a decision.
5. Use the [plan template](#plan-template). Record each fact once; reference
   approved inputs instead of restating them. Include only needed phase detail.
6. Put rules, enforcement, tests, and usage docs in the phase delivering the
   outcome. Final verification is a gate, not a phase unless it delivers a
   separate outcome.
7. Map every acceptance criterion and design decision to phases and
   verification. Cover each enumerated design case, such as table rows,
   variants, and distinct failure, denial, and cancellation paths.
   Check for missing coverage, incomplete outcomes, and open decisions.
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

<Brief goal and links to approved scope, constraints, and criterion IDs.>

## Current state

<Relevant behavior and constraints from repository evidence.>

## Phases

### P1: <one complete outcome>

- Outcome and scope: <Result, boundaries, and coherent end state.>
- Boundary rationale: <Concrete risk or verification benefit of this boundary.>
- Dependencies and inputs: <Earlier phases, confirmed assumptions,
  decisions, and references this phase needs.>
- Verify: <Runnable commands, expected behavior, and any baseline comparison.>
- Done: <Completion conditions not already covered by Verify; omit if redundant.>

## Final verification

<Cross-phase checks and expected results, stated once.>

## Acceptance coverage

<Criterion ID → phase/check reference; do not repeat verification details.>

## Open decisions

<Choices that block implementation and who must resolve them. None at approval.>

## References

<Required inputs and their purpose, as repository or supplied input paths.>
```
