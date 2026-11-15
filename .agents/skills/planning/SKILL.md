---
name: planning
description: Split requirements and design into independently verifiable phases.
---

# Implementation planning

## Steps

1. Read the requirements, design decisions, and repository evidence. State goal,
   scope, constraints, exclusions, and acceptance criteria with stable IDs.
2. Resolve choices affecting behavior, contracts, architecture, or phase boundaries.
   Preserve settled decisions; ask the user when a required decision is missing.
3. Group work into complete outcomes, each independently reviewable and verifiable;
   aim for one commit per phase. Split outcomes that can merge green independently.
   Explain why coupled parts must stay together.
4. Order phases by dependency, then risk. Confirm assumptions before dependent work.
   Each phase must leave the repository coherent and deliver its promised behavior
   and verification without relying on a later phase.
5. Fill each phase in the [plan template](references/template.md): outcome, scope,
   exclusions, boundary rationale, dependencies, decisions, references, runnable
   verification commands, expected results, and completion criteria.
6. Put rules, enforcement, tests, and usage documentation in the phase delivering
   the outcome. Reserve only integration across phases and overview docs for the end.
7. Map every acceptance criterion to phases and verification. Check for missing
   coverage, incomplete outcomes, and unresolved implementation decisions.
8. Deliver the plan only after blocking decisions are resolved. Exclude code,
   pseudocode, signatures, and file-by-file edit instructions.

## Output

Keep the plan in the conversation unless saving is requested. Retain usable input
references. Planning does not authorize implementation.
Treat an approved saved handoff as a snapshot. Track live progress separately;
revise remaining phases when evidence changes and explain changes to settled outcomes.
