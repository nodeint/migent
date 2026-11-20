import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Plugin, PluginInterceptor, PluginRegistry, PluginUses, TSchema } from '@nodeint/migent-contracts';
import { CancellationRequested, raiseCancellation, resetCancellation } from '@nodeint/migent-kernel';
import { SessionLock, SessionStore } from '@nodeint/migent-session';
import { afterEach, describe, expect, test } from 'vitest';

import { GateApplier } from '../src/execution/gate-changes.ts';
import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { gateResume } from '../src/resume-gate.ts';
import type { InterceptorChain } from '../src/runtime/interception.ts';
import { registryOf, ScriptedClient } from './support.ts';

const roots: string[] = [];
afterEach(() => {
  resetCancellation();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const schema = { type: 'object' } as unknown as TSchema;
const QUESTION = 'status: question\n\n' + JSON.stringify({
  schema_version: 1,
  questions: [{
    id: '1', question: 'Scope?', context: 'c', selection: 'single',
    options: [{ id: 'A', label: 'a' }, { id: 'B', label: 'b' }],
  }],
});
const DONE = 'status: complete\n\nDone';
const USES: PluginUses = {
  operations: [{ target: 'conversation.resume', phases: ['before'] }],
  events: [], session: ['resume_facts'], artifacts: [], agents: false, config: [],
};
const EXPIRY = {
  action: 'fresh', origin: 'policy', policy: 'plugin',
  estimate: { idleSec: 9, contextTokens: null, thresholdSec: 1, cacheTtlSec: 2, marginSec: 1 },
};
const FRESH = { kind: 'short_circuit', output: { verdict: 'fresh', expired: EXPIRY } } as const;

const gatePlugin = (before: PluginInterceptor['before']): Plugin => ({
  manifest: {
    id: 'gate', version: '1.0.0', apiVersion: { major: 1, minor: 0 }, advisory: false, configSchema: schema, uses: USES,
  },
  activate: (_options, migent) => { migent.operations.intercept('conversation.resume', { before }); },
});
const registryOfPlugins = (...plugins: Plugin[]): PluginRegistry => ({
  ids: () => plugins.map((entry) => entry.manifest.id),
  get: (id) => plugins.find((entry) => entry.manifest.id === id),
});

function workspace(plugins: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'migent-resume-op-'));
  roots.push(root);
  mkdirSync(path.join(root, '.migent/workflows'), { recursive: true });
  writeFileSync(
    path.join(root, '.migent/config.yaml'),
    'schema_version: 8\nroles:\n  planner:\n    agent: { client: { type: fake }, model: fake }\n'
    + plugins,
  );
  writeFileSync(
    path.join(root, '.migent/workflows/plan.yaml'),
    'schema_version: 8\nid: plan\nstages:\n  - id: plan\n    role: planner\n    ask: human\n',
  );
  return root;
}

async function asked(root: string, plugin: Plugin) {
  const provider = new ScriptedClient([QUESTION, DONE]);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  runner.pluginRegistry = registryOfPlugins(plugin);
  const first = await executeNamedWorkflow(root, { workflowId: 'plan', task: 'Plan' }, runner);
  expect(first.code).toBe(9);
  const sessionDirectory = path.join(root, '.migent/sessions', first.sessionId);
  return { provider, runner, sessionId: first.sessionId, sessionDirectory };
}

const eventsOf = (directory: string, prefix: string) =>
  readFileSync(path.join(directory, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; data: Record<string, unknown> })
    .filter((event) => event.event.startsWith(prefix));

const ENABLED = 'plugins:\n  gate:\n    enabled: true\n';

describe('conversation.resume interception', () => {
  test('an accepted short circuit is recorded as resume.expired and acted on', async () => {
    const root = workspace(ENABLED);
    const run = await asked(root, gatePlugin(async () => FRESH));
    const result = await executeNamedWorkflow(root, { sessionId: run.sessionId, reply: 'a' }, run.runner);
    expect(result.code).toBe(0);
    expect(run.provider.calls[1]?.agentId).toBeNull();
    expect(eventsOf(run.sessionDirectory, 'resume.expired')[0]?.data)
      .toMatchObject({ action: 'fresh', origin: 'policy', policy: 'plugin' });
  }, 30_000);

  test('a contract-violating proposal is rejected and the gate resumes', async () => {
    const root = workspace(ENABLED);
    // A fresh verdict without an expiry report is not allowed.
    const run = await asked(root, gatePlugin(async () => ({
      kind: 'short_circuit', output: { verdict: 'fresh', expired: null },
    })));
    const result = await executeNamedWorkflow(root, { sessionId: run.sessionId, reply: 'a' }, run.runner);
    expect(result.code).toBe(0);
    expect(run.provider.calls[1]?.agentId).toBe('native-session-1');
    expect(eventsOf(run.sessionDirectory, 'resume.expired')).toEqual([]);
    expect(eventsOf(run.sessionDirectory, 'plugin.decision').at(-1)?.data.results)
      .toMatchObject([{ status: 'rejected' }]);
  }, 30_000);

  test('a human origin in the proposal is rejected', async () => {
    const root = workspace(ENABLED);
    const run = await asked(root, gatePlugin(async () => ({
      kind: 'short_circuit', output: { verdict: 'fresh', expired: { ...EXPIRY, origin: 'human' } },
    })));
    const result = await executeNamedWorkflow(root, { sessionId: run.sessionId, reply: 'a' }, run.runner);
    expect(result.code).toBe(0);
    expect(eventsOf(run.sessionDirectory, 'resume.expired')).toEqual([]);
  }, 30_000);

  test('a timed-out interceptor under ignore resumes and a late result is discarded', async () => {
    const root = workspace('plugins:\n  gate:\n    enabled: true\n    timeout_sec: 0.05\n    on_error: ignore\n');
    const run = await asked(root, gatePlugin(() => new Promise((resolve) => {
      setTimeout(() => { resolve(FRESH); }, 400);
    })));
    const result = await executeNamedWorkflow(root, { sessionId: run.sessionId, reply: 'a' }, run.runner);
    expect(result.code).toBe(0);
    expect(run.provider.calls[1]?.agentId).toBe('native-session-1');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(eventsOf(run.sessionDirectory, 'resume.expired')).toEqual([]);
    expect(eventsOf(run.sessionDirectory, 'plugin.failed').at(-1)?.data).toMatchObject({ reason: 'timeout' });
  }, 30_000);

  test('cancellation during the interceptor writes nothing and dispatches nothing', async () => {
    const root = workspace(ENABLED);
    const run = await asked(root, gatePlugin(async () => {
      try { raiseCancellation(2); } catch { /* the request stays set */ }
      return FRESH;
    }));
    const result = await executeNamedWorkflow(root, { sessionId: run.sessionId, reply: 'a' }, run.runner);
    expect(result.stopReason).toBe('cancelled');
    expect(run.provider.calls).toHaveLength(1);
    expect(eventsOf(run.sessionDirectory, 'resume.expired')).toEqual([]);
  }, 30_000);

  test('facts changed during the pass re-run it once, then the proposal is stale and the gate resumes', async () => {
    const root = workspace(ENABLED);
    let runs = 0;
    let sessionId = '';
    const run = await asked(root, gatePlugin(async () => {
      runs += 1;
      // Each pass moves the evidence: a resume event for this (stage, source) appears while it runs.
      new SessionStore(root).recordResumeExpired(sessionId, {
        stageId: 'plan', sourceExecutionId: '0001-plan--attempt-01', action: 'resume', origin: 'policy',
        policy: `p${runs}`, estimate: {},
      });
      return FRESH;
    }));
    sessionId = run.sessionId;
    const lock = SessionLock.acquire(run.sessionDirectory);
    lock.release();
    const result = await executeNamedWorkflow(root, { sessionId, reply: 'a' }, run.runner);
    expect(runs).toBe(2);
    expect(result.code).toBe(0);
    expect(run.provider.calls[1]?.agentId).toBe('native-session-1');
    expect(eventsOf(run.sessionDirectory, 'plugin.failed').at(-1)?.data).toMatchObject({ reason: 'stale' });
  }, 30_000);
});

/** A session whose stages a and b both stopped on a question, so each has its own source execution. */
type Asked = { root: string; sessionId: string; directory: string; sources: Record<string, string> };

async function twoAsked(): Promise<Asked> {
  const root = mkdtempSync(path.join(tmpdir(), 'migent-resume-op-'));
  roots.push(root);
  mkdirSync(path.join(root, '.migent/workflows'), { recursive: true });
  writeFileSync(
    path.join(root, '.migent/config.yaml'),
    'schema_version: 8\nroles:\n  planner:\n    agent: { client: { type: fake }, model: fake }\n',
  );
  writeFileSync(
    path.join(root, '.migent/workflows/plan.yaml'),
    'schema_version: 8\nid: plan\nconcurrency: 2\nstages:\n'
    + '  - id: a\n    role: planner\n    ask: human\n  - id: b\n    role: planner\n    ask: human\n',
  );
  const runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient([QUESTION, QUESTION]) }), 10);
  const first = await executeNamedWorkflow(root, { workflowId: 'plan', task: 'Plan' }, runner);
  const sources: Record<string, string> = {};
  for (const row of new SessionStore(root).executionSnapshots(first.sessionId)) sources[row.stageId] = row.executionId;
  return { root, sessionId: first.sessionId, directory: path.join(root, '.migent/sessions', first.sessionId), sources };
}


describe('concurrent gates', () => {
  test('two overlapping gates in one process each judge and record their own source', async () => {
    const session = await twoAsked();
    const lock = SessionLock.acquire(session.directory);
    try {
      let entered = 0;
      let release: () => void = () => undefined;
      const both = new Promise<void>((resolve) => { release = resolve; });
      const outputs: Record<string, unknown> = {
        [session.sources.a ?? '']: { verdict: 'fresh', expired: { ...EXPIRY, action: 'fresh', policy: 'for-a' } },
        [session.sources.b ?? '']: { verdict: 'ask', expired: { ...EXPIRY, action: 'ask', policy: 'for-b' } },
      };
      const chain: InterceptorChain = {
        has: (_operation, phase) => phase === 'before',
        async run(call) {
          entered += 1;
          if (entered === 2) release();
          // Neither pass settles before both have started, so the two cycles genuinely overlap.
          await both;
          const judged = call.judge(call.value, { kind: 'short_circuit', output: outputs[call.identity.executionId] });
          if (judged.kind !== 'accepted') throw new Error(judged.reason);
          return { value: judged.value, shortCircuit: judged.shortCircuit };
        },
      };
      const gate = (stageId: string) => gateResume({
        store: new SessionStore(session.root), workspace: session.root, sessionId: session.sessionId, stageId,
        sourceExecutionId: session.sources[stageId] ?? '',         clients: registryOf({ fake: new ScriptedClient([]) }), path: 'dispatch',
        target: { client: 'fake', model: 'fake' }, interceptors: chain,
      });
      const [a, b] = await Promise.all([gate('a'), gate('b')]);
      expect([a.verdict, b.verdict]).toEqual(['fresh', 'ask']);
      const recorded = eventsOf(session.directory, 'resume.expired').map((event) => event.data);
      expect(recorded).toHaveLength(2);
      expect(recorded).toContainEqual(expect.objectContaining({
        stage_id: 'a', source_execution_id: session.sources.a, action: 'fresh', policy: 'for-a',
      }));
      expect(recorded).toContainEqual(expect.objectContaining({
        stage_id: 'b', source_execution_id: session.sources.b, action: 'ask', policy: 'for-b',
      }));
      expect(new SessionStore(session.root).pendingResumes(session.sessionId)
        .map((stop) => [stop.stageId, stop.sourceExecutionId]))
        .toEqual([['b', session.sources.b]]);
    } finally {
      lock.release();
    }
  }, 30_000);
});

describe('GateApplier', () => {
  const record = {
    stageId: 'a', sourceExecutionId: 'e', action: 'ask', origin: 'policy', policy: 'p', estimate: {},
  } as const;
  const change = { kind: 'recordResumeExpired', record } as const;
  const applierOf = (session: Asked) => new GateApplier({
    store: new SessionStore(session.root), sessionId: session.sessionId, directory: session.directory,
  });

  test('refuses to write under a pending cancellation and persists nothing', async () => {
    const session = await twoAsked();
    const lock = SessionLock.acquire(session.directory);
    try {
      try { raiseCancellation(2); } catch { /* the request stays set */ }
      expect(() => { applierOf(session).apply([change]); }).toThrow(CancellationRequested);
      expect(eventsOf(session.directory, 'resume.expired')).toEqual([]);
    } finally {
      lock.release();
    }
  }, 30_000);

  test('refuses to write when this process holds no session lock and persists nothing', async () => {
    const session = await twoAsked();
    expect(() => { applierOf(session).apply([change]); }).toThrow(/does not hold the lock/);
    expect(eventsOf(session.directory, 'resume.expired')).toEqual([]);
  }, 30_000);

  test('refuses to write after another process took the lock over and persists nothing', async () => {
    const session = await twoAsked();
    const lock = SessionLock.acquire(session.directory);
    try {
      const file = path.join(session.directory, 'session.lock');
      const info = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      writeFileSync(file, JSON.stringify({ ...info, nonce: 'taken-over' }));
      expect(() => { applierOf(session).apply([change]); }).toThrow(/lock was taken by another process/);
      expect(eventsOf(session.directory, 'resume.expired')).toEqual([]);
    } finally {
      lock.release();
    }
  }, 30_000);

  test('writes the change under the lock', async () => {
    const session = await twoAsked();
    const lock = SessionLock.acquire(session.directory);
    try {
      applierOf(session).apply([change]);
      expect(eventsOf(session.directory, 'resume.expired').map((event) => event.data))
        .toEqual([expect.objectContaining({ stage_id: 'a', source_execution_id: 'e', action: 'ask' })]);
    } finally {
      lock.release();
    }
  }, 30_000);
});
