# Bugfix design

## Investigate

- Anchor the expectation in an existing contract, invariant, or regression baseline.
- Trace the failing path to the first violated invariant.
- Separate confirmed causes from hypotheses.
- Check related paths for the same faulty assumption.

## The design must

- Put expected versus actual behavior, impact, and reproduction under Outcome and scope.
- Put the failing path, violated invariant, cause or hypotheses, and the test that missed it under Current state.
- State the invariant to restore and explain why the fix addresses the cause, not only the symptom.
- Limit scope to the fix and necessary supporting work.
- Require a regression test that fails before the fix and passes after it, under Verification strategy;
  if that is impractical, say why and give alternative evidence.
- Cover repair, monitoring, and recovery for affected state where relevant.
