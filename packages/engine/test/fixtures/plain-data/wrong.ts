import type { PlainData } from '../../../src/runtime/plain-data.ts';

// Deliberately wrong: this assertion is valid, so the expectation is unused and must fail the check.
// @ts-expect-error nothing is wrong on the next line
export const fine: PlainData = { ok: true };
