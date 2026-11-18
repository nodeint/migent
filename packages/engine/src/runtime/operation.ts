import type { PlainData } from './plain-data.js';

/**
 * The attempt comes from durable state, never from an in-memory counter (D10), so the same logical request keeps
 * its identity across a restart.
 */
export type LogicalIdentity = {
  readonly executionId: string;
  readonly operationId: string;
  readonly attempt: number;
};

/** The definition creates the request and supplies its logical identity. Input is detached data (D9). */
export type OperationRequest<Input extends PlainData = PlainData> = {
  readonly identity: LogicalIdentity;
  readonly input: Input;
};

/** What a handler reports. It proposes `changes` and never applies them. */
export type HandlerResult<Output extends PlainData, Change> =
  | { readonly kind: 'succeeded'; readonly output: Output; readonly changes: readonly Change[] }
  | { readonly kind: 'failed'; readonly error: string; readonly changes: readonly Change[] };

/** What the definition sees. `denied` means the policy stopped the handler before it ran. */
export type OperationOutcome<Output extends PlainData, Change> =
  | HandlerResult<Output, Change>
  | { readonly kind: 'denied'; readonly reason: string };

/**
 * What an operation lets an interceptor change. A patch may set only the listed top-level fields, and the patched
 * value must still pass the operation's own input or output check. `shortCircuit` lets a before interceptor
 * supply the output instead of running the handler.
 */
export type Interceptable = {
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  readonly shortCircuit?: boolean;
};

/** Live services reach a handler through its construction, never through the request. */
export type Operation<Input extends PlainData, Output extends PlainData, Change> = {
  readonly id: string;
  /** Absent means no interceptor can change this operation. */
  readonly interceptable?: Interceptable;
  acceptsInput(input: PlainData): input is Input;
  producesOutput(output: PlainData): output is Output;
  handle(input: Input): Promise<HandlerResult<Output, Change>>;
};

/** Registry entries only need the generic shape; method syntax keeps handlers assignable here. */
export type AnyOperation<Change> = Operation<PlainData, PlainData, Change>;

/** A definition's proposal after an outcome. A `next` carries the state its request was built from. */
export type Transition<State, Change, Result> =
  | { readonly kind: 'next'; readonly request: OperationRequest; readonly state: State; readonly changes: readonly Change[] }
  | { readonly kind: 'end'; readonly result: Result; readonly changes: readonly Change[] };

/** A declared edge: after `from` yields an outcome of kind `outcome`, the run may move to `to`. */
export type Edge = {
  readonly from: string;
  readonly outcome: OperationOutcome<PlainData, never>['kind'];
  readonly to: { readonly kind: 'next'; readonly operationId: string } | { readonly kind: 'end' };
};

export type Definition<State, Change, Result> = {
  readonly edges: readonly Edge[];
  decide(
    state: State,
    request: OperationRequest,
    outcome: OperationOutcome<PlainData, Change>,
  ): Transition<State, Change, Result>;
};

/**
 * Commits one transition's changes, in order. The commit is one synchronous unit (D12): it never awaits and
 * never observes cancellation, so a cooperative interruption cannot split it.
 */
export type ChangeApplier<Change> = {
  apply(changes: readonly Change[]): void;
};
