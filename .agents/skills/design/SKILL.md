---
name: design
description: Resolve behavior, contract, ownership, and architecture choices.
---

# Solution design

## Steps

1. Read the requirements and prior decisions. State goal, scope, constraints, and
   acceptance criteria. Ask about ambiguity affecting scope or behavior. If no
   consequential choice remains, explain why a design document is unnecessary.
2. Select the primary work type under repository rules and read its reference below.
   Ask if an unclear classification changes the approach; do not force other work
   into these four types.
3. Read affected package docs and code. Identify owners, contracts, dependencies,
   actual consumers, and tests. Record paths and symbols supporting the current state.
4. Trace the relevant behavior or data flow. Separate facts from hypotheses and
   identify the choices needed to meet the acceptance criteria.
5. Choose a solution using existing ownership and patterns. Explain consequential
   trade-offs; present options and a recommendation when user input is needed.
   Reuse settled decisions and authorization. Surface independently shippable work
   separately rather than expanding scope.
6. Describe inputs, state changes, outputs, failure paths, boundaries, and contracts.
   Mark new paths and justify departures from existing patterns. Include transition
   ordering and recovery when needed; exclude file-by-file edits and execution tasks.
7. Map each acceptance criterion and preserved behavior to verification evidence.
   Give material risks a mitigation or explicit acceptance decision.
8. Resolve required decisions before completing the design. Keep it as a draft when
   answers are pending; record the blocker rather than hiding it as an assumption.
9. Fill the applicable sections of the [design template](references/template.md).
   Distinguish facts, decisions, and assumptions.

## Type references

- [Feature](references/types/feature.md): add observable behavior.
- [Bugfix](references/types/bugfix.md): restore an expectation.
- [Refactor](references/types/refactor.md): preserve behavior while changing structure.
- [Migration](references/types/migration.md): staged compatibility or data transition.

## Output

Keep the design in the conversation unless saving is requested. When saving, update
its existing artifact. Use repository-relative links without line numbers, preserve
supplied input paths and relevant earlier references, and flag missing required sources.
