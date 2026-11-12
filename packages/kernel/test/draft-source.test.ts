import { expect, test } from 'vitest';

import { buildDraftSourceMap } from '../src/index.ts';

test('a value and its key have their own ranges', () => {
  const text = 'id: build\nstages:\n  - id: a\n    role: developer\n';
  const map = buildDraftSourceMap(text);
  expect(map.rangeOf(['id'])).toEqual({ start: { line: 1, column: 5 }, end: { line: 1, column: 10 } });
  expect(map.keyRangeOf(['id'])).toEqual({ start: { line: 1, column: 1 }, end: { line: 1, column: 3 } });
  expect(map.rangeOf(['stages', 0, 'role'])).toEqual({
    start: { line: 4, column: 11 },
    end: { line: 4, column: 20 },
  });
});

test('a missing key has no range rather than a guessed ancestor', () => {
  const map = buildDraftSourceMap('stages:\n  - id: a\n');
  expect(map.rangeOf(['stages', 0, 'role'])).toBeNull();
  expect(map.rangeOf(['stages', 4])).toBeNull();
  expect(map.rangeOf(['nope'])).toBeNull();
});

test('JSON drafts resolve the same paths', () => {
  const map = buildDraftSourceMap('{"schema_version": 4,\n "id": "build"}');
  expect(map.rangeOf(['id'])).toEqual({ start: { line: 2, column: 8 }, end: { line: 2, column: 15 } });
});

test('text that does not parse has no ranges', () => {
  const map = buildDraftSourceMap('a: [\n');
  expect(map.rangeOf(['a'])).toBeNull();
});
