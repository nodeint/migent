import { CancellationRequested, log } from '@nodeint/migent-kernel';
import type { ExecutionContext } from '@nodeint/migent-session';

import type { ChangeApplier } from '../runtime/operation.js';
import type { Change } from './changes.js';

/** What a cancelled execution writes. A role execution also records the event and the conversation. */
export type CancelStyle = 'role' | 'verify-only';

/**
 * Observed only inside the provider and the verify runner, which are the handlers' own awaits. The handler commits
 * the cancelled writes through the applier and rethrows; the runtime never catches it.
 */
export function commitCancelled(
  target: { applier: ChangeApplier<Change>; context: ExecutionContext; style: CancelStyle },
  error: unknown,
): never {
  if (error instanceof CancellationRequested) {
    const { applier, context, style } = target;
    const changes: Change[] = style === 'role'
      ? [
        { kind: 'emit', event: 'provider.cancelled', summary: 'cancellation requested', details: null },
        { kind: 'setStatus', status: 'cancelled' },
        { kind: 'saveRecord' },
      ]
      : [{ kind: 'setStatus', status: 'cancelled' }];
    applier.apply([...changes, { kind: 'saveExecution', status: 'cancelled' }]);
    log(`Execution ${context.executionId} marked cancelled.`);
  }
  throw error;
}
