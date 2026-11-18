import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AgentToolRunner, executeNamedWorkflow } from '@nodeint/migent-engine';
import type { ClientRegistry, CliRunOutput, FailureClassification, FailureOrigin, RawFailure, ResponseSource } from '@nodeint/migent-kernel';
import { buildMetrics } from '@nodeint/migent-plugins';
import { createWorkflowSession, readSessionSnapshot, SessionLock } from '@nodeint/migent-session';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';

import { removeTempDirs, tempDir } from './metrics-fixtures.ts';
import { registryOf, ScriptedClient } from './support.ts';

vi.setConfig({ testTimeout: 60_000 });
afterEach(removeTempDirs);

const CONFIG = [
  'agents:', '  fake:', '    client:', '      type: fake', '    model: m1',
  'roles:', '  developer:', '    agent: fake', '  reviewer:', '    agent: fake', '',
].join('\n');
const OK = 'status: complete\n\ndone';

/** The metrics document the plugin builds from the session snapshot, as it writes it on completion. */
function metricsOf(workspace: string, sessionId: string, clients: ClientRegistry): {
  totals: Record<string, number>;
  stages: Record<string, unknown>;
  executions: Record<string, unknown>[];
} {
  const document = buildMetrics(sessionId, readSessionSnapshot(workspace, sessionId, clients));
  return document as unknown as ReturnType<typeof metricsOf>;
}

interface Turn {
  reply: string;
  artifact?: string | null;
  exit: number;
  origin?: FailureOrigin;
  source?: ResponseSource;
}

/** A provider whose process exits with a scripted code and whose classifier reports a scripted origin. */
class ExitProvider extends ScriptedClient {
  private readonly turns: Turn[];
  private current: Turn | null = null;

  constructor(turns: Turn[]) {
    super(turns.map((turn) => turn.reply), turns.map((turn) => turn.artifact ?? null));
    this.turns = [...turns];
  }

  override runCommand(input: Parameters<ScriptedClient['runCommand']>[0]) {
    super.runCommand(input);
    this.current = this.turns.shift() ?? null;
    return { argv: [process.execPath, '-e', `process.exit(${this.current?.exit ?? 0})`] };
  }

  override parseRun(stdout: string, lastMessageFile: string): CliRunOutput {
    const base = super.parseRun(stdout, lastMessageFile);
    return { ...base, source: this.current?.source ?? 'none' };
  }

  override extractFailure(_stdout: string, exitCode: number): RawFailure | null {
    if (exitCode === 0) return null;
    return { origin: this.current?.origin ?? 'exit-only', message: `provider message ${exitCode}`, exitCode };
  }
}

function anomalySession(): { workspace: string; sessionId: string } {
  const workspace = tempDir('migent-anomaly-metrics-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(
    path.join(workspace, '.migent', 'workflows', 'wf.yaml'),
    'id: wf\nstages:\n  - id: implement\n    role: developer\n    produces:\n      artifact: notes.md\n  - id: review\n    role: developer\n    depends_on: [implement]\ncompletion:\n  stage: review\n',
    'utf8',
  );
  const sessionId = createWorkflowSession(workspace, 'wf', { task: 'task' });
  const lock = SessionLock.acquire(path.join(workspace, '.migent', 'sessions', sessionId));
  onTestFinished(() => lock.release());
  return { workspace, sessionId };
}

async function runStage(provider: ExitProvider, workspace: string, sessionId: string, extra = {}) {
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  return runner.run({ client: 'fake', model: 'm1', prompt: 'go', workspace, sessionId, stageId: 'implement', ...extra });
}

const counters = (record: Record<string, unknown>): Record<string, unknown> =>
  ({ total: record.provider_exit_anomalies, accepted: record.provider_exit_anomalies_accepted });

test('metrics: an accepted exit-only turn counts once in the execution row and the totals', async () => {
  const { workspace, sessionId } = anomalySession();
  const turns: Turn[] = [{ reply: OK, artifact: '# notes\n', exit: 1, source: 'model' }];
  const result = await runStage(new ExitProvider(turns), workspace, sessionId);
  const metrics = metricsOf(workspace, sessionId, {});
  expect(counters(metrics.totals)).toEqual({ total: 1, accepted: 1 });
  const rows = metrics.executions.map((row) => [row.execution_id, counters(row)]);
  expect(rows).toEqual([[result.execution_id, { total: 1, accepted: 1 }]]);
});

test('metrics: a rejected exit-only turn counts in the total and not in the accepted subset', async () => {
  const { workspace, sessionId } = anomalySession();
  const turns: Turn[] = [{ reply: 'no header', exit: 1, source: 'model' }, { reply: 'no header', exit: 0, source: 'model' }];
  await runStage(new ExitProvider(turns), workspace, sessionId);
  expect(counters(metricsOf(workspace, sessionId, {}).totals)).toEqual({ total: 1, accepted: 0 });
});

test('metrics: clean turns and provider errors record zero anomalies', async () => {
  const { workspace, sessionId } = anomalySession();
  await runStage(new ExitProvider([{ reply: OK, artifact: '# notes\n', exit: 0, source: 'model' }]), workspace, sessionId);
  await runStage(new ExitProvider([{ reply: OK, exit: 1, origin: 'provider-error', source: 'model' }]), workspace, sessionId);
  expect(counters(metricsOf(workspace, sessionId, {}).totals)).toEqual({ total: 0, accepted: 0 });
});

test('metrics: a resumed execution counts each anomaly once, even on a shared turn number', async () => {
  const { workspace, sessionId } = anomalySession();
  const provider = new ExitProvider([
    { reply: OK, artifact: '# notes\n', exit: 1, source: 'model' },
    { reply: OK, artifact: '# notes\n', exit: 1, source: 'model' },
  ]);
  const first = await runStage(provider, workspace, sessionId);
  const second = await runStage(provider, workspace, sessionId, { resumeExecutionId: first.execution_id });
  const metrics = metricsOf(workspace, sessionId, {});
  expect(counters(metrics.totals)).toEqual({ total: 2, accepted: 2 });
  expect(metrics.executions.map((row) => [row.execution_id, counters(row)])).toEqual([
    [first.execution_id, { total: 1, accepted: 1 }],
    [second.execution_id, { total: 1, accepted: 1 }],
  ]);
});

test('metrics: two anomalies of one execution on the same turn number are both counted, and stay stable', async () => {
  const { workspace, sessionId } = anomalySession();
  await runStage(new ExitProvider([{ reply: OK, artifact: '# notes\n', exit: 1, source: 'model' }]), workspace, sessionId);
  const log = path.join(workspace, '.migent', 'sessions', sessionId, 'events.jsonl');
  const lines = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
  const original = lines.find((item) => item.event === 'provider.exit_anomaly')!;
  const lastSeq = Math.max(...lines.map((item) => Number(item.seq)));
  const details = original.details as Record<string, unknown>;
  const repeat = { ...original, seq: lastSeq + 1, details: { ...details, accepted: false, reason: 'replayed on the same turn' } };
  appendFileSync(log, `${JSON.stringify(repeat)}\n`, 'utf8');
  for (let reread = 0; reread < 2; reread += 1) {
    const metrics = metricsOf(workspace, sessionId, {});
    expect(counters(metrics.totals)).toEqual({ total: 2, accepted: 1 });
    expect(metrics.executions.map((row) => counters(row))).toEqual([{ total: 2, accepted: 1 }]);
  }
});

const FUTURE = '2099-01-01T00:00:00.000Z';

class QuotaProvider extends ScriptedClient {
  constructor() {
    super(['status: complete\n\nlimited'], [null]);
    this.captureUsage = () => ({ result: { usage: { input_tokens: 0, output_tokens: 0 } } });
  }

  override extractFailure(): RawFailure {
    const quota: FailureClassification = { kind: 'quota', message: 'quota window', resetAt: FUTURE, window: 'five_hour' };
    return { origin: 'provider-error', message: quota.message, exitCode: 1, rateLimit: { resetAt: FUTURE, window: 'five_hour' } };
  }
}

test('metrics: a zero capture on a quota stop is not an uncaptured turn', async () => {
  const workspace = tempDir('migent-quota-metrics-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), 'schema_version: 2\nid: wf\nstages:\n  - id: implement\n    role: developer\n    depends_on: []\n', 'utf8');
  const provider = new QuotaProvider();
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', task: 'Write' }, new AgentToolRunner(registryOf({ fake: provider }), 10));
  const metrics = metricsOf(workspace, result.sessionId, registryOf({ fake: provider }));
  expect(metrics.executions[0]?.uncaptured_turns).toBe(0);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

test('metrics: a skipped stage is a skipped row with no client, model, turns or verify', async () => {
  const repo = tempDir('migent-skip-metrics-');
  git(repo, 'init', '-b', 'main');
  writeFileSync(path.join(repo, '.gitignore'), '.migent/config.yaml\n.migent/workflows/\n');
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'initial');
  mkdirSync(path.join(repo, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(repo, '.migent', 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(path.join(repo, '.migent', 'workflows', 'flow.yaml'), `schema_version: 2
id: flow
stages:
  - id: implement
    role: developer
    produces:
      artifact: impl.md
  - id: review_docs
    role: reviewer
    depends_on: [implement]
    run_when:
      changed_paths:
        - "docs/**/*"
        - "**/README.md"
outputs:
  - name: impl
    from_stage: implement
    artifact: impl.md
`, 'utf8');
  const base = git(repo, 'rev-parse', 'HEAD');
  const sessionId = createWorkflowSession(repo, 'flow', { task: 'Do it' });
  const provider = new ScriptedClient([OK], ['# impl\n']);
  const result = await executeNamedWorkflow(repo, { workflowId: 'flow', sessionId }, new AgentToolRunner(registryOf({ fake: provider }), 10));
  expect(result.status).toBe('completed');
  const metrics = metricsOf(repo, sessionId, registryOf({ fake: provider }));
  expect(metrics.totals).toMatchObject({ executions: 1, skipped: 1 });
  expect(metrics.stages.review_docs).toMatchObject({ executions: 0, skipped: 1 });
  const row = metrics.executions.find((item) => item.status === 'skipped')!;
  expect(row).toMatchObject({ client: null, model: null, turns: 0, verify: null });
  expect(row.skip).toMatchObject({ baseline: base });
});
