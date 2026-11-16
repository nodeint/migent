---
name: product
description: Define product requirements, interaction flows, and acceptance criteria.
---

# Product specification

## Steps

1. Read the request and relevant product docs. State the user problem, goal,
   constraints, scope, and explicit non-goals. Ask about conflicting or missing inputs.
2. Identify target users and primary use cases. For each use case, record its
   trigger, user action, and expected result.
3. Write the interaction flow: commands, arguments, flags, prompts, outputs,
   and error feedback. Define defaults and validation rules.
4. Specify behavior for invalid input, cancellation, and missing resources.
   Keep architecture and internal code structure out of product decisions.
5. Assign observable acceptance criteria (AC IDs). Check that each use case and
   functional requirement is covered and can be verified from the user's perspective.
6. Resolve open product questions with the user. Record scope and UX decisions;
   leave the specification as a draft while required answers are pending.
7. Fill the applicable sections of the [PRD template](references/template.md).

## Output

Report in the conversation unless saving is requested. When saving, write `prd.md`
(or the requested path). Use repository-relative links without line numbers and
carry forward relevant earlier references.
