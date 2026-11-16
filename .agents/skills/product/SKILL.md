---
name: product
description: Define product requirements, interaction flows, and acceptance criteria.
---

# Product specification

## Steps

1. Read the request and relevant product docs. State the user problem, goal,
   constraints, scope, and explicit non-goals; ask about conflicting or
   missing inputs.
2. Identify target users and primary use cases. Record each use case's
   trigger, user action, and expected result.
3. Write the interaction flow: commands, arguments, flags, prompts, outputs,
   and error feedback. Define defaults and validation rules.
4. Specify behavior for invalid input, cancellation, and missing resources.
   Keep architecture and internal code structure out of product decisions.
5. Assign observable acceptance criteria (AC IDs). Check that every use case
   and functional requirement is covered and user-verifiable.
6. Resolve open product questions with the user and record scope and UX
   decisions. Keep the spec as a draft while required answers are pending.
7. Fill the applicable sections of the [PRD template](#prd-template).

## Output

Report in the conversation unless asked to save; when saving, write `prd.md`
(or the requested path). Use repository-relative links without line numbers
and carry forward relevant earlier references.

## PRD template

Keep applicable headings in order; omit empty sections unless a required
format says otherwise. Replace placeholders concisely; resolve questions
before completing the specification.

```markdown
# PRD: <outcome>

## Problem statement & user value

<Who is affected, what problem is solved, and what value is delivered.>

## Target users & use cases

- UC1: <Primary use case, target user, and trigger.>

## User experience & interaction flow

<CLI syntax, flags/arguments, prompts, progress indicators, output formats
(plain text, JSON), and error feedback.>

## Functional requirements & business rules

- FR1: <Functional requirement, validation rule, default behavior.>

## Scope & non-goals

### In-scope

- <Specific capability included in this scope.>

### Non-goals

- <Explicitly excluded capabilities or deferred features.>

## Edge cases & user feedback

- <Unusual inputs, cancellation, missing resources, and how the user
  is informed.>

## Acceptance criteria

- AC1: <Observable criteria from user/consumer perspective.>

## References

- <Source path>: <Purpose.>
```
