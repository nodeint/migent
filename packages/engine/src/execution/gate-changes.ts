import { cancellationSignal } from '@nodeint/migent-kernel';
import { assertSessionLockHeld, sessionLockHeldLocally, type SessionStore } from '@nodeint/migent-session';

import type { ChangeApplier } from '../runtime/operation.js';

type ResumeExpiredRecord = Parameters<SessionStore['recordResumeExpired']>[1];

/** Every write of the resume gate. Proposed by the gate definition; only `GateApplier` commits it. */
export type GateChange = { readonly kind: 'recordResumeExpired'; readonly record: ResumeExpiredRecord };

/** What the gate applier writes to: the session's store, id and directory (whose lock the caller holds). */
export type GateTarget = {
  readonly store: SessionStore;
  readonly sessionId: string;
  readonly directory: string;
};

/**
 * Commits the gate's writes in list order. No execution exists at gate time, so this is separate from
 * `ExecutionApplier`. It never awaits. A cancellation request, a missing session lock, or a lock that another
 * process took over is checked before the first write, so a refused commit writes nothing.
 */
export class GateApplier implements ChangeApplier<GateChange> {
  constructor(private readonly target: GateTarget) {}

  public apply(changes: readonly GateChange[]): void {
    if (changes.length === 0) return;
    cancellationSignal().throwIfCancelled();
    const { directory } = this.target;
    // `assertSessionLockHeld` alone passes when no lock exists, so possession is checked first.
    if (!sessionLockHeldLocally(directory)) {
      throw new Error(`The resume gate cannot write: this process does not hold the lock of ${directory}.`);
    }
    assertSessionLockHeld(directory);
    for (const change of changes) {
      change.kind satisfies 'recordResumeExpired';
      this.target.store.recordResumeExpired(this.target.sessionId, change.record);
    }
  }
}
