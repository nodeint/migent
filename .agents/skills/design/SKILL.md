---
name: design
description: Resolve behavior, contract, ownership, and architecture choices.
---

# Solution design

## Steps

1. Read the request, requirements, and prior decisions. Establish the goal,
   scope, constraints, and acceptance criteria. Ask about ambiguity affecting
   scope or behavior before proceeding with dependent work.
2. Pick the primary work type per repository rules and use its guide below.
   Ask if unclear classification changes the approach; use the general steps
   for work outside these four types.
3. Read affected package docs and code. Trace the relevant behavior and
   identify owners, contracts, dependencies, consumers, and tests. Ground
   observations in paths and symbols; separate facts from hypotheses.
4. Identify the choices needed to meet the acceptance criteria. Reuse settled
   decisions and authorization. If no consequential choice remains, explain
   why no design is needed. Surface independently shippable work separately.
5. Discuss unresolved choices with the user when a decision or approval is
   needed. Present evidence, material trade-offs, and a recommendation, with
   alternatives when useful. Obtain required answers before choosing the
   solution or working out details that depend on them.
6. Work out the solution within existing ownership and patterns: inputs,
   state changes, outputs, failure paths, boundaries, and contracts. Mark new
   paths and justify departures. Include transition ordering and recovery
   when needed. Resolve new consequential choices with the user as they arise.
7. Map acceptance criteria and preserved behavior to verification evidence.
   Resolve material risks through mitigation or explicit acceptance.
8. Write the design using the applicable sections of the
   [design template](#design-template), recording resolved decisions and
   distinguishing facts from assumptions. Leave file-by-file edits and
   execution tasks to implementation planning. Specify implementation or
   test mechanics only when needed for correctness or a material trade-off.

## Type guides

### Feature

Add observable behavior.

Investigate:

- Identify users and the missing observable capability.
- Find existing patterns, domain owners, and affected boundaries.

Design:

- State non-goals and observable acceptance criteria.
- Define relevant inputs, outputs, states, errors, permissions, and persistence.
- Resolve product decisions with required user input; do not invent policy.
- Cover compatibility, flags, telemetry, rollout, and recovery when relevant.

### Bugfix

Restore an expectation.

Investigate:

- Ground the expectation in a contract, invariant, or documented
  prior behavior.
- Trace the first violated invariant; separate causes from hypotheses.
- Check related paths for the same faulty assumption.

Design:

- State expected versus actual behavior, impact, and reproduction.
- Explain the failing path, root cause, and verification gap.
- Restore the invariant; limit scope to the fix and necessary support.
- Require a regression test demonstrating the corrected behavior.
  If impractical, explain why and provide alternative evidence.
- Cover state repair, monitoring, and recovery when relevant.

### Refactor

Preserve behavior while changing structure.

Investigate:

- Map owners, exports, actual consumers, and placement rules.
- Identify consumer compatibility needs and preserved behavior.
- Check existing patterns and evidence protecting that behavior.

Design:

- Describe current and target ownership, dependencies, and public surface.
- State non-goals and preserved behavior.
- Identify verification gaps and required evidence.
- Define intermediate states when the change cannot land at once.
- Identify obsolete surfaces and temporary paths to remove.
- Verify target structure and preserved behavior.

### Migration

Staged compatibility or data transition.

Investigate:

- Map current and target contracts, data, and sources of truth.
- Inventory producers, consumers, stored data, and deployments.
- Identify compatibility needs, deployment limits, and irreversible boundaries.
- Find tests and operational signals proving transition safety.

Design:

- State irreversible boundaries and measurable completion signals.
- Define phases: changes, source of truth, entry/exit criteria,
  stop conditions, and rollback.
- Define reads, writes, version skew, retries, and partial failures.
- Cover backfill, reconciliation, idempotency, and irreversible
  recovery when relevant.
- Assign temporary paths an owner and removal condition.
- Verify final contracts, data correctness, and cleanup.

## Output

Keep the design in the conversation unless asked to save it; when saving,
update its existing artifact. Use repository-relative links without line
numbers, keep supplied input paths and relevant earlier references, and
flag missing required sources.

## Design template

Keep applicable headings in order; omit empty sections unless a required
format says otherwise. Replace placeholders concisely; resolve questions
before completing the design.

```markdown
# <Type>: <outcome>

## Outcome and scope

<Goal, scope, constraints, and relevant non-goals.>

- AC1: <Observable acceptance criterion.>

## Current state

<Relevant behavior, owners, contracts, consumers, dependencies, and tests.
Cite evidence; distinguish facts from hypotheses. Include checks already run.>

## Solution

<Show how each AC is met: inputs, state changes, outputs, and failure behavior.
Define affected responsibilities, boundaries, contracts, and dependencies.
Mark new paths. Include required transition states and ordering constraints.>

## Decisions and trade-offs

- D1: <Choice, reasoning, realistic alternatives, and material trade-offs.>

<Note prior approvals or conventions that settle choices;
invent no alternatives.>

## Verification strategy

- AC1: <Evidence, verification layer, and whether it exists or is still needed.>

<Cover preserved behavior and structural constraints. Specify required evidence,
not fixtures, spies, or assertions unless their mechanism is essential.>

## Risks and mitigations

<Risks with mitigations or explicit acceptance. Support assumptions with evidence.
Include extension and compatibility concerns only when relevant and supported.>

## References

- <Source path>: <Purpose.>

<Use repository-relative paths or supplied input paths. Retain relevant earlier
references. If none are needed, state why.>
```
