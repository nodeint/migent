import { DIAGNOSTICS_SCHEMA_VERSION as CONTRACT_VERSION, isValid, SessionDiagnostics, validationIssues } from '@nodeint/migent-contracts';
import { expect, test } from 'vitest';

import { buildTurnDiagnostics, DIAGNOSTICS_SCHEMA_VERSION } from '../src/turn-diagnostics.ts';

const resultState = {
  observed: { reply: { source: 'model' as const, bytes: 4, status_header: { state: 'absent' as const } }, artifact: { state: 'not-applicable' as const }, response_written: false, conversation_turns: 1 },
  gates: { outcome: { state: 'failed' as const, reason: 'no header' }, artifact: { state: 'not-evaluated' as const }, completion_outputs: { state: 'not-applicable' as const } },
  turn_verdict: 'failed' as const,
  reason: 'no header',
};
const facts = {
  exitCode: 1, signal: null, stderrTail: 'boom', stderrTotalBytes: 4, drain: 'closed' as const, stdoutBytes: 0, stdoutLines: 0,
  endpoint: 'local', executable: 'node', argCount: 2, cwd: '/tmp', spawnedAt: '2026-01-01T00:00:00.000+00:00', endedAt: '2026-01-01T00:00:01.000+00:00',
};

test('the schema version constant equals the contracts constant', () => {
  expect(DIAGNOSTICS_SCHEMA_VERSION).toBe(CONTRACT_VERSION);
});

test('a provider-error diagnostics document validates', () => {
  const input = { turn: 1, agentId: null, facts, classification: null, stream: null, resultState };
  const document = buildTurnDiagnostics(input);
  expect(validationIssues(SessionDiagnostics, document)).toEqual([]);
  expect(isValid(SessionDiagnostics, JSON.parse(JSON.stringify(document)))).toBe(true);
});

test('a start-failure diagnostics document validates', () => {
  const failure = {
    kind: 'start' as const, result: null, phase: 'spawn', code: 'ENOENT', errno: -2, syscall: 'spawn', path: 'x', message: 'no such file',
    stderrTail: '', exitCode: null, signal: null, stderrTotalBytes: 0, drain: 'closed' as const, endpoint: 'local', executable: 'x', argCount: 0,
    cwd: '/tmp', spawnedAt: facts.spawnedAt, failedAt: facts.endedAt,
  };
  const document = buildTurnDiagnostics({ turn: 1, agentId: 'a', failure: failure as never, classification: null, stream: null, resultState });
  expect(validationIssues(SessionDiagnostics, document)).toEqual([]);
});
