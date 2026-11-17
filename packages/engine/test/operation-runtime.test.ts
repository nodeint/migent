import { CancellationRequested } from '@nodeint/migent-kernel';
import { describe, expect, it, vi } from 'vitest';

import type { OperationOutcome } from '../src/runtime/operation.js';
import type { PlainData } from '../src/runtime/plain-data.js';
import { isPlainData } from '../src/runtime/plain-data.js';
import type { Policy, PolicyContext } from '../src/runtime/policy.js';
import { RuntimeError } from '../src/runtime/runtime-error.js';
import type { TraceEntry } from '../src/runtime/trace.js';
import type { Change } from './support-runtime.js';
import { definition, operation, recordingApplier, request, runtimeWith, SCOPE } from './support-runtime.js';

const OK = async (): Promise<{ kind: 'succeeded'; output: PlainData; changes: Change[] }> => ({
  kind: 'succeeded',
  output: { done: true },
  changes: [{ write: 'from-handler' }],
});

const ENDS = definition(
  [
    { from: 'alpha', outcome: 'succeeded', to: { kind: 'end' } },
    { from: 'alpha', outcome: 'failed', to: { kind: 'end' } },
    { from: 'alpha', outcome: 'denied', to: { kind: 'end' } },
  ],
  (outcome) => ({ kind: 'end', result: outcome.kind, changes: [{ write: `end:${outcome.kind}` }] }),
);

function run(runtime: ReturnType<typeof runtimeWith>, def = ENDS, first = request('alpha')) {
  return runtime.run({ scope: SCOPE, definition: def, state: { steps: 0 }, request: first });
}

describe('operation runtime', () => {
  it('rejects an unknown operation before invoking anything', async () => {
    const handler = vi.fn(OK);
    const applier = recordingApplier();
    const runtime = runtimeWith([operation('alpha', handler)], applier);
    await expect(run(runtime, ENDS, request('missing'))).rejects.toMatchObject({ code: 'unknown_operation' });
    expect(handler).not.toHaveBeenCalled();
    expect(applier.applied).toEqual([]);
  });

  it('rejects malformed input before invoking the handler or the policy', async () => {
    const handler = vi.fn(OK);
    const evaluate = vi.fn<Policy['evaluate']>(() => ({ kind: 'allow' }));
    const runtime = runtimeWith([operation('alpha', handler, { accepts: () => false })], recordingApplier(), { policy: { evaluate } });
    await expect(run(runtime)).rejects.toBeInstanceOf(RuntimeError);
    await expect(run(runtime)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(handler).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('rejects input that is not plain data', async () => {
    const runtime = runtimeWith([operation('alpha', OK)], recordingApplier());
    const live = { run: () => 1 } as unknown as PlainData;
    await expect(run(runtime, ENDS, request('alpha', live))).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it.each([
    ['a sparse array', new Array<number>(1)],
    ['a function on an array', Object.assign([1], { live: () => 1 })],
    ['a hidden toJSON', Object.defineProperty({}, 'toJSON', { value: () => 'changed' })],
    ['an accessor', Object.defineProperty({}, 'value', { get: () => 1, enumerable: true })],
    ['a sparse array with a hidden keys method', Object.defineProperty(new Array<number>(1), 'keys', { value: () => [] })],
    ['negative zero', -0],
  ])('stops %s in input before policy and handler', async (_name, bad) => {
    const handler = vi.fn(OK);
    const evaluate = vi.fn<Policy['evaluate']>(() => ({ kind: 'allow' }));
    const runtime = runtimeWith([operation('alpha', handler)], recordingApplier(), { policy: { evaluate } });
    await expect(run(runtime, ENDS, request('alpha', bad as PlainData))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(handler).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([
    ['a sparse array', new Array<number>(1)],
    ['a hidden toJSON', Object.defineProperty({}, 'toJSON', { value: () => 'changed' })],
    ['a sparse array with a hidden keys method', Object.defineProperty(new Array<number>(1), 'keys', { value: () => [] })],
    ['negative zero', -0],
  ])('stops %s in output before decide and apply', async (_name, bad) => {
    const applier = recordingApplier();
    const decide = vi.fn(ENDS.decide);
    const lossy = async (): Promise<{ kind: 'succeeded'; output: PlainData; changes: Change[] }> => ({
      kind: 'succeeded',
      output: bad as PlainData,
      changes: [],
    });
    const runtime = runtimeWith([operation('alpha', lossy)], applier);
    await expect(run(runtime, { ...ENDS, decide })).rejects.toMatchObject({ code: 'invalid_output' });
    expect(decide).not.toHaveBeenCalled();
    expect(applier.applied).toEqual([]);
  });

  it('rejects invalid output before any transition is applied', async () => {
    const applier = recordingApplier();
    const decide = vi.fn(ENDS.decide);
    const runtime = runtimeWith([operation('alpha', OK, { produces: () => false })], applier);
    await expect(run(runtime, { ...ENDS, decide })).rejects.toMatchObject({ code: 'invalid_output' });
    expect(decide).not.toHaveBeenCalled();
    expect(applier.applied).toEqual([]);
  });

  it('invokes an allowed request once and applies the changes', async () => {
    const handler = vi.fn(OK);
    const applier = recordingApplier();
    const result = await run(runtimeWith([operation('alpha', handler)], applier));
    expect(result).toBe('succeeded');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(applier.applied).toEqual([[{ write: 'end:succeeded' }]]);
  });

  it('denies without calling the handler and reports a distinct outcome', async () => {
    const handler = vi.fn(OK);
    const policy: Policy = { evaluate: () => ({ kind: 'deny', reason: 'not today' }) };
    const outcomes: OperationOutcome<PlainData, Change>[] = [];
    const def = definition(ENDS.edges, (outcome, current) => {
      outcomes.push(outcome);
      return ENDS.decide({ steps: 0 }, current, outcome);
    });
    expect(await run(runtimeWith([operation('alpha', handler)], recordingApplier(), { policy }), def)).toBe('denied');
    expect(handler).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ kind: 'denied', reason: 'not today' }]);
  });

  it('keeps a handler-reported failure distinct from denial', async () => {
    const failing = async (): Promise<{ kind: 'failed'; error: string; changes: Change[] }> => ({
      kind: 'failed',
      error: 'boom',
      changes: [],
    });
    expect(await run(runtimeWith([operation('alpha', failing)], recordingApplier()))).toBe('failed');
  });

  it('rejects an unauthorized edge and applies nothing', async () => {
    const applier = recordingApplier();
    const def = definition([{ from: 'alpha', outcome: 'succeeded', to: { kind: 'end' } }], () => ({
      kind: 'next',
      request: request('beta'),
      state: { steps: 1 },
      changes: [{ write: 'never' }],
    }));
    const runtime = runtimeWith([operation('alpha', OK), operation('beta', OK)], applier);
    await expect(run(runtime, def)).rejects.toMatchObject({ code: 'unauthorized_transition' });
    expect(applier.applied).toEqual([]);
  });

  it('rejects an edge declared for a different outcome kind', async () => {
    const policy: Policy = { evaluate: () => ({ kind: 'deny', reason: 'no' }) };
    const def = definition([{ from: 'alpha', outcome: 'succeeded', to: { kind: 'end' } }], () => ({
      kind: 'end',
      result: 'x',
      changes: [],
    }));
    const runtime = runtimeWith([operation('alpha', OK)], recordingApplier(), { policy });
    await expect(run(runtime, def)).rejects.toMatchObject({ code: 'unauthorized_transition' });
  });

  it('applies authorized next and end transitions in order', async () => {
    const applier = recordingApplier();
    const seen: string[] = [];
    const def = definition(
      [
        { from: 'alpha', outcome: 'succeeded', to: { kind: 'next', operationId: 'beta' } },
        { from: 'beta', outcome: 'succeeded', to: { kind: 'end' } },
      ],
      (_outcome, current) =>
        current.identity.operationId === 'alpha'
          ? { kind: 'next', request: request('beta', { n: 2 }, 2), state: { steps: 1 }, changes: [{ write: 'one' }, { write: 'two' }] }
          : { kind: 'end', result: 'finished', changes: [{ write: 'three' }] },
    );
    const runtime = runtimeWith(
      [operation('alpha', OK), operation('beta', async (input) => (seen.push(JSON.stringify(input)), OK()))],
      applier,
    );
    expect(await run(runtime, def)).toBe('finished');
    expect(applier.applied).toEqual([[{ write: 'one' }, { write: 'two' }], [{ write: 'three' }]]);
    expect(seen).toEqual(['{"n":2}']);
  });

  it('evaluates the policy once per request with detached context', async () => {
    const contexts: PolicyContext[] = [];
    const evaluate = vi.fn<Policy['evaluate']>((_request, context) => (contexts.push(context), { kind: 'allow' }));
    const def = definition(
      [
        { from: 'alpha', outcome: 'succeeded', to: { kind: 'next', operationId: 'beta' } },
        { from: 'beta', outcome: 'succeeded', to: { kind: 'end' } },
      ],
      (_outcome, current) =>
        current.identity.operationId === 'alpha'
          ? { kind: 'next', request: request('beta', { n: 1 }, 4), state: { steps: 1 }, changes: [] }
          : { kind: 'end', result: 'ok', changes: [] },
    );
    await run(runtimeWith([operation('alpha', OK), operation('beta', OK)], recordingApplier(), { policy: { evaluate } }), def);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(contexts).toEqual([
      { ...SCOPE, executionId: 'e1', operationId: 'alpha', attempt: 1 },
      { ...SCOPE, executionId: 'e1', operationId: 'beta', attempt: 4 },
    ]);
    expect(contexts.every((context) => isPlainData(context))).toBe(true);
  });

  it('propagates cancellation without applying changes', async () => {
    const applier = recordingApplier();
    const cancelling = async (): Promise<never> => {
      throw new CancellationRequested();
    };
    await expect(run(runtimeWith([operation('alpha', cancelling)], applier))).rejects.toBeInstanceOf(CancellationRequested);
    expect(applier.applied).toEqual([]);
  });

  it('applies changes synchronously: every write lands before the next invocation', async () => {
    const log: string[] = [];
    const applier = { apply: () => void log.push('apply') };
    const def = definition(
      [
        { from: 'alpha', outcome: 'succeeded', to: { kind: 'next', operationId: 'alpha' } },
        { from: 'alpha', outcome: 'succeeded', to: { kind: 'end' } },
      ],
      (outcome, current) =>
        current.identity.attempt < 2
          ? { kind: 'next', request: request('alpha', { n: 1 }, 2), state: { steps: 1 }, changes: [] }
          : { kind: 'end', result: outcome.kind, changes: [] },
    );
    const runtime = runtimeWith([operation('alpha', async () => (log.push('handle'), OK()))], applier);
    await run(runtime, def);
    expect(log).toEqual(['handle', 'apply', 'handle', 'apply']);
    expect(applier.apply([])).toBeUndefined();
  });
});

describe('decision trace', () => {
  const traceDefinition = definition(ENDS.edges, (outcome) => ({ kind: 'end', result: outcome.kind, changes: [] }));

  it('records request, policy verdict, outcome kind and transition under debug', async () => {
    vi.stubEnv('MIGENT_DEBUG', '1');
    try {
      const entries: TraceEntry[] = [];
      await run(runtimeWith([operation('alpha', OK)], recordingApplier(), { trace: { record: (entry) => void entries.push(entry) } }), traceDefinition);
      expect(entries.map((entry) => entry.kind)).toEqual(['request', 'policy', 'outcome', 'transition']);
      expect(entries[0]).toMatchObject({ operationId: 'alpha', executionId: 'e1', attempt: 1, invocationId: 'invocation-1' });
      expect(entries[1]).toMatchObject({ verdict: 'allow' });
      expect(entries[2]).toMatchObject({ outcome: 'succeeded' });
      expect(entries[3]).toMatchObject({ transition: 'end', nextOperationId: null });
      expect(entries.every((entry) => isPlainData(entry))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('records no decision trace when debug is off', async () => {
    vi.stubEnv('MIGENT_DEBUG', '');
    try {
      const record = vi.fn();
      await run(runtimeWith([operation('alpha', OK)], recordingApplier(), { trace: { record } }), traceDefinition);
      expect(record).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps invocation ids transient and distinct per request', async () => {
    vi.stubEnv('MIGENT_DEBUG', '1');
    try {
      const ids = new Set<string>();
      const sink = { record: (entry: TraceEntry) => void ids.add(entry.invocationId) };
      const runtime = runtimeWith([operation('alpha', OK)], recordingApplier(), { trace: sink });
      await run(runtime, traceDefinition);
      await run(runtime, traceDefinition);
      expect([...ids]).toEqual(['invocation-1', 'invocation-2']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
