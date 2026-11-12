# Design template

Use these sections in every design, in the conversation or in a saved file.

```markdown
# <Type>: <outcome>

## Outcome and scope

<Goal, scope, non-goals, constraints, and acceptance criteria AC1, AC2, ... from the task.>

## Current state

<Evidence from the repository: owners, modules, contracts, consumers, dependency direction,
and the baseline results of the relevant checks.>

## Solution

<Components and their responsibilities, boundaries, contracts, and dependency direction.>

## Decisions

<D1, D2, ...: options considered, the choice, and its trade-off.>

## Extension points

<How the solution extends for expected future changes, and what it deliberately does not support.>

## Verification strategy

<What evidence proves each AC: test layer and the behavior it pins; not test procedures.>

## Risks and open questions

<Risks, mitigations, assumptions, and unresolved decisions.>

## Recommended next

<`plan` or `implement`, and why.>

## References

<Inputs needed downstream, with their purpose and exact paths. For prior session artifacts,
use the snapshot paths received by this session; carry forward relevant earlier references.
For repository files, use repository-relative paths. If there are no inputs, say so.>
```
