import { describe, expect, it, vi } from 'vitest';

import type { InterceptionCall, InterceptorChain, InterceptPhase, InterceptProposal } from '../src/runtime/interception.js';
import type { Interceptable } from '../src/runtime/operation.js';
import type { PlainData } from '../src/runtime/plain-data.js';
import type { Change } from './support-runtime.js';
import { definition, operation, recordingApplier, request, runtimeWith, SCOPE } from './support-runtime.js';

type Step = { readonly phase: InterceptPhase; readonly propose: (seen: PlainData) => InterceptProposal };

/** A fake chain: each step proposes against the value it sees, and the runtime judges it. */
function chainOf(steps: readonly Step[], log: string[] = []): InterceptorChain {
  return {
    has: (_operationId, phase) => steps.some((step) => step.phase === phase),
    run: async (call: InterceptionCall) => {
      let { value } = call;
      for (const step of steps.filter((entry) => entry.phase === call.phase)) {
        const verdict = call.judge(value, step.propose(value));
        log.push(`${call.phase}:${verdict.kind}`);
        if (verdict.kind === 'rejected') continue;
        value = verdict.value;
        if (verdict.shortCircuit) return { value, shortCircuit: true };
      }
      return { value, shortCircuit: false };
    },
  };
}

const patch = (fields: Record<string, unknown>): InterceptProposal => ({ kind: 'patch', fields });
const ENDS = definition(
  [{ from: 'alpha', outcome: 'succeeded', to: { kind: 'end' } }],
  (outcome) => ({ kind: 'end', result: JSON.stringify(outcome), changes: [{ write: 'end' }] }),
);
const FROM_HANDLER: Change = { write: 'from-handler' };
const HANDLED = (seen: PlainData[]) => async (input: PlainData) => {
  seen.push(input);
  return { kind: 'succeeded' as const, output: { text: 'handled' }, changes: [FROM_HANDLER] };
};

function runWith(
  interceptable: Interceptable | undefined,
  chain: InterceptorChain | undefined,
  options: { accepts?: (input: PlainData) => boolean; produces?: (output: PlainData) => boolean } = {},
) {
  const seen: PlainData[] = [];
  const applier = recordingApplier();
  const base = operation('alpha', HANDLED(seen), options);
  const runtime = runtimeWith([interceptable === undefined ? base : { ...base, interceptable }], applier, {
    ...(chain === undefined ? {} : { interceptors: chain }),
  });
  const result = runtime.run({ scope: SCOPE, definition: ENDS, state: { steps: 0 }, request: request('alpha', { prompt: 'p', n: 1 }) });
  return { seen, applier, result };
}

describe('operation interception', () => {
  it('runs interceptors in order and shows each the previous accepted value', async () => {
    const saw: PlainData[] = [];
    const chain = chainOf([
      { phase: 'before', propose: (seen) => { saw.push(seen); return patch({ prompt: 'one' }); } },
      { phase: 'before', propose: (seen) => { saw.push(seen); return patch({ prompt: 'two' }); } },
    ]);
    const { seen, result } = runWith({ before: ['prompt'] }, chain);
    await result;
    expect(saw).toEqual([{ prompt: 'p', n: 1 }, { prompt: 'one', n: 1 }]);
    expect(seen).toEqual([{ prompt: 'two', n: 1 }]);
  });

  it('rejects an undeclared field and leaves the value unchanged', async () => {
    const log: string[] = [];
    const { seen, result } = runWith({ before: ['prompt'] }, chainOf([{ phase: 'before', propose: () => patch({ n: 2 }) }], log));
    await result;
    expect(log).toEqual(['before:rejected']);
    expect(seen).toEqual([{ prompt: 'p', n: 1 }]);
  });

  it('rejects a patch when the operation declares nothing', async () => {
    const { seen, result } = runWith(undefined, chainOf([{ phase: 'before', propose: () => patch({ prompt: 'x' }) }]));
    await result;
    expect(seen).toEqual([{ prompt: 'p', n: 1 }]);
  });

  it('rejects a patch that fails the input check', async () => {
    const log: string[] = [];
    const accepts = (input: PlainData): boolean => typeof (input as { prompt?: unknown }).prompt === 'string';
    const { seen, result } = runWith(
      { before: ['prompt'] },
      chainOf([{ phase: 'before', propose: () => patch({ prompt: 5 }) }], log),
      { accepts },
    );
    await result;
    expect(log).toEqual(['before:rejected']);
    expect(seen).toEqual([{ prompt: 'p', n: 1 }]);
  });

  it('skips the handler on a short circuit and still runs the after chain', async () => {
    const log: string[] = [];
    const chain = chainOf([
      { phase: 'before', propose: () => ({ kind: 'short_circuit', output: { text: 'supplied' } }) },
      { phase: 'after', propose: () => patch({ text: 'after' }) },
    ], log);
    const { seen, applier, result } = runWith({ shortCircuit: true, after: ['text'] }, chain);
    expect(JSON.parse(await result)).toMatchObject({ kind: 'succeeded', output: { text: 'after' }, changes: [] });
    expect(seen).toEqual([]);
    expect(log).toEqual(['before:accepted', 'after:accepted']);
    expect(applier.applied).toEqual([[{ write: 'end' }]]);
  });

  it('rejects a short circuit the operation did not declare', async () => {
    const { seen, result } = runWith(
      { before: ['prompt'] },
      chainOf([{ phase: 'before', propose: () => ({ kind: 'short_circuit', output: { text: 'x' } }) }]),
    );
    await result;
    expect(seen).toHaveLength(1);
  });

  it('applies an after patch and keeps the handler changes', async () => {
    const { applier, result } = runWith({ after: ['text'] }, chainOf([{ phase: 'after', propose: () => patch({ text: 'patched' }) }]));
    expect(JSON.parse(await result)).toMatchObject({ output: { text: 'patched' }, changes: [{ write: 'from-handler' }] });
    expect(applier.applied).toEqual([[{ write: 'end' }]]);
  });

  it('makes no chain call and adds no await without interceptors', async () => {
    const run = vi.fn();
    const chain: InterceptorChain = { has: () => false, run };
    const withChain = runWith({ before: ['prompt'] }, chain);
    const without = runWith({ before: ['prompt'] }, undefined);
    expect(await withChain.result).toBe(await without.result);
    expect(run).not.toHaveBeenCalled();
    expect(withChain.seen).toEqual(without.seen);
  });

  it('keeps the original handler scheduling when no phase has registrations', async () => {
    const turns = async (chain: InterceptorChain | undefined): Promise<number> => {
      const { result } = runWith({ before: ['prompt'] }, chain);
      let count = 0;
      let done = false;
      void result.then(() => { done = true; });
      while (!done) { await Promise.resolve(); count += 1; }
      return count;
    };
    const none: InterceptorChain = { has: () => false, run: vi.fn() };
    expect(await turns(none)).toBe(await turns(undefined));
  });

  describe.each(['before', 'after'] as const)('a failing %s chain', (phase) => {
    const failures: readonly [string, () => Promise<never>][] = [
      ['throw', () => Promise.reject(new Error('boom'))],
    ];
    it.each(failures)('on %s propagates as an infrastructure error and applies nothing', async (_name, fail) => {
      const chain: InterceptorChain = { has: (_id, p) => p === phase, run: fail };
      const { applier, result } = runWith({ before: ['prompt'], after: ['text'] }, chain);
      await expect(result).rejects.toThrow('boom');
      expect(applier.applied).toEqual([]);
    });
  });

  it.each(['before', 'after'] as const)('a recovered %s failure still applies the handler changes once', async (phase) => {
    const chain: InterceptorChain = {
      has: (_id, p) => p === phase,
      run: async (call) => ({ value: call.value, shortCircuit: false }),
    };
    const { seen, applier, result } = runWith({ before: ['prompt'], after: ['text'] }, chain);
    expect(JSON.parse(await result)).toMatchObject({ kind: 'succeeded', output: { text: 'handled' }, changes: [FROM_HANDLER] });
    expect(seen).toEqual([{ prompt: 'p', n: 1 }]);
    expect(applier.applied).toEqual([[{ write: 'end' }]]);
  });
});
