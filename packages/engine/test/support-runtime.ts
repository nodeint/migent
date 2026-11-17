import type {
  AnyOperation,
  ChangeApplier,
  Definition,
  HandlerResult,
  OperationOutcome,
  OperationRequest,
  Transition,
} from '../src/runtime/operation.js';
import { OperationRuntime } from '../src/runtime/operation-runtime.js';
import type { PlainData } from '../src/runtime/plain-data.js';
import type { TraceEntry } from '../src/runtime/trace.js';

/** Unrelated names on purpose: the runtime must treat any operation the same way. */
export type Change = { readonly write: string };
export type State = { readonly steps: number };

export const SCOPE = { sessionId: 's1', stageId: 'stage', role: 'worker' } as const;

export function request(operationId: string, input: PlainData = { n: 1 }, attempt = 1): OperationRequest {
  return { identity: { executionId: 'e1', operationId, attempt }, input };
}

export function operation(
  id: string,
  handle: (input: PlainData) => Promise<HandlerResult<PlainData, Change>>,
  { accepts = () => true, produces = () => true }: {
    accepts?: (input: PlainData) => boolean;
    produces?: (output: PlainData) => boolean;
  } = {},
): AnyOperation<Change> {
  return {
    id,
    acceptsInput: (input): input is PlainData => accepts(input),
    producesOutput: (output): output is PlainData => produces(output),
    handle,
  };
}

export function recordingApplier(): ChangeApplier<Change> & { readonly applied: Change[][] } {
  const applied: Change[][] = [];
  return { applied, apply: (changes) => void applied.push([...changes]) };
}

export function definition(
  edges: Definition<State, Change, string>['edges'],
  decide: (
    outcome: OperationOutcome<PlainData, Change>,
    request: OperationRequest,
  ) => Transition<State, Change, string>,
): Definition<State, Change, string> {
  return { edges, decide: (_state, current, outcome) => decide(outcome, current) };
}

export function runtimeWith(
  operations: readonly AnyOperation<Change>[],
  applier: ChangeApplier<Change>,
  extra: { policy?: import('../src/runtime/policy.js').Policy; trace?: { record(entry: TraceEntry): void } } = {},
): OperationRuntime<Change> {
  return new OperationRuntime({ operations, applier, ...extra });
}
