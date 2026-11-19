import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { SealedMetricsCurrent, validationIssues } from '@nodeint/migent-contracts';
import { AgentToolRunner, executeNamedWorkflow } from '@nodeint/migent-engine';
import type { ClientRegistry, TurnUsage, UsageCapture } from '@nodeint/migent-kernel';
import { buildMetrics, createPluginRegistry, METRICS_ARTIFACT_NAME, METRICS_PLUGIN_ID } from '@nodeint/migent-plugins';
import { createAgentSession, readSessionSnapshot, SessionLock } from '@nodeint/migent-session';
import { afterEach, expect, onTestFinished, test } from 'vitest';

import { removeTempDirs, tempDir } from './metrics-fixtures.ts';
import { FakeClient, registryOf, ScriptedClient } from './support.ts';

afterEach(removeTempDirs);

/** The metrics document the plugin builds for a session, from the same snapshot the host hands it. */
function metricsOf(workspace: string, sessionId: string, clients: ClientRegistry): Record<string, unknown> {
  const snapshot = readSessionSnapshot(workspace, sessionId, clients);
  const document = buildMetrics(sessionId, snapshot);
  expect(validationIssues(SealedMetricsCurrent, document)).toEqual([]);
  return document;
}

/** Where the metrics plugin writes the file. */
function sealedMetricsPath(workspace: string, sessionId: string): string {
  return path.join(workspace, '.migent', 'sessions', sessionId, 'plugins', METRICS_PLUGIN_ID, METRICS_ARTIFACT_NAME);
}

/** A runner that runs the first-party plugins, as the CLI composition root does. */
function runnerOf(clients: ClientRegistry): AgentToolRunner {
  return Object.assign(new AgentToolRunner(clients, 10), { pluginRegistry: createPluginRegistry() });
}

const PLAN = `\
id: plan
stages:
  - id: plan
    role: planner
    max_revisions: 3
    depends_on: []
    produces:
      artifact: plan.md
  - id: review
    role: reviewer
    depends_on:
      - plan
    decision:
      values:
        - approved
        - revise
      routes:
        approved: complete
        revise: plan
completion:
  stage: review
  decision: approved
  outputs:
    - name: plan
      from_stage: plan
      artifact: plan.md
`;

const ONCE = `\
id: once
stages:
  - id: implement
    role: developer
    depends_on: []
    produces:
      artifact: notes.md
completion:
  stage: implement
`;

const CHECK = `\
id: check
stages:
  - id: implement
    role: developer
    depends_on: []
    produces:
      artifact: notes.md
    verify:
      - pnpm gate
completion:
  stage: implement
`;

function at(second: number): string {
  return `2026-10-20T00:00:${String(second).padStart(2, '0')}.000+00:00`;
}

function blank(): TurnUsage {
  return {
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_usd: null,
  };
}

function cumulative(current: UsageCapture): { values: TurnUsage; cumulative: string[] } {
  const total = typeof current.total === 'number' ? current.total : 0;
  return { values: { ...blank(), input_tokens: total }, cumulative: ['input_tokens'] };
}

interface ExecInput {
  id: string;
  order: number;
  stage: string;
  status: string;
  client?: string | null;
  provider?: string;
  createdAt?: string;
  completedAt?: string | null;
  outcome?: Record<string, unknown> | null;
  resumeSkipped?: Record<string, unknown>;
}

function writeSession(
  workspace: string,
  sessionId: string,
  status: Record<string, unknown>,
  executions: ExecInput[],
  events: Record<string, unknown>[],
): void {
  const sessionDirectory = path.join(workspace, '.migent', 'sessions', sessionId);
  mkdirSync(path.join(sessionDirectory, 'executions'), { recursive: true });
  writeFileSync(path.join(sessionDirectory, 'status.json'), JSON.stringify(status));
  const lines = events.map((event) => JSON.stringify(event));
  writeFileSync(path.join(sessionDirectory, 'events.jsonl'), lines.length === 0 ? '' : `${lines.join('\n')}\n`);
  for (const execution of executions) {
    const directory = path.join(sessionDirectory, 'executions', execution.id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'execution.json'),
      JSON.stringify({
        execution_id: execution.id,
        execution_order: execution.order,
        stage_id: execution.stage,
        stage_attempt: execution.order,
        client: execution.client === null ? undefined : execution.client ?? execution.provider ?? 'fake',
        provider: execution.provider ?? null,
        model: 'm1',
        agent_id: 'agent-1',
        resumes_execution_id: null,
        status: execution.status,
        created_at: execution.createdAt ?? at(0),
        completed_at: execution.completedAt === undefined ? at(10) : execution.completedAt,
        outcome: execution.outcome === undefined ? { status: 'complete' } : execution.outcome,
        error: null,
        failure_reason: null,
        ...(execution.resumeSkipped ? { resume_skipped: execution.resumeSkipped } : {}),
      }),
    );
  }
}

function event(
  seq: number,
  name: string,
  executionId: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 2,
    seq,
    event: name,
    timestamp: at(0),
    ...(executionId === null ? {} : { execution_id: executionId }),
    provider: 'fake',
    data: {},
    ...extra,
  };
}

function turn(
  seq: number,
  executionId: string,
  usage: Record<string, unknown> | null,
  provider = 'fake',
  agentId = 'agent-1',
): Record<string, unknown> {
  const details: Record<string, unknown> = { turn: 1, agent_id: agentId, argv: [provider] };
  if (usage !== null) details.usage = usage;
  return event(seq, 'provider.turn_completed', executionId, { provider, details });
}

function workspaceWith(name: string, text: string): string {
  const workspace = tempDir('migent-metrics-');
  const workflows = path.join(workspace, '.migent', 'workflows');
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workflows, name), text, 'utf8');
  return workspace;
}

test('counts a revision and keeps routed_from across a failed retry', () => {
  const workspace = workspaceWith('plan.yaml', PLAN);
  const sessionId = 'revise';
  writeSession(
    workspace,
    sessionId,
    {
      session_id: sessionId,
      workflow_id: 'plan',
      workflow_path: '.migent/workflows/plan.yaml',
      status: 'completed',
      latest_decision: 'approved',
      task_sha256: 'task',
      prior_session_id: null,
      created_at: at(0),
      updated_at: at(40),
    },
    [
      { id: '0001-plan--attempt-01', order: 1, stage: 'plan', status: 'completed', outcome: { status: 'complete' } },
      {
        id: '0002-review--attempt-01',
        order: 2,
        stage: 'review',
        status: 'completed',
        outcome: { status: 'complete', decision: 'revise' },
      },
      { id: '0003-plan--attempt-02', order: 3, stage: 'plan', status: 'failed', outcome: null },
      { id: '0004-plan--attempt-03', order: 4, stage: 'plan', status: 'completed', outcome: { status: 'complete' } },
      {
        id: '0005-review--attempt-02',
        order: 5,
        stage: 'review',
        status: 'completed',
        outcome: { status: 'complete', decision: 'approved' },
      },
    ],
    [
      event(1, 'session.created', null, { data: { hash: 'abc123' } }),
      event(2, 'revisions.reset', null),
    ],
  );
  const metrics = metricsOf(workspace, sessionId, registryOf({ fake: new FakeClient() }));
  const stages = metrics.stages as Record<string, Record<string, unknown>>;
  const executions = metrics.executions as Record<string, unknown>[];
  expect(Object.keys(stages)).toEqual(['plan', 'review']);
  expect(stages.plan).toMatchObject({ executions: 3, revisions: 1, failed: 1, blocked: 0 });
  expect(stages.review).toMatchObject({ executions: 2, revisions: 0, failed: 0 });
  expect(executions[2]?.routed_from).toBe('0002-review--attempt-01');
  expect(executions[3]?.routed_from).toBe('0002-review--attempt-01');
  expect(executions[0]?.routed_from).toBeNull();
  expect(executions[0]?.role).toBe('planner');
  expect(executions[1]?.role).toBe('reviewer');
  expect((metrics.totals as Record<string, unknown>).revisions).toBe(1);
  expect((metrics.totals as Record<string, unknown>).revisions_reset).toBe(1);
  expect(metrics.workflow_hash).toBe('abc123');
});

test('counts fresh starts and expired resumes, and a session without them reports zero', () => {
  const workspace = workspaceWith('once.yaml', ONCE);
  const status = { session_id: 'exp', workflow_id: 'once', workflow_path: '.migent/workflows/once.yaml', status: 'completed', created_at: at(0), updated_at: at(10) };
  writeSession(workspace, 'exp', status, [
    { id: '0001-plan--attempt-01', order: 1, stage: 'plan', status: 'completed' },
    { id: '0002-plan--attempt-02', order: 2, stage: 'plan', status: 'completed', resumeSkipped: { source_execution_id: '0001-plan--attempt-01', reason: 'expired' } },
  ], [
    event(1, 'resume.expired', null, { data: { stage_id: 'plan', source_execution_id: 'x', action: 'resume', origin: 'policy' } }),
    event(2, 'resume.expired', null, { data: { stage_id: 'plan', source_execution_id: 'y', action: 'fresh', origin: 'policy' } }),
    event(3, 'resume.decided', null, { data: { stage_id: 'plan', source_execution_id: 'z', choice: 'resume', origin: 'human' } }),
  ]);
  const metrics = metricsOf(workspace, 'exp', registryOf({ fake: new FakeClient() }));
  expect(metrics.totals).toMatchObject({ fresh_starts: 1, expired_resumes: 2 });
  const executions = metrics.executions as Record<string, unknown>[];
  expect(executions.map((item) => item.fresh_reason)).toEqual([null, 'expired']);
});

test('a failed attempt then a success is not a revision', () => {
  const workspace = workspaceWith('once.yaml', ONCE);
  writeSession(
    workspace,
    'retry',
    { workflow_id: 'once', workflow_path: '.migent/workflows/once.yaml', status: 'completed', updated_at: at(1) },
    [
      { id: '0001-implement--attempt-01', order: 1, stage: 'implement', status: 'failed', outcome: null },
      { id: '0002-implement--attempt-02', order: 2, stage: 'implement', status: 'completed' },
    ],
    [event(1, 'session.created', null, { data: {} })],
  );
  const metrics = metricsOf(workspace, 'retry', registryOf({}));
  const stage = (metrics.stages as Record<string, Record<string, unknown>>).implement;
  expect(stage).toMatchObject({ failed: 1, revisions: 0, executions: 2 });
});

test('verify red then red then pass', () => {
  const workspace = workspaceWith('check.yaml', CHECK);
  const executionId = '0001-implement--attempt-01';
  writeSession(
    workspace,
    'verify',
    { workflow_id: 'check', workflow_path: '.migent/workflows/check.yaml', status: 'completed', updated_at: at(1) },
    [{ id: executionId, order: 1, stage: 'implement', status: 'completed', createdAt: at(0), completedAt: at(20) }],
    [
      event(1, 'verify.started', executionId, { timestamp: at(0) }),
      event(2, 'verify.failed', executionId, { timestamp: at(2), details: { command: 'pnpm gate' } }),
      event(3, 'verify.started', executionId, { timestamp: at(2) }),
      event(4, 'verify.failed', executionId, { timestamp: at(3), details: { command: 'pnpm gate' } }),
      event(5, 'verify.started', executionId, { timestamp: at(3) }),
      event(6, 'verify.passed', executionId, { timestamp: at(5) }),
    ],
  );
  const metrics = metricsOf(workspace, 'verify', registryOf({}));
  const [execution] = (metrics.executions as Record<string, unknown>[]);
  expect(execution?.verify).toEqual({
    runs: 3,
    red: 2,
    first_pass: false,
    failed_commands: ['pnpm gate', 'pnpm gate'],
  });
  expect(execution?.verify_seconds).toBe(5);
  expect((metrics.totals as Record<string, unknown>).verify_seconds).toBe(5);
  expect((metrics.totals as Record<string, unknown>).verify_red).toBe(2);
});

test.each([
  { workflow: 'legacy', provider: 'codex', command: 'opencode', expected: 'opencode' },
  { workflow: 'legacy', provider: 'byteplus', command: 'opencode', expected: 'opencode' },
  { workflow: 'agent', provider: 'claude', command: 'claude', expected: 'claude-code' },
  { workflow: 'agent', provider: 'codex', command: 'opencode', expected: null },
  { workflow: 'legacy', provider: 'codex', command: 'unknown', expected: null },
])('legacy metrics use execution evidence: $workflow/$provider/$command', ({ workflow, provider, command, expected }) => {
  const workspace = tempDir('migent-metrics-');
  const client = new FakeClient();
  client.readUsage = cumulative;
  writeSession(
    workspace,
    'legacy',
    { workflow_id: workflow, status: 'completed', updated_at: at(2) },
    [{ id: '0001', order: 1, stage: 'agent', status: 'completed', client: null, provider }],
    [turn(1, '0001', { total: 100 }, command)],
  );
  const metrics = metricsOf(workspace, 'legacy', registryOf({ opencode: client, 'claude-code': client }));
  const execution = (metrics.executions as Record<string, unknown>[])[0]!;
  expect(execution.client).toBe(expected);
  const parsed = command === 'unknown' ? null : 100;
  expect((execution.usage as TurnUsage).input_tokens).toBe(parsed);
  expect(execution.uncaptured_turns).toBe(command === 'unknown' ? 1 : 0);
});

test('a cumulative provider deltas across executions that share an agent', () => {
  const workspace = tempDir('migent-metrics-');
  const provider = new FakeClient();
  provider.readUsage = cumulative;
  writeSession(
    workspace,
    'cost',
    { workflow_id: 'agent', status: 'completed', updated_at: at(2), role: 'developer' },
    [
      { id: '0001', order: 1, stage: 'agent', status: 'completed' },
      { id: '0002', order: 2, stage: 'agent', status: 'completed' },
    ],
    [turn(1, '0001', { total: 100 }), turn(2, '0002', { total: 140 })],
  );
  const metrics = metricsOf(workspace, 'cost', registryOf({ fake: provider }));
  const executions = metrics.executions as Record<string, unknown>[];
  expect((executions[0]?.usage as TurnUsage).input_tokens).toBe(100);
  expect((executions[1]?.usage as TurnUsage).input_tokens).toBe(40);
  expect((metrics.totals as { usage: TurnUsage }).usage.input_tokens).toBe(140);
  // The plugin builds from the snapshot, which has no agent-session role; role stays null.
  expect(executions[0]?.role).toBeNull();
});

test("a cancelled turn's spend is in the next delta", () => {
  const workspace = tempDir('migent-metrics-');
  const provider = new FakeClient();
  provider.readUsage = cumulative;
  writeSession(
    workspace,
    'cancel',
    { workflow_id: 'agent', status: 'completed', updated_at: at(2) },
    [
      { id: '0001', order: 1, stage: 'agent', status: 'completed' },
      { id: '0002', order: 2, stage: 'agent', status: 'completed' },
    ],
    [
      turn(1, '0001', { total: 100 }),
      event(2, 'provider.cancelled', '0001'),
      turn(3, '0002', { total: 180 }),
    ],
  );
  const metrics = metricsOf(workspace, 'cancel', registryOf({ fake: provider }));
  const executions = metrics.executions as Record<string, unknown>[];
  const totals = metrics.totals as Record<string, unknown>;
  expect((executions[1]?.usage as TurnUsage).input_tokens).toBe(80);
  expect(executions[0]?.uncaptured_turns).toBe(1);
  expect(totals.uncaptured_turns).toBe(1);
  expect(totals.turns).toBe(2);
});

test('cost totals keep the known sum and count the gap', () => {
  const workspace = tempDir('migent-metrics-');
  const priced = new FakeClient();
  priced.readUsage = () => ({ values: { ...blank(), input_tokens: 10, cost_usd: 1.5 }, cumulative: [] });
  const free = new FakeClient();
  free.readUsage = () => ({ values: { ...blank(), input_tokens: 4 }, cumulative: [] });
  writeSession(
    workspace,
    'mix',
    { workflow_id: 'agent', status: 'completed', updated_at: at(2) },
    [
      { id: '0001', order: 1, stage: 'agent', status: 'completed', client: 'priced' },
      { id: '0002', order: 2, stage: 'agent', status: 'completed', client: 'free' },
    ],
    [turn(1, '0001', { ok: true }, 'priced'), turn(2, '0002', { ok: true }, 'free')],
  );
  const totals = metricsOf(workspace, 'mix', registryOf({ priced, free })).totals as {
    usage: TurnUsage;
    usage_missing: Record<string, number>;
    cost_partial: boolean;
  };
  expect(totals.cost_partial).toBe(true);
  expect(totals.usage.cost_usd).toBe(1.5);
  expect(totals.usage.input_tokens).toBe(14);
  expect(totals.usage_missing.cost_usd).toBe(1);
  expect(totals.usage_missing.input_tokens).toBe(0);
});

test('a progress turn_failed does not count as a turn', () => {
  const workspace = tempDir('migent-metrics-');
  writeSession(
    workspace,
    'dup',
    { workflow_id: 'agent', status: 'completed', updated_at: at(1) },
    [{ id: '0001', order: 1, stage: 'agent', status: 'completed' }],
    [
      event(1, 'provider.turn_failed', '0001', { details: { summary: 'boom' } }),
      turn(2, '0001', null),
    ],
  );
  const totals = metricsOf(workspace, 'dup', registryOf({ fake: new FakeClient() })).totals as Record<string, unknown>;
  expect(totals.turns).toBe(1);
  expect(totals.uncaptured_turns).toBe(1);
});

test('a session recorded before usage captures still has a row', () => {
  const workspace = workspaceWith('once.yaml', ONCE);
  writeSession(
    workspace,
    'old',
    {
      workflow_id: 'once',
      workflow_path: '.migent/workflows/once.yaml',
      status: 'completed',
      updated_at: at(1),
      created_at: at(0),
    },
    [{ id: '0001', order: 1, stage: 'implement', status: 'completed', createdAt: at(0), completedAt: at(10) }],
    [event(1, 'provider.turn_completed', '0001')],
  );
  const metrics = metricsOf(workspace, 'old', registryOf({ fake: new FakeClient() }));
  const totals = metrics.totals as {
    turns: number;
    wall_seconds: number;
    usage: TurnUsage;
    usage_missing: Record<string, number>;
  };
  expect(totals.turns).toBe(1);
  expect(totals.wall_seconds).toBe(10);
  expect(totals.usage).toEqual(blank());
  expect(totals.usage_missing).toEqual({
    input_tokens: 1,
    output_tokens: 1,
    reasoning_tokens: 1,
    cache_read_tokens: 1,
    cache_write_tokens: 1,
    cost_usd: 1,
  });
  expect(metrics).toHaveProperty('executions');
  expect(metrics).toHaveProperty('stages');
  expect((metrics.totals as Record<string, unknown>).revisions).toBe(0);
});

test('a missing workflow leaves revisions null', () => {
  const workspace = tempDir('migent-metrics-');
  writeSession(
    workspace,
    'gone',
    { workflow_id: 'plan', workflow_path: '.migent/workflows/missing.yaml', status: 'completed', updated_at: at(1) },
    [{ id: '0001', order: 1, stage: 'plan', status: 'completed', createdAt: at(0), completedAt: at(10) }],
    [event(1, 'session.created', null, { data: { hash: 'abc' } })],
  );
  const metrics = metricsOf(workspace, 'gone', registryOf({}));
  expect(metrics.workflow_id).toBe('plan');
  expect((metrics.totals as Record<string, unknown>).revisions).toBeNull();
  expect((metrics.stages as Record<string, Record<string, unknown>>).plan?.revisions).toBeNull();
  expect((metrics.executions as Record<string, unknown>[])[0]?.role).toBeNull();
  expect((metrics.totals as Record<string, unknown>).wall_seconds).toBe(10);
});

test('a running execution has no wall time', () => {
  const workspace = tempDir('migent-metrics-');
  writeSession(
    workspace,
    'run',
    { workflow_id: 'agent', status: 'active', updated_at: at(1) },
    [{ id: '0001', order: 1, stage: 'agent', status: 'running', createdAt: at(0), completedAt: null }],
    [],
  );
  const metrics = metricsOf(workspace, 'run', registryOf({}));
  const [execution] = (metrics.executions as Record<string, unknown>[]);
  expect(execution?.completed_at).toBeNull();
  expect(execution?.wall_seconds).toBeNull();
  expect((metrics.totals as Record<string, unknown>).wall_seconds).toBeNull();
  expect((metrics.totals as Record<string, unknown>).active_seconds).toBe(0);
});

test('corrupt sessions are detected from the snapshot', () => {
  const workspace = tempDir('migent-metrics-');
  const sessions = path.join(workspace, '.migent', 'sessions');
  mkdirSync(path.join(sessions, 'broken'), { recursive: true });
  writeFileSync(path.join(sessions, 'broken', 'status.json'), '{');
  writeFileSync(path.join(sessions, 'broken', 'events.jsonl'), `${JSON.stringify(event(1, 'session.created', null))}\n`);
  const badExecution = path.join(sessions, 'bad-exec');
  mkdirSync(path.join(badExecution, 'executions', '0001'), { recursive: true });
  writeFileSync(
    path.join(badExecution, 'status.json'),
    JSON.stringify({ workflow_id: 'agent', status: 'completed', updated_at: at(3) }),
  );
  writeFileSync(path.join(badExecution, 'events.jsonl'), '');
  writeFileSync(path.join(badExecution, 'executions', '0001', 'execution.json'), 'not-json');
  mkdirSync(path.join(sessions, 'nostatus'), { recursive: true });
  writeFileSync(path.join(sessions, 'nostatus', 'events.jsonl'), `${JSON.stringify(event(1, 'session.created', null))}\n`);
  writeSession(
    workspace,
    'newer',
    { workflow_id: 'agent', status: 'completed', updated_at: at(9) },
    [],
    [event(1, 'session.created', null)],
  );
  writeSession(
    workspace,
    'older',
    { workflow_id: 'other', status: 'completed', updated_at: at(1) },
    [],
    [event(1, 'session.created', null)],
  );
  // A corrupt session proposes nothing: the plugin handler skips a corrupt snapshot, so no file is written.
  expect(readSessionSnapshot(workspace, 'broken', registryOf({})).corrupt).toBe(true);
  expect(readSessionSnapshot(workspace, 'bad-exec', registryOf({})).corrupt).toBe(true);
  expect(readSessionSnapshot(workspace, 'newer', registryOf({})).corrupt).toBe(false);
  expect(readSessionSnapshot(workspace, 'older', registryOf({})).corrupt).toBe(false);
});

const SEAL_CONFIG = `\
agents:
  fake:
    client:
      type: fake
    model: m1
roles:
  developer:
    agent: fake
`;

test('a completed session writes metrics through the plugin and later normalization leaves the file', async () => {
  const workspace = tempDir('migent-metrics-seal-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), SEAL_CONFIG, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'once.yaml'), ONCE, 'utf8');
  const provider = new ScriptedClient(['status: complete\n\ndone'], ['# notes\n']);
  provider.captureUsage = () => ({ total: 4 });
  provider.readUsage = () => ({ values: { ...blank(), input_tokens: 4 }, cumulative: [] });
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: 'once', task: 'write notes' },
    runnerOf(registryOf({ fake: provider })),
  );
  expect(result.status).toBe('completed');
  const file = sealedMetricsPath(workspace, result.sessionId);
  const sealed = JSON.parse(readFileSync(file, 'utf8')) as {
    status: string;
    totals: { usage: TurnUsage };
  };
  expect(sealed.status).toBe('completed');
  expect(sealed.totals.usage.input_tokens).toBe(4);

  provider.readUsage = () => ({ values: { ...blank(), input_tokens: 99 }, cumulative: [] });
  const derived = metricsOf(workspace, result.sessionId, registryOf({ fake: provider }));
  expect((derived.totals as { usage: TurnUsage }).usage.input_tokens).toBe(99);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(sealed);
});

test('an agent session does not seal metrics', async () => {
  const workspace = tempDir('migent-metrics-agent-');
  const sessionId = createAgentSession(workspace, 'reviewer', 'review the plan');
  const lock = SessionLock.acquire(path.join(workspace, '.migent', 'sessions', sessionId));
  onTestFinished(() => lock.release());
  const result = await runnerOf(registryOf({ fake: new ScriptedClient(['status: complete\nreviewed']) })).run({
    client: 'fake',
    model: 'm1',
    prompt: 'review',
    workspace,
    sessionId,
    stageId: 'reviewer',
  });
  expect(result.session_status).toBe('completed');
  expect(existsSync(sealedMetricsPath(workspace, sessionId))).toBe(false);
});

test('a blocked session has no sealed metrics and is omitted from the list', async () => {
  const workspace = tempDir('migent-metrics-blocked-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), SEAL_CONFIG, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'once.yaml'), ONCE, 'utf8');
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: 'once', task: 'write notes' },
    runnerOf(registryOf({ fake: new ScriptedClient(['status: blocked\nblocker: gate']) })),
  );
  expect(result.status).toBe('blocked');
  expect(existsSync(sealedMetricsPath(workspace, result.sessionId))).toBe(false);
});

test('mixed legacy CLI turns use their own parsers without inventing an execution client', () => {
  const workspace = tempDir('migent-metrics-mixed-');
  try {
    const codex = new FakeClient();
    const opencode = new FakeClient();
    codex.readUsage = (capture) => ({ values: { ...blank(), input_tokens: Number(capture.codex) }, cumulative: [] });
    opencode.readUsage = (capture) => ({
      values: { ...blank(), input_tokens: Number(capture.opencode) },
      cumulative: [],
    });
    writeSession(workspace, 'legacy', { workflow_id: 'legacy', status: 'active' },
      [{ id: '0001', order: 1, stage: 'work', status: 'failed', client: null, provider: 'codex' }],
      [turn(1, '0001', { opencode: 10 }, 'opencode'), turn(2, '0001', { codex: 25 }, 'codex')]);
    const metrics = metricsOf(workspace, 'legacy', registryOf({ codex, opencode }));
    const execution = (metrics.executions as Record<string, unknown>[])[0]!;
    expect(execution.client).toBeNull();
    expect((execution.usage as TurnUsage).input_tokens).toBe(35);
    expect(execution.uncaptured_turns).toBe(0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
