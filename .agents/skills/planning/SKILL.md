---
name: planning
description: >
  Break an approved design into ordered, independently verifiable implementation tasks, then
  report the result against them. Requires an approved design as input.
  Excludes solution design, research, option analysis, and status reports.
---

# Implementation planning

Turn an approved design into tasks; do not decide or change the solution.
Keep the plan in the conversation; save it only when the user or workflow asks.

## Input

Start from an approved design (see the `design` skill) and the task's acceptance criteria.
Without a design, stop and ask for one instead of deciding the solution.
Report design gaps; a gap that blocks a task goes back to the human.

## Investigate

1. Read the design and the README of each package its solution touches.
2. Read relevant references in the design; stop and report missing or inconsistent required inputs.
3. Locate the files, symbols, and existing tests each part of the design touches.
4. Run the baseline checks relevant to the change scope and record the results.

## Draft the plan

Use the [template](references/template.md).
Scale detail to the work: a few tasks for a small change, more for large work.

- Number tasks (T1, ...); each realizes cited design parts or decisions (D1, ..., P1, ...).
- Keep every task independently verifiable and leave the codebase coherent after it.
- Order tasks by dependency; follow the design's phases or intermediate states when it defines them.
- Map each acceptance criterion to the tasks and tests that prove it, following the design's verification strategy.
- Cite exact paths and symbols; confirm named paths and commands exist, or mark them as new.
- Say what is unverified and how to resolve it; never claim planned checks have run.
- List the approved design, relevant comments, and other inputs needed downstream in References.
  Use this session's snapshot paths for prior artifacts and carry forward relevant earlier references.
- Exclude full code; short signatures only when they remove ambiguity.

## Saving a plan

Update the existing plan that owns the outcome, if any.
Use repository-relative links, not line numbers.
