---
name: design
description: >
  Decide a solution for unresolved behavior, ownership, contract, or architecture choices.
  Covers features, bugfixes, refactors, and migrations. Excludes status reports and research alone.
---

# Solution design

Explain how the solution meets acceptance criteria, fits the repository, and handles trade-offs.
Keep it in the conversation unless the user or workflow requests a file.

## Scope

- Confirm goal, scope, constraints, acceptance criteria, and verification evidence.
- Use sourced requirements; ask about ambiguity affecting scope or behavior.
- If no consequential choice remains, explain why no design document is needed.
- Keep supporting changes within scope; surface independently shippable outcomes separately.

Choose the primary type from the issue or `CONTRIBUTING.md` and read its reference:

- [Feature](references/types/feature.md): add observable behavior.
- [Bugfix](references/types/bugfix.md): restore an expectation.
- [Refactor](references/types/refactor.md): change structure, preserve behavior and contracts.
- [Migration](references/types/migration.md): staged compatibility, data transformation, or cutover.

## Investigate

- Follow repository documentation routes and affected package READMEs.
- Inspect owners, contracts, dependencies, and tests. Search for actual consumers.
- Prefer existing patterns and domain owners when they fit.
- Reproduce, trace, or run focused checks to distinguish solutions. Follow repository
  check requirements; this skill adds no full baseline requirement.
- Present options, trade-offs, and a recommendation when user input is needed.
  Reuse prior decisions and authorization.

## Design

Use the fixed [template](references/template.md) and relevant type reference.
Keep headings and order; do not merge or omit sections. Explain briefly when a section
is inapplicable. Scale detail to uncertainty and impact.

- Trace each acceptance criterion through behavior or data flow, including relevant failures.
- Describe affected ownership, boundaries, contracts, and dependencies.
- Cite existing paths and symbols; mark new paths. Justify departures from established patterns.
- Explain consequential choices and trade-offs; do not invent routine alternatives.
- Separate facts, decisions, and assumptions. Support extension needs with evidence.
- Define evidence for acceptance criteria and preserved behavior.
- Include transition states and ordering constraints needed for correctness or recovery.
  Exclude execution task lists and file-by-file edits; use signatures or examples only to clarify.

## Complete

- Resolve questions affecting the solution; record concrete answers and their reasoning.
- Obtain required user decisions and approvals. Revisit approval only when the decision
  or its material trade-off changes.
- Keep the design as a draft while required answers are pending; state the blocker.
  Do not hide unanswered questions as assumptions.
- Give remaining risks a mitigation or explicit acceptance decision.

## Save

- Update the existing design for the outcome when saving.
- Use repository-relative links without line numbers.
- Include sources needed to understand or verify the design.
- For prior artifacts, use supplied snapshot paths, retain relevant earlier references,
  and report missing or inconsistent required inputs.
