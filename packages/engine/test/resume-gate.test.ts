import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { BuildCommandInput, CommandSpec } from '@nodeint/migent-kernel';
import { SessionLock, SessionStore, watchSnapshot } from '@nodeint/migent-session';
import { afterEach, describe, expect, test } from 'vitest';

import { AgentToolRunner } from '../src/agent-runner.ts';
import { executeNamedWorkflow } from '../src/execute.ts';
import { registryOf, ScriptedClient } from './support.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const scopeQuestion = {
  id: '1',
  question: 'Support existing sessions?',
  context: 'Migration costs more.',
  selection: 'single',
  options: [{ id: 'A', label: 'New sessions only' }, { id: 'B', label: 'Include existing sessions' }],
};
const QUESTION = 'status: question\n\n' + JSON.stringify({ schema_version: 1, questions: [scopeQuestion] });

const POLICY = (onExpired: string) => `resume_policies:
  fake:
    match: { client: fake }
    cache_ttl: 1s
    on_expired: ${onExpired}
`;

function workspace(config: { policy?: string }, stages: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'migent-gate-'));
  roots.push(root);
  mkdirSync(path.join(root, '.migent/workflows'), { recursive: true });
  writeFileSync(
    path.join(root, '.migent/config.yaml'),
    `schema_version: 7\nroles:\n  planner:\n    agent: { client: { type: fake }, model: fake }\n${config.policy ?? ''}`,
  );
  writeFileSync(path.join(root, '.migent/workflows/plan.yaml'), `schema_version: 7\nid: plan\nstages:\n${stages}`);
  return root;
}

const ASK_STAGE = '  - id: plan\n    role: planner\n    ask: human\n';

/** Runs the asking stage and returns once it stopped on the question, with the clock moved past the TTL. */
async function asked(root: string, responses: string[]) {
  const provider = new ScriptedClient([QUESTION, ...responses]);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  const first = await executeNamedWorkflow(root, { workflowId: 'plan', task: 'Plan' }, runner);
  expect(first.code).toBe(9);
  // Age the source execution so the 1s TTL has passed.
  const directory = path.join(root, '.migent/sessions', first.sessionId, 'executions/0001-plan--attempt-01/execution.json');
  const metadata = JSON.parse(readFileSync(directory, 'utf8')) as Record<string, unknown>;
  writeFileSync(directory, JSON.stringify({ ...metadata, completed_at: '2026-01-01T00:00:00.000+00:00' }));
  const sessionDirectory = path.join(root, '.migent/sessions', first.sessionId);
  return { provider, runner, sessionId: first.sessionId, sessionDirectory };
}

const eventsOf = (sessionDirectory: string, name: string) =>
  readFileSync(path.join(sessionDirectory, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; data: Record<string, unknown> })
    .filter((event) => event.event === name);

describe('resume gate', () => {
  test('no policy: the reply resumes the conversation and writes no resume events', async () => {
    const root = workspace({}, ASK_STAGE);
    const run = await asked(root, ['status: complete\n\nDone']);
    const result = await executeNamedWorkflow(root, { sessionId: run.sessionId, reply: 'New sessions only' }, run.runner);
    expect(result.code).toBe(0);
    expect(run.provider.calls[1]?.agentId).toBe('native-session-1');
    expect(eventsOf(run.sessionDirectory, 'resume.expired')).toEqual([]);
  }, 30_000);

  test('ask: the expired resume stops with exit 10 and creates no execution; the reply is kept', async () => {
    const root = workspace({ policy: POLICY('ask') }, ASK_STAGE);
    const run = await asked(root, ['status: complete\n\nDone']);
    const result = await executeNamedWorkflow(root, { sessionId: run.sessionId, reply: 'New sessions only' }, run.runner);
    expect(result.code).toBe(10);
    expect(result.stopReason).toBe('resume_expired');
    expect(result.status).toBe('expired');
    expect(run.provider.calls).toHaveLength(1);
    expect(new SessionStore(root).executionSnapshots(run.sessionId)).toHaveLength(1);
    expect(watchSnapshot(run.sessionDirectory).resume_decisions).toEqual([
      { stage_id: 'plan', source_execution_id: '0001-plan--attempt-01', raised_at: expect.any(String), policy: expect.any(String), estimate: expect.objectContaining({ cache_ttl_seconds: expect.any(Number), margin_seconds: expect.any(Number) }) },
    ]);
    expect(eventsOf(run.sessionDirectory, 'resume.expired')[0]?.data).toMatchObject({ action: 'ask', origin: 'policy', policy: 'fake' });
    // Continuing again stops again, with no new execution and no second record of the same pair.
    const again = await executeNamedWorkflow(root, { sessionId: run.sessionId }, run.runner);
    expect(again.code).toBe(10);
    expect(run.provider.calls).toHaveLength(1);
    expect(eventsOf(run.sessionDirectory, 'resume.expired')).toHaveLength(1);
  }, 30_000);

  test('after a resume decision the stage dispatches once with its saved reply', async () => {
    const root = workspace({ policy: POLICY('ask') }, ASK_STAGE);
    const run = await asked(root, ['status: complete\n\nDone']);
    await executeNamedWorkflow(root, { sessionId: run.sessionId, reply: 'New sessions only' }, run.runner);
    const lock = SessionLock.acquire(run.sessionDirectory);
    try {
      new SessionStore(root).recordResumeDecision(run.sessionId, {
        stageId: 'plan', sourceExecutionId: '0001-plan--attempt-01', choice: 'resume', origin: 'human',
      });
    } finally {
      lock.release();
    }
    const result = await executeNamedWorkflow(root, { sessionId: run.sessionId }, run.runner);
    expect(result.code).toBe(0);
    expect(run.provider.calls).toHaveLength(2);
    expect(run.provider.calls[1]?.agentId).toBe('native-session-1');
    expect(run.provider.calls[1]?.prompt).toContain('New sessions only');
  }, 30_000);

  test('fresh from the policy: a new conversation with the full stage prompt and the reply', async () => {
    const root = workspace({ policy: POLICY('fresh') }, ASK_STAGE);
    const run = await asked(root, ['status: complete\n\nDone']);
    const result = await executeNamedWorkflow(root, { sessionId: run.sessionId, reply: 'New sessions only' }, run.runner);
    expect(result.code).toBe(0);
    expect(run.provider.calls[1]?.agentId).toBeNull();
    expect(run.provider.calls[1]?.prompt).toContain('New sessions only');
    expect(run.provider.calls[1]?.prompt).toContain('stage');
    const execution = path.join(run.sessionDirectory, 'executions/0002-plan--attempt-02/execution.json');
    const metadata = JSON.parse(readFileSync(execution, 'utf8')) as Record<string, unknown>;
    expect(metadata.resumes_execution_id).toBeNull();
    expect(metadata.resume_skipped).toEqual({ source_execution_id: '0001-plan--attempt-01', reason: 'expired' });
    expect(eventsOf(run.sessionDirectory, 'resume.expired')[0]?.data).toMatchObject({ action: 'fresh' });
  }, 30_000);

  test('resume from the policy: as without a policy, plus a record', async () => {
    const root = workspace({ policy: POLICY('resume') }, ASK_STAGE);
    const run = await asked(root, ['status: complete\n\nDone']);
    const result = await executeNamedWorkflow(root, { sessionId: run.sessionId, reply: 'New sessions only' }, run.runner);
    expect(result.code).toBe(0);
    expect(run.provider.calls[1]?.agentId).toBe('native-session-1');
    expect(eventsOf(run.sessionDirectory, 'resume.expired')[0]?.data).toMatchObject({ action: 'resume' });
  }, 30_000);

  test('a stage on_expired overrides the policy', async () => {
    const root = workspace({ policy: POLICY('ask') }, `${ASK_STAGE}    session:\n      on_expired: fresh\n`);
    const run = await asked(root, ['status: complete\n\nDone']);
    const result = await executeNamedWorkflow(root, { sessionId: run.sessionId, reply: 'New sessions only' }, run.runner);
    expect(result.code).toBe(0);
    expect(run.provider.calls[1]?.agentId).toBeNull();
    expect(eventsOf(run.sessionDirectory, 'resume.expired')[0]?.data).toMatchObject({ action: 'fresh', origin: 'stage' });
  }, 30_000);
});

describe('resume_from target with no execution of its own', () => {
  const STAGES = [
    '  - id: a',
    '    role: planner',
    '  - id: b',
    '    role: planner',
    '    depends_on: [a]',
    '    session:',
    '      resume_from: a',
    '',
  ].join('\n');

  async function completedA(root: string, responses: string[]) {
    const provider = new ScriptedClient(['status: complete\n\nA done', ...responses]);
    const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
    const first = await executeNamedWorkflow(root, { workflowId: 'plan', task: 'Plan', maxDispatches: 1 }, runner);
    const sessionDirectory = path.join(root, '.migent/sessions', first.sessionId);
    const file = path.join(sessionDirectory, 'executions/0001-a--attempt-01/execution.json');
    const metadata = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...metadata, completed_at: '2026-01-01T00:00:00.000+00:00' }));
    return { provider, runner, sessionId: first.sessionId, sessionDirectory };
  }

  test('ask stops B without an execution, never stops A, and a resume decision lets B join A', async () => {
    const root = workspace({ policy: POLICY('ask') }, STAGES);
    const run = await completedA(root, ['status: complete\n\nB done']);
    const stopped = await executeNamedWorkflow(root, { sessionId: run.sessionId }, run.runner);
    expect(stopped.code).toBe(10);
    const store = new SessionStore(root);
    expect(store.executionSnapshots(run.sessionId).map((row) => row.stageId)).toEqual(['a']);
    expect(watchSnapshot(run.sessionDirectory).resume_decisions).toEqual([
      { stage_id: 'b', source_execution_id: '0001-a--attempt-01', raised_at: expect.any(String), policy: expect.any(String), estimate: expect.objectContaining({ cache_ttl_seconds: expect.any(Number), margin_seconds: expect.any(Number) }) },
    ]);
    const again = await executeNamedWorkflow(root, { sessionId: run.sessionId }, run.runner);
    expect(again.code).toBe(10);
    expect(store.executionSnapshots(run.sessionId)).toHaveLength(1);
    const lock = SessionLock.acquire(run.sessionDirectory);
    try {
      store.recordResumeDecision(run.sessionId, {
        stageId: 'b', sourceExecutionId: '0001-a--attempt-01', choice: 'resume', origin: 'human',
      });
    } finally {
      lock.release();
    }
    const done = await executeNamedWorkflow(root, { sessionId: run.sessionId }, run.runner);
    expect(done.code).toBe(0);
    expect(run.provider.calls[1]?.agentId).toBe('native-session-1');
    expect(store.executionSnapshots(run.sessionId).map((row) => row.stageId)).toEqual(['a', 'b']);
  }, 30_000);

  test('fresh starts B like a plain stage', async () => {
    const root = workspace({ policy: POLICY('fresh') }, STAGES);
    const run = await completedA(root, ['status: complete\n\nB done']);
    const done = await executeNamedWorkflow(root, { sessionId: run.sessionId }, run.runner);
    expect(done.code).toBe(0);
    expect(run.provider.calls[1]?.agentId).toBeNull();
  }, 30_000);
});

describe('a running sibling finishes before the expiry stops the session', () => {
  const STAGES = [
    '  - id: ask',
    '    role: planner',
    '    ask: human',
    '  - id: slow',
    '    role: planner',
    '',
  ].join('\n');

  /** Holds the `slow` stage until the test creates the release file. */
  class HoldingClient extends ScriptedClient {
    constructor(responses: string[], private readonly releaseFile: string) {
      super(responses);
    }

    override buildCommand(input: BuildCommandInput): CommandSpec {
      const spec = super.buildCommand(input);
      if (!input.prompt.includes('slow')) return spec;
      const wait = `const fs=require("fs");const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(this.releaseFile)})){clearInterval(t);process.stdout.write(process.argv[1]);}},25);`;
      return { argv: [process.execPath, '-e', wait, spec.argv[spec.argv.length - 1]!] };
    }
  }

  test('while slow runs the session stays active with the decision visible; then it ends expired with exit 10', async () => {
    const root = workspace({ policy: POLICY('ask') }, `concurrency: 2\n${STAGES}`.replace('concurrency: 2\n', ''));
    writeFileSync(
      path.join(root, '.migent/workflows/plan.yaml'),
      `schema_version: 7\nid: plan\nconcurrency: 2\nstages:\n${STAGES}`,
    );
    const releaseFile = path.join(root, 'release');
    const provider = new HoldingClient([QUESTION, 'status: complete\n\nSlow done', 'status: complete\n\nAsk done'], releaseFile);
    const runner = new AgentToolRunner(registryOf({ fake: provider }), 20);
    const first = await executeNamedWorkflow(root, { workflowId: 'plan', task: 'Plan', stageId: 'ask' }, runner);
    expect(first.code).toBe(9);
    const sessionDirectory = path.join(root, '.migent/sessions', first.sessionId);
    const file = path.join(sessionDirectory, 'executions/0001-ask--attempt-01/execution.json');
    const metadata = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...metadata, completed_at: '2026-01-01T00:00:00.000+00:00' }));
    const running = executeNamedWorkflow(root, { sessionId: first.sessionId, reply: 'New sessions only' }, runner);
    // slow is held; the asked stage must not dispatch, and nothing stops the session yet.
    const deadline = Date.now() + 10_000;
    let during: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      during = new SessionStore(root).readSessionStatus(first.sessionId);
      const decisions = watchSnapshot(sessionDirectory).resume_decisions;
      if (Array.isArray(decisions) && decisions.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(during.status).toBe('active');
    expect(watchSnapshot(sessionDirectory).resume_decisions).toHaveLength(1);
    writeFileSync(releaseFile, '');
    const result = await running;
    expect(result.code).toBe(10);
    expect(result.status).toBe('expired');
    const stages = new SessionStore(root).executionSnapshots(first.sessionId).map((row) => `${row.stageId}:${row.status}`);
    expect(stages).toContain('slow:completed');
    expect(stages.filter((item) => item.startsWith('ask:'))).toEqual(['ask:completed']);
  }, 40_000);
});

describe('exit mapping', () => {
  test('--stage and --once runs report exit 10 for an ask, as the loop does', async () => {
    for (const limits of [{ stageId: 'plan' }, { once: true }]) {
      const root = workspace({ policy: POLICY('ask') }, ASK_STAGE);
      const run = await asked(root, ['status: complete\n\nDone']);
      const result = await executeNamedWorkflow(
        root,
        { sessionId: run.sessionId, reply: 'New sessions only', ...limits },
        run.runner,
      );
      expect(result.code).toBe(10);
      expect(result.status).toBe('expired');
      expect(result.stopReason).toBe('resume_expired');
    }
  }, 60_000);
});
