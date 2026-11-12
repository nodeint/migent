---
name: design
description: >
  Decide the solution for a triaged task before planning or implementing: a clean, extensible
  structure with responsibilities, boundaries, contracts, dependency direction, and decisions.
  Covers features, bugfixes, refactors, and migrations.
  Excludes task breakdown, implementation steps, research without a decision, and status reports.
---

# Solution design

Decide how to solve the task; leave the order of work to the planning skill.
Keep the design in the conversation; save it only when the user or workflow asks.

## Choose a type

Pick one primary outcome and read its reference. Start from the type in the issue summary
when there is one; the types follow the work types table in `CONTRIBUTING.md`:

- [Feature](references/types/feature.md): add observable behavior.
- [Bugfix](references/types/bugfix.md): restore an existing expectation.
- [Refactor](references/types/refactor.md): change structure, preserve behavior and contracts.
- [Migration](references/types/migration.md): transition data, contracts, consumers, or runtime state in phases.

Choose migration when staged compatibility, data transformation, or cutover is central.
Supporting work stays in the primary design; independently shippable outcomes get separate designs.

## Investigate

1. Follow the repository documentation routes and read the README of each affected package.
2. Map current ownership, exports, consumers, contracts, dependency direction, and tests.
   Search for consumers; do not infer them from exports.
3. Find the closest existing pattern and the domain owner; prefer extending it over adding a new one.
4. Run the baseline checks relevant to the change scope and record the results.
5. Ask when a missing product or architecture decision would change the solution.

## Draft the design

Use the [template](references/template.md) with the adjustments in the type reference.
Scale detail to the work: one line per section for a small change, more for large work.
Never omit a section; if it does not apply, say why.

- Derive and clarify acceptance criteria from the task and the sourced issue's desired outcome without
  inventing requirements or widening scope; ask when a requirement change or ambiguity affects scope.
- Number decisions (D1, ...); give each one the options considered, the choice, and its trade-off.
- Cite exact paths and symbols; confirm named paths exist, or mark them as new.
- Separate verified facts, decisions, assumptions, and open questions.
- Read relevant references from prior artifacts, and list the inputs needed downstream in
  References. Use this session's snapshot paths for prior artifacts and carry forward
  relevant earlier references; report missing or inconsistent required inputs.
- Keep dependencies pointing in the established direction; justify any reversal with evidence.
- Justify extension points with expected needs supported by evidence; avoid speculative structure.
- Stay at the solution level: no task breakdown, step order, file-by-file edits, or code.
  Short type or interface signatures are allowed when they define a contract.
- Recommend the next workflow: `plan` when the work needs several ordered tasks or spans modules;
  `implement` when it is small enough to build directly from the design.

Ask the human to approve structural decisions before finishing and record the approval in the design.
After a review revision,
ask again if a structural decision or its material trade-off changed; identify the changes.
Otherwise record why the existing approval still applies.

## Saving a design

Update the existing design that owns the outcome, if any.
Use repository-relative links, not line numbers.
