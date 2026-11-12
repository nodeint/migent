# Bugfix design

## Investigate

- Ground the expectation in a contract, invariant, or regression baseline.
- Trace the first violated invariant; separate causes from hypotheses.
- Check related paths for the same faulty assumption.

## Design

- State expected versus actual behavior, impact, and reproduction.
- Explain the failing path, root cause, and verification gap.
- Restore the invariant; limit scope to the fix and necessary support.
- Require a regression test failing before and passing after the fix.
  If impractical, explain why and provide alternative evidence.
- Cover state repair, monitoring, and recovery when relevant.
