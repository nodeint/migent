import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { BuildCommandInput, CommandSpec } from '@nodeint/migent-kernel';
import { raiseCancellation, resetCancellation } from '@nodeint/migent-kernel';
import { createWorkflowSession, SessionLock, SessionStore } from '@nodeint/migent-session';
import { afterEach, describe, expect, test } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { assertEventsValid } from './event-validation.ts';
import { registryOf, ScriptedClient, tempDir as makeTempDir } from './support.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const root = makeTempDir(prefix);
  roots.push(root);
  return root;
}

const CONFIG = (onExpired: string) => `\
agents:
  fake:
    client:
      type: fake
    model: m1
roles:
  developer:
    agent: fake
resume_policies:
  fake:
    match: { client: fake }
    cache_ttl: 1s
    on_expired: ${onExpired}
`;

const WORKFLOW = `\
id: wf
stages:
  - id: implement
    role: developer
completion:
  stage: implement
`;

class HangFirstProvider extends ScriptedClient {
  private hung = false;

  constructor(private readonly pidFile: string, responses: string[]) {
    super(responses);
  }

  override buildCommand(input: BuildCommandInput): CommandSpec {
    if (this.hung) return super.buildCommand(input);
    this.hung = true;
    this.calls.push({
      model: input.model, workspace: input.workspace, prompt: input.prompt, agentId: input.agentId,
      newAgentId: input.newAgentId, promptFile: input.promptFile, options: { ...input.options },
    });
    const code = `require("fs").writeFileSync(${JSON.stringify(this.pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    return { argv: [process.execPath, '-e', code] };
  }
}

/** A session whose only stage was cancelled mid-turn, with the cancel time pushed past the TTL. */
async function cancelled(onExpired: string) {
  const root = tempDir('migent-gate-cancel-');
  const pidFile = path.join(root, 'pid');
  const workspace = tempDir('migent-gate-cancel-ws-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG(onExpired), 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), WORKFLOW, 'utf8');
  const sessionId = createWorkflowSession(workspace, 'wf', { task: 'Finish the notes' });
  const provider = new HangFirstProvider(pidFile, ['status: complete\n\ndone']);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  const timer = setInterval(() => {
    if (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') return;
    clearInterval(timer);
    try { raiseCancellation(15); } catch { /* waiters were woken */ }
  }, 50);
  const first = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner);
  clearInterval(timer);
  expect(first.status).toBe('cancelled');
  const sessionDirectory = path.join(workspace, '.migent', 'sessions', sessionId);
  const [executionId] = readdirSync(path.join(sessionDirectory, 'executions'));
  const file = path.join(sessionDirectory, 'executions', executionId!, 'execution.json');
  const metadata = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const completedAt = '2026-01-01T00:00:00.000+00:00';
  writeFileSync(file, JSON.stringify({ ...metadata, completed_at: completedAt }));
  const metadataNow = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const events = () => readFileSync(path.join(sessionDirectory, 'events.jsonl'), 'utf8');
  const resume = () => executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, resetRevisions: true }, runner);
  return { provider, resume, executionId: executionId!, metadataNow, completedAt, events, workspace, sessionId };
}

/** Validates every event line against its schema and returns the event names. */
function parsed(text: string): string[] {
  const records = text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return [...assertEventsValid(records)];
}

describe('resume gate on a cancelled execution', () => {
  test('ask leaves it cancelled and untouched, with a pending decision and exit 10', async () => {
    const run = await cancelled('ask');
    const running = (run.events().match(/"event":"execution.running"/g) ?? []).length;
    const result = await run.resume();
    expect(result.code).toBe(10);
    expect(result.stopReason).toBe('resume_expired');
    const metadata = run.metadataNow();
    expect(metadata.status).toBe('cancelled');
    expect(metadata.completed_at).toBe(run.completedAt);
    expect((run.events().match(/"event":"execution.running"/g) ?? []).length).toBe(running);
    expect(run.events()).toContain('"event":"resume.expired"');
    expect(parsed(run.events())).toEqual(expect.arrayContaining(['session.cancelled', 'execution.cancelled', 'resume.expired']));
    expect(run.provider.calls).toHaveLength(1);
  }, 30_000);

  test('fresh keeps the source cancelled and starts a new attempt in a new conversation', async () => {
    const run = await cancelled('fresh');
    const result = await run.resume();
    expect(result.code).toBe(0);
    expect(run.metadataNow().status).toBe('cancelled');
    expect(run.provider.calls).toHaveLength(2);
    expect(run.provider.calls[1]?.agentId).toBeNull();
    expect(parsed(run.events())).toContain('revisions.reset');
    const ids = readdirSync(path.join(run.workspace, '.migent', 'sessions', run.sessionId, 'executions'));
    expect(ids).toHaveLength(2);
  }, 30_000);

  test('resume reopens in place, as without a policy, and records the verdict', async () => {
    const run = await cancelled('resume');
    const result = await run.resume();
    expect(result.code).toBe(0);
    expect(result.latestExecutionId).toBe(run.executionId);
    expect(run.provider.calls).toHaveLength(2);
    expect(run.events()).toContain('"action":"resume"');
    expect(parsed(run.events())).toEqual(expect.arrayContaining(['resume.expired']));
  }, 30_000);
});

class HangSecond extends ScriptedClient {
  override buildCommand(input: BuildCommandInput): CommandSpec {
    const spec = super.buildCommand(input);
    if (this.calls.length !== 2) return spec;
    setTimeout(() => { try { raiseCancellation(15); } catch { /* the flag stays set for the command */ } }, 300);
    return { argv: [process.execPath, '-e', 'setTimeout(() => {}, 30000)'] };
  }
}

const SIBLING_WORKFLOW = `\
schema_version: 7
id: wf
stages:
  - id: a
    role: developer
  - id: b
    role: developer
    depends_on: [a]
    session:
      resume_from: a
  - id: c
    role: developer
`;

describe('a decision for one stage leaves an unrelated cancelled stage alone (R1)', () => {
  for (const choice of ['resume', 'fresh'] as const) {
    test(`${choice}: B runs, C stays cancelled`, async () => {
      const workspace = tempDir('migent-gate-sibling-');
      mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
      writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG('ask'), 'utf8');
      writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), SIBLING_WORKFLOW, 'utf8');
      const provider = new HangSecond(['status: complete\n\nA done', 'status: complete\n\nC done', 'status: complete\n\nB done']);
      const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
      const first = await executeNamedWorkflow(workspace, { workflowId: 'wf', task: 'Task', stageId: 'a' }, runner);
      const store = new SessionStore(workspace);
      const { sessionId } = first;
      const source = store.latestExecution(sessionId)!;
      const sourceFile = path.join(source.directory, 'execution.json');
      writeFileSync(sourceFile, JSON.stringify({ ...JSON.parse(readFileSync(sourceFile, 'utf8')), completed_at: '2026-01-01T00:00:00Z' }));
      // B asks (its source has expired) while C runs and is cancelled.
      const stop = await executeNamedWorkflow(workspace, { sessionId }, runner);
      const sessionDirectory = path.join(workspace, '.migent', 'sessions', sessionId);
      const cancelledC = store.executionSnapshots(sessionId).find((row) => row.stageId === 'c');
      expect(cancelledC?.status).toBe('cancelled');
      const cFile = path.join(sessionDirectory, 'executions', cancelledC!.executionId, 'execution.json');
      const cBefore = readFileSync(cFile, 'utf8');
      resetCancellation();
      expect(stop.code).not.toBe(0);
      expect(store.pendingResumes(sessionId)).toHaveLength(1);
      const lock = SessionLock.acquire(sessionDirectory);
      try {
        store.recordResumeDecision(sessionId, { stageId: 'b', sourceExecutionId: source.executionId, choice, origin: 'human' });
      } finally { lock.release(); }
      const result = await executeNamedWorkflow(workspace, { sessionId, stageId: 'b', resumeTarget: true }, runner);
      // B ran and finished; C is still cancelled, so the session ends cancelled rather than completed.
      expect(result.code).toBe(130);
      const rows = store.executionSnapshots(sessionId);
      expect(rows.some((row) => row.stageId === 'b' && row.status === 'completed')).toBe(true);
      expect(readFileSync(cFile, 'utf8')).toBe(cBefore);
      expect(rows.find((row) => row.executionId === cancelledC!.executionId)?.status).toBe('cancelled');
      expect(provider.calls.at(-1)?.agentId).toBe(choice === 'resume' ? 'native-session-1' : null);
      expect(parsed(readFileSync(path.join(sessionDirectory, 'events.jsonl'), 'utf8'))).toEqual(expect.arrayContaining(['resume.expired', 'resume.decided']));
    }, 30_000);
  }
});
