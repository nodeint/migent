import { VERIFY_FAILED, type VerifyRunResult } from '@nodeint/migent-kernel';

import type { Definition, Edge, OperationOutcome, Transition } from '../runtime/operation.js';
import type { PlainData } from '../runtime/plain-data.js';
import type { Change } from './changes.js';
import { revive } from './plain.js';
import { VERIFY_RUN, type VerifyOutput } from './types.js';

/** How a verify-only execution ended. */
export type VerifyOnlyEnd = { readonly passed: boolean };

export type VerifyOnlyState = { readonly turn: number };

const VERIFY_ONLY_EDGES: readonly Edge[] = [{ from: VERIFY_RUN, outcome: 'succeeded', to: { kind: 'end' } }];

/** A stage with only a verify list: one run, then the execution ends. It shares `run.verify` with role stages. */
export const verifyOnlyDefinition: Definition<VerifyOnlyState, Change, VerifyOnlyEnd> = {
  edges: VERIFY_ONLY_EDGES,
  decide(state, request, outcome) {
    switch (outcome.kind) {
      case 'succeeded':
        return decideVerified(state, outcome);
      case 'denied':
        throw new Error(`Verify was denied: ${outcome.reason}`);
      case 'failed':
        throw new Error(`Verify failed: ${outcome.error}`);
      default:
        return assertNever(outcome);
    }
  },
};

function assertNever(value: never): never {
  throw new Error(`Unhandled operation outcome: ${JSON.stringify(value)}`);
}

function decideVerified(
  state: VerifyOnlyState,
  outcome: Extract<OperationOutcome<PlainData, Change>, { kind: 'succeeded' }>,
): Transition<VerifyOnlyState, Change, VerifyOnlyEnd> {
  {
    const output = revive<VerifyOutput>(outcome.output);
    const result = revive<VerifyRunResult>(output.result);
    const passed = result.passed && result.infraError === null;
    if (passed) {
      return {
        kind: 'end', result: { passed },
        changes: [
          ...outcome.changes,
          { kind: 'emit', event: 'verify.passed', summary: 'all commands passed', details: { turn: state.turn, report: output.reportPath } },
          { kind: 'saveExecution', status: 'completed', outcome: completeOutcome() },
          { kind: 'publishVerifyReport', turn: state.turn },
        ],
      };
    }
    const failed = result.commands.find((item) => item.status === 'fail' || item.status === 'timed_out');
    return {
      kind: 'end', result: { passed },
      changes: [
        ...outcome.changes,
        {
          kind: 'emit', event: 'verify.failed', summary: `${failed?.command ?? 'verify'} failed`,
          details: {
            turn: state.turn, command: failed?.command ?? null, status: failed?.status ?? null,
            exit_code: failed?.exitCode ?? null, report: output.reportPath,
          },
        },
        {
          kind: 'saveExecution', status: 'failed',
          error: result.infraError ?? `Verify failed: ${failed?.command ?? 'verify'}`,
          extra: { failure_reason: VERIFY_FAILED },
        },
      ],
    };
  }
}

function completeOutcome(): { status: 'complete'; blocker: null; decision: null; question: null; questions: [] } {
  return { status: 'complete', blocker: null, decision: null, question: null, questions: [] };
}
