---
name: testing
description: Decide which tests to write, keep, or delete so every test covers logic, not coverage.
---

# Testing

A test exists to protect logic: a decision, a transformation, or a state transition.
It does not exist to execute lines, branches, exports, or files.
Mechanics (names, fixtures, temp directories, platform guards, commands) live in
[CONTRIBUTING.md](../../../CONTRIBUTING.md#testing); this skill decides whether a test should exist.

## Steps

1. Identify the tests in scope: tests being written, changed, reviewed, or pruned.
2. Apply the rules below to each test. A narrower project rule takes precedence.
3. For writing, add only tests that pass every rule. For pruning, delete each test that fails a rule and
   record the rule ID. Do not rewrite a failing test to make it pass a rule unless it protects logic that no
   other test covers.
4. Run the affected tests after every change. Never weaken a test that guards logic to make a change pass.
5. Report each deleted or added test group with its rule ID, and name any logic left without a test.

## Rule IDs

Each rule has a stable kebab-case ID. New rules get a new unique ID; existing IDs never change or get reused.
A test that fails a **blocker** rule is deleted; a **major** rule is fixed or deleted in the same change.

| Level | Meaning |
| :--- | :--- |
| **blocker** | The test has no value as written; delete it |
| **major** | The test has value only after a fix; fix it in the same change, or delete it |

## Rules

| ID | Level | Requirement | Exceptions |
| :--- | :--- | :--- | :--- |
| `protects-logic` | blocker | The code under test decides, computes, or transitions state. The test fails when that logic is wrong. A test that still passes when the logic is replaced by a constant, an empty result, or a no-op is deleted | A test that pins an external contract (see `contract-pinned-once`) |
| `no-coverage-tests` | blocker | Never add a test to reach an uncovered line, branch, export, or file. Missing coverage alone is not a reason to write a test | — |
| `distinct-outcome` | major | Each case of a family (`.each` rows, sibling tests) enters a different branch, equivalence class, or boundary. Merge or delete cases that take the same path to the same kind of result | — |
| `no-structure-tests` | blocker | Do not test source text, file layout, export lists, registries, catalogs, or "every X is registered, named, or exercised" inventories. Do not read repository files to assert how code is written | — |
| `no-declarative-data` | blocker | Do not test constants, static tables, config defaults, or data that holds no logic. A test that repeats the data it checks is deleted | Data that a function derives from other inputs |
| `no-framework-tests` | blocker | Do not test the language, the type system, or a dependency. The compiler checks types; the dependency owns its tests | Behavior of the repository's own adapter around the dependency |
| `no-phase-tests` | blocker | Delete tests that exist for an epic, phase, issue, baseline, or characterization of code that has since been replaced. Do not name or comment a test by issue or phase number | A fix keeps its regression test when the test states the behavior, not the issue |
| `lowest-level` | major | Test logic where it lives. Do not re-test the same logic through a higher layer (CLI, engine, or integration) that only forwards to it. Keep one entry-point test per command for wiring: arguments in, exit code and output out | — |
| `observable-behavior` | major | Assert results, files, output, or state a caller observes. Do not assert call counts, call order, private helpers, or internal structure | A boundary call that is the observable effect, asserted with its arguments |
| `strong-assertions` | major | Assert the exact value or error. Do not use `toBeDefined`, `toBeTruthy`, `not.toThrow()`, `toHaveBeenCalled()` without arguments, or `toHaveProperty` alone as the only check of a behavior | — |
| `one-behavior` | major | One behavior per test. A name that joins behaviors with "and" or lists outcomes is split, or the redundant parts are deleted | One behavior with several assertions on its single result |
| `contract-pinned-once` | major | A public contract (`--json` payload, exit code, persisted file format) is pinned by one test per shape. Snapshots pin only serialized external output, stay small enough to review by eye, and are not duplicated across tests | — |
| `fakes-at-boundary` | major | Replace only process, network, clock, and filesystem boundaries. Do not mock the repository's own modules to isolate a test | — |

## Pruning checklist

Ask in order for each test; the first failing answer names the rule and the test is deleted or fixed.

1. Does it exercise a decision, computation, or state transition? (`protects-logic`, `no-declarative-data`)
2. Does it check how code is written instead of what it does? (`no-structure-tests`, `no-framework-tests`)
3. Does it belong to finished work? (`no-phase-tests`)
4. Does another test already enter the same path with the same kind of result? (`distinct-outcome`, `lowest-level`)
5. Would a real defect in the logic fail it with a precise message? (`strong-assertions`, `observable-behavior`)
