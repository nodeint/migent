---
name: planning
description: >
  Draft a repository-grounded implementation plan before changing code, then report the result against it.
  Covers features, bugfixes, refactors, and migrations.
  Excludes research, option analysis, and status reports.
---

# Implementation planning

Plan before changing code.
Keep the plan in the conversation; save it only when the user asks.

## Choose a type

Pick one primary outcome and read its reference:

- [Feature](references/types/feature.md): add observable behavior.
- [Bugfix](references/types/bugfix.md): restore an existing expectation.
- [Refactor](references/types/refactor.md): change structure, preserve behavior and contracts.
- [Migration](references/types/migration.md): transition data, contracts, consumers, or runtime state in phases.

Choose migration when staged compatibility, data transformation, or cutover is central.
Supporting work stays in the primary plan; independently shippable outcomes get separate plans.

## Investigate

1. Follow the repository documentation routes and inspect the working tree.
2. Trace entry points, ownership, contracts, consumers, and tests.
   Search for consumers; do not infer them from exports.
3. Run the baseline checks relevant to the change scope and record the results.
4. Ask when a missing product or architecture decision would change the design.

## Draft the plan

Use the [template](references/template.md) with the adjustments in the type reference.
Scale detail to the work: one line per section for a small change, more for large work.
Never omit Testing or Documentation; if nothing changes, say why.

- Number acceptance criteria (AC1, ...) and steps (S1, ...); map each criterion to a unit or integration test (layer per the `testing` skill).
- Cite exact paths and symbols; confirm named paths and commands exist, or mark them as new.
- Separate verified facts, decisions, assumptions, and open questions.
- Say what is unverified and how to resolve it; never claim planned checks have run.

Proceed when no open question blocks the design.
Ask for approval when one does, or when the work is destructive, irreversible, or externally visible.

## Saving a plan

Update the existing plan that owns the outcome, if any.
Use repository-relative links, not line numbers.
Validate the Markdown with the repository Markdown skill.
