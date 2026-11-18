import { SealedMetricsCurrent, validationIssues } from '@nodeint/migent-contracts';
import type { TurnUsage } from '@nodeint/migent-kernel';
import { buildMetrics, metricsPlugin } from '@nodeint/migent-plugins';
import { readSessionSnapshot, sessionMetrics } from '@nodeint/migent-session';
import { afterEach, expect, test } from 'vitest';

import {
  at, blank, CHECK, cumulative, event as fixtureEvent, type ExecInput, ONCE, PLAN, removeTempDirs, tempDir,
  turn as fixtureTurn,
  workspaceWith, writeSession as fixtureWrite,
} from './metrics-fixtures.ts';
import { FakeClient, registryOf } from './support.ts';

// P1 baseline: the plugin's pure builder equals the core producer byte for byte, while both still exist, on the
// scenarios of the engine `metrics.test.ts`. The real fake-client run is in
// `metrics-plugin-equivalence.integration.test.ts`. Both are retired with `sessionMetrics` in P3.

const event = (
  seq: number,
  name: string,
  executionId: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => fixtureEvent({ seq, name, executionId }, extra);

const turn = (
  seq: number,
  executionId: string,
  usage: Record<string, unknown> | null,
  provider = 'fake',
): Record<string, unknown> => fixtureTurn({ seq, executionId, usage, provider });

const writeSession = (
  workspace: string,
  sessionId: string,
  status: Record<string, unknown>,
  executions: ExecInput[],
  events: Record<string, unknown>[],
): void => { fixtureWrite(workspace, sessionId, { status, executions, events }); };

afterEach(removeTempDirs);

/** What `writeJsonAtomic` writes for the core seal. */
const serialized = (document: unknown): string => JSON.stringify(document, null, 2);

function expectEquivalent(
  workspace: string,
  sessionId: string,
  clients: ReturnType<typeof registryOf>,
): Record<string, unknown> {
  const expected = sessionMetrics(workspace, sessionId, clients);
  const actual = buildMetrics(sessionId, readSessionSnapshot(workspace, sessionId, clients));
  expect(serialized(actual)).toBe(serialized(expected));
  expect(validationIssues(SealedMetricsCurrent, actual)).toEqual([]);
  return actual;
}

const status = (workflow: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  workflow_id: workflow, workflow_path: `.migent/workflows/${workflow}.yaml`, status: 'completed', updated_at: at(1), ...over,
});

test('revision, routed_from, failed retry, verify and reset counters', () => {
  const workspace = workspaceWith('plan.yaml', PLAN);
  writeSession(workspace, 'revise', {
    ...status('plan'), session_id: 'revise', latest_decision: 'approved', task_sha256: 'task', prior_session_id: null,
    created_at: at(0), updated_at: at(40),
  }, [
    { id: '0001-plan--attempt-01', order: 1, stage: 'plan', status: 'completed', outcome: { status: 'complete' } },
    { id: '0002-review--attempt-01', order: 2, stage: 'review', status: 'completed', outcome: { status: 'complete', decision: 'revise' } },
    { id: '0003-plan--attempt-02', order: 3, stage: 'plan', status: 'failed', outcome: null },
    { id: '0004-plan--attempt-03', order: 4, stage: 'plan', status: 'completed', outcome: { status: 'complete' } },
    { id: '0005-review--attempt-02', order: 5, stage: 'review', status: 'completed', outcome: { status: 'complete', decision: 'approved' } },
  ], [event(1, 'session.created', null, { data: { hash: 'abc123' } }), event(2, 'revisions.reset', null)]);
  const metrics = expectEquivalent(workspace, 'revise', registryOf({ fake: new FakeClient() }));
  expect((metrics.totals as Record<string, unknown>).revisions).toBe(1);
});

test('fresh starts and expired resumes', () => {
  const workspace = workspaceWith('once.yaml', ONCE);
  writeSession(workspace, 'exp', { ...status('once'), session_id: 'exp', created_at: at(0), updated_at: at(10) }, [
    { id: '0001-plan--attempt-01', order: 1, stage: 'plan', status: 'completed' },
    { id: '0002-plan--attempt-02', order: 2, stage: 'plan', status: 'completed', resumeSkipped: { source_execution_id: '0001-plan--attempt-01', reason: 'expired' } },
  ], [
    event(1, 'resume.expired', null, { data: { stage_id: 'plan', source_execution_id: 'x', action: 'resume', origin: 'policy' } }),
    event(2, 'resume.expired', null, { data: { stage_id: 'plan', source_execution_id: 'y', action: 'fresh', origin: 'policy' } }),
    event(3, 'resume.decided', null, { data: { stage_id: 'plan', source_execution_id: 'z', choice: 'resume', origin: 'human' } }),
  ]);
  const metrics = expectEquivalent(workspace, 'exp', registryOf({ fake: new FakeClient() }));
  expect(metrics.totals).toMatchObject({ fresh_starts: 1, expired_resumes: 2 });
});

test('a failed attempt then a success is not a revision', () => {
  const workspace = workspaceWith('once.yaml', ONCE);
  writeSession(workspace, 'retry', status('once'), [
    { id: '0001-implement--attempt-01', order: 1, stage: 'implement', status: 'failed', outcome: null },
    { id: '0002-implement--attempt-02', order: 2, stage: 'implement', status: 'completed' },
  ], [event(1, 'session.created', null, { data: {} })]);
  expectEquivalent(workspace, 'retry', registryOf({}));
});

test('verify red then red then pass', () => {
  const workspace = workspaceWith('check.yaml', CHECK);
  const id = '0001-implement--attempt-01';
  writeSession(workspace, 'verify', status('check'), [
    { id, order: 1, stage: 'implement', status: 'completed', createdAt: at(0), completedAt: at(20) },
  ], [
    event(1, 'verify.started', id, { timestamp: at(0) }),
    event(2, 'verify.failed', id, { timestamp: at(2), details: { command: 'pnpm gate' } }),
    event(3, 'verify.started', id, { timestamp: at(2) }),
    event(4, 'verify.failed', id, { timestamp: at(3), details: { command: 'pnpm gate' } }),
    event(5, 'verify.started', id, { timestamp: at(3) }),
    event(6, 'verify.passed', id, { timestamp: at(5) }),
  ]);
  const metrics = expectEquivalent(workspace, 'verify', registryOf({}));
  expect((metrics.totals as Record<string, unknown>).verify_red).toBe(2);
});

test.each([
  { workflow: 'legacy', provider: 'codex', command: 'opencode' },
  { workflow: 'legacy', provider: 'byteplus', command: 'opencode' },
  { workflow: 'legacy', provider: 'codex', command: 'unknown' },
  { workflow: 'agent', provider: 'claude', command: 'claude' },
  { workflow: 'agent', provider: 'codex', command: 'opencode' },
])('legacy execution evidence: $workflow/$provider/$command', ({ workflow, provider, command }) => {
  const workspace = tempDir('migent-metrics-');
  const client = new FakeClient();
  client.readUsage = cumulative;
  writeSession(workspace, 'legacy', { workflow_id: workflow, status: 'completed', updated_at: at(2) }, [
    { id: '0001', order: 1, stage: 'agent', status: 'completed', client: null, provider },
  ], [turn(1, '0001', { total: 100 }, command)]);
  expectEquivalent(workspace, 'legacy', registryOf({ opencode: client, 'claude-code': client }));
});

test('a cumulative provider deltas across executions that share an agent', () => {
  const workspace = tempDir('migent-metrics-');
  const provider = new FakeClient();
  provider.readUsage = cumulative;
  writeSession(workspace, 'cost', { workflow_id: 'cost', status: 'completed', updated_at: at(2) }, [
    { id: '0001', order: 1, stage: 'agent', status: 'completed' },
    { id: '0002', order: 2, stage: 'agent', status: 'completed' },
  ], [turn(1, '0001', { total: 100 }), turn(2, '0002', { total: 140 })]);
  const metrics = expectEquivalent(workspace, 'cost', registryOf({ fake: provider }));
  expect((metrics.totals as { usage: TurnUsage }).usage.input_tokens).toBe(140);
});

test("a cancelled turn's spend is in the next delta", () => {
  const workspace = tempDir('migent-metrics-');
  const provider = new FakeClient();
  provider.readUsage = cumulative;
  writeSession(workspace, 'cancel', { workflow_id: 'cancel', status: 'completed', updated_at: at(2) }, [
    { id: '0001', order: 1, stage: 'agent', status: 'completed' },
    { id: '0002', order: 2, stage: 'agent', status: 'completed' },
  ], [turn(1, '0001', { total: 100 }), event(2, 'provider.cancelled', '0001'), turn(3, '0002', { total: 180 })]);
  const metrics = expectEquivalent(workspace, 'cancel', registryOf({ fake: provider }));
  expect(metrics.totals).toMatchObject({ uncaptured_turns: 1, turns: 2 });
});

test('cost totals keep the known sum and count the gap', () => {
  const workspace = tempDir('migent-metrics-');
  const priced = new FakeClient();
  priced.readUsage = () => ({ values: { ...blank(), input_tokens: 10, cost_usd: 1.5 }, cumulative: [] });
  const free = new FakeClient();
  free.readUsage = () => ({ values: { ...blank(), input_tokens: 4 }, cumulative: [] });
  writeSession(workspace, 'mix', { workflow_id: 'mix', status: 'completed', updated_at: at(2) }, [
    { id: '0001', order: 1, stage: 'agent', status: 'completed', client: 'priced' },
    { id: '0002', order: 2, stage: 'agent', status: 'completed', client: 'free' },
  ], [turn(1, '0001', { ok: true }, 'priced'), turn(2, '0002', { ok: true }, 'free')]);
  const metrics = expectEquivalent(workspace, 'mix', registryOf({ priced, free }));
  expect(metrics.totals).toMatchObject({ cost_partial: true });
});

test('a progress turn_failed does not count as a turn', () => {
  const workspace = tempDir('migent-metrics-');
  writeSession(workspace, 'dup', { workflow_id: 'dup', status: 'completed', updated_at: at(1) }, [
    { id: '0001', order: 1, stage: 'agent', status: 'completed' },
  ], [event(1, 'provider.turn_failed', '0001', { details: { summary: 'boom' } }), turn(2, '0001', null)]);
  const metrics = expectEquivalent(workspace, 'dup', registryOf({ fake: new FakeClient() }));
  expect(metrics.totals).toMatchObject({ turns: 1, uncaptured_turns: 1 });
});

test('a session recorded before usage captures still has a row', () => {
  const workspace = workspaceWith('once.yaml', ONCE);
  writeSession(workspace, 'old', { ...status('once'), created_at: at(0) }, [
    { id: '0001', order: 1, stage: 'implement', status: 'completed', createdAt: at(0), completedAt: at(10) },
  ], [event(1, 'provider.turn_completed', '0001')]);
  const metrics = expectEquivalent(workspace, 'old', registryOf({ fake: new FakeClient() }));
  expect(metrics.totals).toMatchObject({ turns: 1, wall_seconds: 10, usage: blank() });
});

test('a missing workflow leaves revisions null', () => {
  const workspace = tempDir('migent-metrics-');
  writeSession(workspace, 'gone', {
    workflow_id: 'plan', workflow_path: '.migent/workflows/missing.yaml', status: 'completed', updated_at: at(1),
  }, [
    { id: '0001', order: 1, stage: 'plan', status: 'completed', createdAt: at(0), completedAt: at(10) },
  ], [event(1, 'session.created', null, { data: { hash: 'abc' } })]);
  const metrics = expectEquivalent(workspace, 'gone', registryOf({}));
  expect((metrics.totals as Record<string, unknown>).revisions).toBeNull();
});

test('a running execution has no wall time', () => {
  const workspace = tempDir('migent-metrics-');
  writeSession(workspace, 'run', { workflow_id: 'run', status: 'active', updated_at: at(1) }, [
    { id: '0001', order: 1, stage: 'agent', status: 'running', createdAt: at(0), completedAt: null },
  ], []);
  const metrics = expectEquivalent(workspace, 'run', registryOf({}));
  expect(metrics.totals).toMatchObject({ wall_seconds: null, active_seconds: 0 });
});

test('mixed legacy CLI turns use their own parsers without inventing an execution client', () => {
  const workspace = tempDir('migent-metrics-mixed-');
  const codex = new FakeClient();
  const opencode = new FakeClient();
  codex.readUsage = (capture) => ({ values: { ...blank(), input_tokens: Number(capture.codex) }, cumulative: [] });
  opencode.readUsage = (capture) => ({
    values: { ...blank(), input_tokens: Number(capture.opencode) },
    cumulative: [],
  });
  writeSession(workspace, 'legacy', { workflow_id: 'legacy', status: 'active' }, [
    { id: '0001', order: 1, stage: 'work', status: 'failed', client: null, provider: 'codex' },
  ], [turn(1, '0001', { opencode: 10 }, 'opencode'), turn(2, '0001', { codex: 25 }, 'codex')]);
  const metrics = expectEquivalent(workspace, 'legacy', registryOf({ codex, opencode }));
  expect((metrics.executions as Record<string, unknown>[])[0]?.client).toBeNull();
});

test('the plugin is exported with the manifest the reader needs', () => {
  expect(metricsPlugin.manifest.id).toBe('metrics');
  expect(metricsPlugin.manifest.uses.artifacts[0]?.name).toBe('metrics.json');
});
