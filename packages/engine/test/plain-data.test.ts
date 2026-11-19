import { StageOutcome, StreamSummarizer } from '@nodeint/migent-kernel';
import { describe, expect, it } from 'vitest';

import { isPlainData } from '../src/runtime/plain-data.js';

describe('plain data at runtime', () => {
  it('accepts JSON-shaped values that round-trip losslessly', () => {
    const values = [null, true, 0, 'x', [1, [2]], { a: { b: [null] } }, Object.create(null) as object];
    for (const value of values) {
      expect(isPlainData(value)).toBe(true);
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });

  it('rejects live objects, functions and values JSON would alter', () => {
    class Holder {
      public readonly value = 1;
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const rejected = [
      undefined,
      () => 1,
      new Holder(),
      new Date(),
      new Map(),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { fn: () => 1 },
      { missing: undefined },
      [undefined],
      cyclic,
      { [Symbol('s')]: 1 },
      new Array<number>(1),
      -0,
      Object.defineProperty(new Array<number>(1), 'keys', { value: () => [] }),
      Object.assign([1], { live: () => 1 }),
      Object.assign([1], { extra: 1 }),
      Object.defineProperty({}, 'toJSON', { value: () => 'changed' }),
      Object.defineProperty({}, 'hidden', { value: 1, enumerable: false }),
      Object.defineProperty({}, 'accessor', { get: () => 1, enumerable: true }),
      new StageOutcome('complete', {}),
      new StreamSummarizer(),
    ];
    for (const value of rejected) expect(isPlainData(value), String(value)).toBe(false);
  });

  it('never runs a method or accessor of the candidate while validating', () => {
    let calls = 0;
    const spy = (): never[] => {
      calls += 1;
      return [];
    };
    const hiddenKeys = Object.defineProperty(new Array<number>(1), 'keys', { value: spy });
    const getter = Object.defineProperty({}, 'value', { get: spy, enumerable: true });
    const iterator = Object.defineProperty([1], Symbol.iterator, { value: spy });
    for (const candidate of [hiddenKeys, getter, iterator]) expect(isPlainData(candidate)).toBe(false);
    expect(calls).toBe(0);
  });

  it('accepts a shared (non-cyclic) reference', () => {
    const shared = { n: 1 };
    expect(isPlainData({ a: shared, b: shared })).toBe(true);
  });
});
