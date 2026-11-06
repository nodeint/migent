# Migration plan

## Investigate

- Describe current and target contracts, data, and sources of truth.
- Inventory producers, consumers, stored data, deployments, and external contracts.
- Identify compatibility needs, deployment order, and irreversible boundaries.
- Find the tests and operational signals that prove each phase safe.

## The plan must

- Name the irreversible boundaries under Outcome and scope.
- Give each inventory item an action and a measurable completion signal.
- Replace Implementation with Phases, numbered S1, S2, ...
  Each phase states its changes, one authoritative source of truth, entry and exit criteria, stop conditions, and rollback.
- Define read and write behavior, version skew, retries, and partial failures.
- Cover backfill, reconciliation, idempotency, and recovery evidence for irreversible changes where relevant.
- Give each temporary adapter, flag, and old path an owner and a removal condition.
- Prove the final state, data correctness, and cleanup under Testing.
