import { debugEnabled, log } from '@nodeint/migent-kernel';

import type {
  AnyOperation,
  ChangeApplier,
  Definition,
  Edge,
  HandlerResult,
  OperationOutcome,
  OperationRequest,
  Transition,
} from './operation.js';
import type { PlainData } from './plain-data.js';
import { isPlainData } from './plain-data.js';
import type { Policy, PolicyContext, PolicyDecision } from './policy.js';
import { ALLOW_ALL_POLICY } from './policy.js';
import { RuntimeError } from './runtime-error.js';
import type { TraceEntry, TraceSink } from './trace.js';

/** The scope that every policy context in one run shares. */
export type RuntimeScope = {
  readonly sessionId: string;
  readonly stageId: string;
  readonly role: string;
};

export type RuntimeOptions<Change> = {
  readonly operations: readonly AnyOperation<Change>[];
  readonly applier: ChangeApplier<Change>;
  readonly policy?: Policy;
  /** Receives the decision trace, but only while debug is enabled. The default sink writes the debug channel. */
  readonly trace?: TraceSink;
};

export type RunInput<State, Change, Result> = {
  readonly scope: RuntimeScope;
  readonly definition: Definition<State, Change, Result>;
  readonly state: State;
  readonly request: OperationRequest;
};

const DEFAULT_TRACE_SINK: TraceSink = {
  record: (entry) => {
    log(`debug: runtime ${JSON.stringify(entry)}`);
  },
};

/**
 * Generic cycle: validate the request, evaluate the policy once, invoke the handler, validate its output, let
 * the definition propose a transition, authorize it against the declared edges, apply its changes in order, and
 * continue. It names no operation and holds no domain rule. Exceptions, including cancellation, propagate.
 */
export class OperationRuntime<Change> {
  private readonly operations = new Map<string, AnyOperation<Change>>();
  private readonly applier: ChangeApplier<Change>;
  private readonly policy: Policy;
  private readonly sink: TraceSink;
  private invocationCount = 0;

  constructor(options: RuntimeOptions<Change>) {
    for (const operation of options.operations) this.operations.set(operation.id, operation);
    this.applier = options.applier;
    this.policy = options.policy ?? ALLOW_ALL_POLICY;
    this.sink = options.trace ?? DEFAULT_TRACE_SINK;
  }

  public async run<State, Result>(input: RunInput<State, Change, Result>): Promise<Result> {
    let { state, request } = input;
    for (;;) {
      const transition = await this.cycle(input, state, request);
      this.applier.apply(transition.changes);
      switch (transition.kind) {
        case 'end':
          return transition.result;
        case 'next':
          ({ state, request } = transition);
          break;
        default:
          return assertNever(transition, 'transition');
      }
    }
  }

  private async cycle<State, Result>(
    input: RunInput<State, Change, Result>,
    state: State,
    request: OperationRequest,
  ): Promise<Transition<State, Change, Result>> {
    const invocationId = `invocation-${(this.invocationCount += 1)}`;
    const trace = (entry: TraceEntry): void => {
      if (debugEnabled()) this.sink.record(entry);
    };
    const operation = this.requireOperation(request);
    trace({ kind: 'request', invocationId, ...request.identity });

    const decision = this.policy.evaluate(request, policyContext(input.scope, request));
    trace({ kind: 'policy', invocationId, verdict: decision.kind });
    const outcome = await this.invoke(operation, request, decision);
    trace({ kind: 'outcome', invocationId, outcome: outcome.kind });

    const transition = input.definition.decide(state, request, outcome);
    authorize(input.definition, { request, outcome }, transition);
    trace({
      kind: 'transition',
      invocationId,
      transition: transition.kind,
      nextOperationId: nextOperationId(transition),
    });
    return transition;
  }

  private requireOperation(request: OperationRequest): AnyOperation<Change> {
    const { operationId } = request.identity;
    const operation = this.operations.get(operationId);
    if (operation === undefined) {
      throw new RuntimeError('unknown_operation', `Operation is not registered: ${operationId}`);
    }
    if (!isPlainData(request.input) || !operation.acceptsInput(request.input)) {
      throw new RuntimeError('invalid_input', `Invalid input for operation ${operationId}.`);
    }
    return operation;
  }

  private async invoke(
    operation: AnyOperation<Change>,
    request: OperationRequest,
    decision: PolicyDecision,
  ): Promise<OperationOutcome<PlainData, Change>> {
    switch (decision.kind) {
      case 'deny':
        return { kind: 'denied', reason: decision.reason };
      case 'allow':
        return validateResult(operation, await operation.handle(request.input));
      default:
        return assertNever(decision, 'policy decision');
    }
  }
}

/** Every handler result kind is decided here, so a new variant fails to compile until it is handled (D8). */
function validateResult<Change>(
  operation: AnyOperation<Change>,
  result: HandlerResult<PlainData, Change>,
): HandlerResult<PlainData, Change> {
  switch (result.kind) {
    case 'succeeded':
      if (!isPlainData(result.output) || !operation.producesOutput(result.output)) {
        throw new RuntimeError('invalid_output', `Invalid output from operation ${operation.id}.`);
      }
      return result;
    case 'failed':
      return result;
    default:
      return assertNever(result, 'handler result');
  }
}

function assertNever(value: never, what: string): never {
  throw new RuntimeError('unsupported_variant', `Unsupported ${what}: ${JSON.stringify(value)}`);
}

function policyContext(scope: RuntimeScope, request: OperationRequest): PolicyContext {
  return {
    ...scope,
    executionId: request.identity.executionId,
    operationId: request.identity.operationId,
    attempt: request.identity.attempt,
  };
}

function authorize<State, Change, Result>(
  definition: Definition<State, Change, Result>,
  { request, outcome }: { readonly request: OperationRequest; readonly outcome: OperationOutcome<PlainData, Change> },
  transition: Transition<State, Change, Result>,
): void {
  const from = request.identity.operationId;
  const target = transitionTarget(transition);
  const declared = definition.edges.some(
    (edge) => edge.from === from && edge.outcome === outcome.kind && edgeTarget(edge) === target,
  );
  if (!declared) {
    throw new RuntimeError(
      'unauthorized_transition',
      `Undeclared transition from ${from} (${outcome.kind}) to ${target}.`,
    );
  }
}

function transitionTarget<State, Change, Result>(transition: Transition<State, Change, Result>): string {
  switch (transition.kind) {
    case 'end':
      return 'end';
    case 'next':
      return `next:${transition.request.identity.operationId}`;
    default:
      return assertNever(transition, 'transition');
  }
}

function edgeTarget(edge: Edge): string {
  switch (edge.to.kind) {
    case 'end':
      return 'end';
    case 'next':
      return `next:${edge.to.operationId}`;
    default:
      return assertNever(edge.to, 'edge target');
  }
}

function nextOperationId<State, Change, Result>(transition: Transition<State, Change, Result>): string | null {
  switch (transition.kind) {
    case 'end':
      return null;
    case 'next':
      return transition.request.identity.operationId;
    default:
      return assertNever(transition, 'transition');
  }
}
