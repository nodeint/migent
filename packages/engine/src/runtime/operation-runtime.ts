import { debugEnabled, log } from '@nodeint/migent-kernel';

import type { InterceptorChain, InterceptProposal, Judgement, RetryBudget } from './interception.js';
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
  /** Ordered interceptors. Without it, or with no interceptor for an operation, the cycle makes no extra await. */
  readonly interceptors?: InterceptorChain;
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
  private readonly interceptors: InterceptorChain | null;
  private invocationCount = 0;

  constructor(options: RuntimeOptions<Change>) {
    for (const operation of options.operations) this.operations.set(operation.id, operation);
    this.applier = options.applier;
    this.policy = options.policy ?? ALLOW_ALL_POLICY;
    this.sink = options.trace ?? DEFAULT_TRACE_SINK;
    this.interceptors = options.interceptors ?? null;
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
    const outcome = await this.invoke(operation, request, { decision, scope: input.scope });
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
    context: { readonly decision: PolicyDecision; readonly scope: RuntimeScope },
  ): Promise<OperationOutcome<PlainData, Change>> {
    const { decision } = context;
    switch (decision.kind) {
      case 'deny':
        return { kind: 'denied', reason: decision.reason };
      case 'allow':
        if (!this.intercepts(operation.id)) return validateResult(operation, await operation.handle(request.input));
        return this.invokeAllowed(operation, request, context.scope);
      default:
        return assertNever(decision, 'policy decision');
    }
  }

  /** Whether any phase has interceptors. Without them the cycle keeps its direct handler path. */
  private intercepts(operationId: string): boolean {
    const chain = this.interceptors;
    return chain !== null && (chain.has(operationId, 'before') || chain.has(operationId, 'after'));
  }

  /** Before chain, handler (or the short-circuit output), output check, after chain. */
  private async invokeAllowed(
    operation: AnyOperation<Change>,
    request: OperationRequest,
    scope: RuntimeScope,
  ): Promise<HandlerResult<PlainData, Change>> {
    const { identity } = request;
    const chain = this.interceptors;
    let {input} = request;
    const retry = oneRetry();
    const fingerprint = (at: PlainData) => (): PlainData | null => operation.evidence?.(at) ?? null;
    let supplied: { readonly output: PlainData } | null = null;
    if (chain?.has(operation.id, 'before') === true) {
      const passed = await chain.run({
        phase: 'before', scope, identity, value: input, retry, fingerprint: fingerprint(request.input),
        judge: (current, proposal) => judge({ operation, phase: 'before' }, current, proposal),
      });
      if (passed.shortCircuit) supplied = { output: passed.value };
      else input = passed.value;
    }
    const result = supplied === null
      ? validateResult(operation, await operation.handle(input))
      : { kind: 'succeeded' as const, output: supplied.output, changes: [] };
    if (result.kind !== 'succeeded' || chain?.has(operation.id, 'after') !== true) return result;
    const passed = await chain.run({
      phase: 'after', scope, identity, value: result.output, retry, fingerprint: fingerprint(input),
      judge: (current, proposal) => judge({ operation, phase: 'after' }, current, proposal),
    });
    return { ...result, output: passed.value };
  }
}

const oneRetry = (): RetryBudget => {
  let used = false;
  return { take: () => !used && (used = true) };
};

const rejected = (reason: string): Judgement => ({ kind: 'rejected', reason });

/** The runtime's check of one interceptor proposal. Plugins can only patch declared fields of plain data. */
function judge<Change>(
  point: { readonly operation: AnyOperation<Change>; readonly phase: 'before' | 'after' },
  current: PlainData,
  proposal: InterceptProposal,
): Judgement {
  switch (proposal.kind) {
    case 'continue':
      return { kind: 'accepted', value: current, shortCircuit: false };
    case 'patch':
      return judgePatch(point, current, proposal.fields);
    case 'short_circuit':
      return judgeShortCircuit(point, proposal.output);
    default:
      return assertNever(proposal, 'interceptor proposal');
  }
}

function judgePatch<Change>(
  { operation, phase }: { readonly operation: AnyOperation<Change>; readonly phase: 'before' | 'after' },
  current: PlainData,
  fields: Readonly<Record<string, unknown>>,
): Judgement {
  const declared = operation.interceptable?.[phase] ?? [];
  const undeclared = Object.keys(fields).filter((field) => !declared.includes(field));
  if (undeclared.length > 0) return rejected(`Undeclared ${phase} field: ${undeclared.join(', ')}.`);
  if (typeof current !== 'object' || current === null || Array.isArray(current)) {
    return rejected('The value is not an object, so it cannot be patched.');
  }
  const merged = { ...current, ...fields };
  if (!isPlainData(merged)) return rejected('The patched value is not plain data.');
  const detached = detach(merged);
  const accepts = phase === 'before' ? operation.acceptsInput(detached) : operation.producesOutput(detached);
  return accepts
    ? { kind: 'accepted', value: detached, shortCircuit: false }
    : rejected(`The patched ${phase === 'before' ? 'input' : 'output'} is invalid.`);
}

function judgeShortCircuit<Change>(
  { operation, phase }: { readonly operation: AnyOperation<Change>; readonly phase: 'before' | 'after' },
  output: unknown,
): Judgement {
  if (phase !== 'before' || operation.interceptable?.shortCircuit !== true) {
    return rejected(`Operation ${operation.id} does not allow a short circuit here.`);
  }
  if (!isPlainData(output)) return rejected('The short-circuit output is not plain data.');
  const detached = detach(output);
  return operation.producesOutput(detached)
    ? { kind: 'accepted', value: detached, shortCircuit: true }
    : rejected('The short-circuit output is invalid.');
}

const detach = (value: PlainData): PlainData => JSON.parse(JSON.stringify(value)) as PlainData;

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
