# Design template

Keep all headings and their order. Replace placeholders with concise content.
For inapplicable sections, state why. Resolve questions before completing the design.

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

<Identify prior approvals or conventions that settle choices; invent no alternatives.>

## Verification strategy

- AC1: <Evidence, verification layer, and whether it exists or is still needed.>

<Cover relevant preserved behavior and structural constraints.>

## Risks and mitigations

<Risks with mitigations or explicit acceptance. Support assumptions with evidence.
Include extension and compatibility concerns only when relevant and supported.>

## References

- <Source path>: <Purpose.>

<Use repository-relative paths or supplied artifact snapshots. Retain relevant earlier
references. If none are needed, state why.>
```
