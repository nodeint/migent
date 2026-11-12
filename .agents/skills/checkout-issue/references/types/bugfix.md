# Bugfix triage

- Signals: behavior contradicts documentation, a contract, or a test.
- Locate: from the issue's steps and the code, the package and command on the reported path; do not trace the cause.
- Anchor: the documentation, contract, or test that states the expected behavior, if one exists.
- Next: `design` when the cause is unclear or the path crosses contracts;
  `implement` when the faulty spot is evident in one module.
