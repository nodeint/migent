import { expect, test } from 'vitest';

import { parseStageOutcome } from '../src/index.ts';

test('requires a declared decision on complete', () => {
  expect(() =>
    parseStageOutcome('status: complete\n\nApproved.', true, { decisionValues: ['approved', 'revise'] }),
  ).toThrow(/decision: approved\|revise/);
});

test('accepts a declared decision header', () => {
  const outcome = parseStageOutcome(
    'status: complete\ndecision: Approved\n\nlooks good',
    true,
    { decisionValues: ['approved', 'revise'] },
  );
  expect(outcome).not.toBeNull();
  expect(outcome?.status).toBe('complete');
  expect(outcome?.decision).toBe('approved');
});

test('rejects an undeclared decision value', () => {
  expect(() =>
    parseStageOutcome('status: complete\ndecision: ship-it\n\nnope', true, { decisionValues: ['approved', 'revise'] }),
  ).toThrow(/Invalid workflow stage decision/);
});

test('blocked responses do not require a decision', () => {
  const outcome = parseStageOutcome(
    'status: blocked\nblocker: missing contract\n\nstopped',
    true,
    { decisionValues: ['approved', 'revise'] },
  );
  expect(outcome?.status).toBe('blocked');
  expect(outcome?.decision).toBeNull();
});
