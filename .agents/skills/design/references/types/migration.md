# Migration design

## Investigate

- Map current and target contracts, data, and sources of truth.
- Inventory producers, consumers, stored data, and deployments.
- Identify compatibility needs, deployment constraints, and irreversible boundaries.
- Find tests and operational signals proving transition safety.

## Design

- State irreversible boundaries and measurable completion signals.
- Define required phases: changes, source of truth, entry/exit criteria, stop conditions,
  and rollback.
- Define reads, writes, version skew, retries, and partial failures.
- Cover backfill, reconciliation, idempotency, and irreversible recovery when relevant.
- Assign temporary paths an owner and removal condition.
- Verify final contracts, data correctness, and cleanup.
