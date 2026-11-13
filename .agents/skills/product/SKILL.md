---
name: product
description: >
  Define product requirements, user scenarios, UX/CLI interaction flows, and observable acceptance criteria before architectural design or implementation.
---

# Product specification

Explain what to build, why it matters, who it is for, and how the user interacts with it.
Keep it in the conversation unless the user or workflow requests a file.

## Scope

- Confirm user problem, goal, constraints, and success criteria.
- Define target users (interactive developers or automated agents) and primary use cases.
- Separate in-scope outcomes from explicit non-goals to prevent scope creep.
- Focus on user-observable behavior and product capabilities; do not make internal code structure or software architecture choices.

## Define requirements

- Describe user interaction flow, CLI commands, arguments/options, interactive prompts, and output presentation.
- Define functional requirements and business rules (validations, defaults, error messaging).
- Identify user-facing edge cases (cancellation, missing resources, invalid inputs).
- Formulate clear, observable acceptance criteria (AC) focused on user experience.

## Complete

- Resolve open product questions with the user before completing the specification.
- Record decisions on scope and user experience trade-offs.

## Save

- Write to `prd.md` using the fixed [template](references/template.md).
- Use repository-relative links without line numbers.
- Carry forward relevant earlier references.
