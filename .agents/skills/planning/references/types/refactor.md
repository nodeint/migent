# Refactor plan

## Investigate

- Map ownership, exports, importers, runtime consumers, and placement rules.
- Verify consumers by search and note the action each needs.
- Define the observable behavior that must not change and find the tests that pin it.
- Check the target against existing repository patterns.

## The plan must

- Describe current and target ownership, dependencies, and public surface.
- List non-goals and the preserved behavior under Current state.
- Add tests that pin current behavior before any step that could change it.
- Order structural steps so each intermediate state stays coherent.
- List obsolete exports, adapters, files, tests, and artifacts to remove.
- Verify both the structural outcome and the preserved behavior.
