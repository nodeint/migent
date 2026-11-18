import { expect, test } from 'vitest';

import { buildVitestArgs } from './run-integration.mjs';

const base = ['run', '--project', 'integration'];

test('runs the whole integration project without selection', () => {
  expect(buildVitestArgs([])).toEqual(base);
});

test('maps repeated --file to positional filters', () => {
  expect(buildVitestArgs(['--file', 'cancel', '--file=session-delete'])).toEqual([
    ...base, 'cancel', 'session-delete',
  ]);
});

test('maps --case to -t after the file filters', () => {
  expect(buildVitestArgs(['--file', 'cancel', '--case', 'stops the run'])).toEqual([
    ...base, 'cancel', '-t', 'stops the run',
  ]);
});

test('drops the -- separator and passes other arguments through', () => {
  expect(buildVitestArgs(['--', '--file', 'cancel', '--reporter=verbose'])).toEqual([
    ...base, 'cancel', '--reporter=verbose',
  ]);
});

test.each([
  [['--file'], '--file requires a value'],
  [['--file', '--case', 'x'], '--file requires a value'],
  [['--case='], '--case requires a value'],
  [['--case', 'x'], '--case requires --file'],
  [['--file', 'a', '--case', 'x', '--case', 'y'], '--case may be given only once'],
])('rejects %j', (argv, message) => {
  expect(() => buildVitestArgs(argv)).toThrow(message);
});
