# Refactor triage

- Signals: the issue asks to move, split, rename, or simplify code without changing behavior.
- Locate: the modules to restructure and their consumers.
- Anchor: the behavior and contracts that must stay unchanged, and the tests that cover them.
- Next: usually `design`; `implement` only for a local change with no consumer impact.
