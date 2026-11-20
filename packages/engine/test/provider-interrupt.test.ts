import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { cancelWhenStarted, PRE_ID, ServerProvider, setup } from './interrupt-support.ts';
import { registryOf, tempDir } from './support.ts';

const OTHER_ID = 'ses_otherOtherOther000000';

function fastRunner(provider: ServerProvider, timeoutSec: number | null = 30): AgentToolRunner {
  const runner = new AgentToolRunner(registryOf({ fake: provider }), timeoutSec);
  runner.executor.interruptExitGraceMs = 100;
  runner.interruptPolicy = { attempts: 3, retryDelayMs: 20, commandTimeoutMs: 5000 };
  return runner;
}

interface Saved {
  execution: Record<string, unknown>;
  conversation: Record<string, unknown>;
  events: Record<string, unknown>[];
}

function savedExecution(workspace: string, sessionId: string): Saved {
  const base = path.join(workspace, '.migent', 'sessions', sessionId);
  const executionId = readdirSync(path.join(base, 'executions'))[0]!;
  const read = (name: string) =>
    JSON.parse(readFileSync(path.join(base, 'executions', executionId, name), 'utf8')) as Record<string, unknown>;
  const events = readFileSync(path.join(base, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { execution: read('execution.json'), conversation: read('conversation.json'), events };
}

const named = (saved: Saved, event: string) => saved.events.filter((item) => item.event === event);

test('a new execution persists the preallocated id and passes it to the first command', async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir('migent-interrupt-id-'));
  provider.hang = false;
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, fastRunner(provider));
  expect(result.stopReason).toBe('completed');
  expect(provider.calls[0]?.newAgentId).toBe(PRE_ID);
  expect(provider.calls[0]?.agentId).toBeNull();
});

test('cancel interrupts the server-side turn before the client is killed and keeps the id', async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir('migent-interrupt-cancel-'));
  const stop = cancelWhenStarted(provider);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, fastRunner(provider));
  stop();
  expect(result.status).toBe('cancelled');
  // The first interrupt runs while the client is still alive.
  expect(provider.interrupts()[0]).toBe(`${PRE_ID} alive`);
  const saved = savedExecution(workspace, sessionId);
  expect(saved.execution.status).toBe('cancelled');
  expect(saved.conversation.agent_id).toBe(PRE_ID);
  expect(named(saved, 'provider.interrupt')).not.toHaveLength(0);
  expect(named(saved, 'provider.warning')).toHaveLength(0);
}, 30_000);

test('cancel before the server created the session retries a bounded number of times and warns', async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir('migent-interrupt-race-'));
  provider.outcomes = Array.from({ length: 20 }, () => 'not-found' as const);
  const stop = cancelWhenStarted(provider);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, fastRunner(provider));
  stop();
  expect(result.status).toBe('cancelled');
  // 3 attempts before the kill and 3 more after it; never unbounded.
  expect(provider.interrupts()).toHaveLength(6);
  const saved = savedExecution(workspace, sessionId);
  expect(saved.conversation.agent_id).toBe(PRE_ID);
  const [warning] = named(saved, 'provider.warning');
  expect(String(warning?.summary)).toContain('could not confirm');
  expect(String(warning?.summary)).toContain(PRE_ID);
  expect(named(saved, 'provider.interrupt')).toHaveLength(0);
}, 30_000);

test('a session the server creates late is caught by the check after the client stops', async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir('migent-interrupt-late-'));
  provider.outcomes = ['not-found', 'not-found', 'not-found', 'interrupted'];
  const stop = cancelWhenStarted(provider);
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, fastRunner(provider));
  stop();
  const saved = savedExecution(workspace, sessionId);
  expect(named(saved, 'provider.interrupt')).not.toHaveLength(0);
  expect(named(saved, 'provider.warning')).toHaveLength(0);
}, 30_000);

test('an interrupt that fails does not hang or claim the turn stopped', async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir('migent-interrupt-fail-'));
  provider.outcomes = ['failed', 'failed'];
  const stop = cancelWhenStarted(provider);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, fastRunner(provider));
  stop();
  expect(result.status).toBe('cancelled');
  expect(provider.interrupts()).toHaveLength(2);
  const saved = savedExecution(workspace, sessionId);
  expect(named(saved, 'provider.interrupt')).toHaveLength(0);
  expect(named(saved, 'provider.warning')).not.toHaveLength(0);
  expect(saved.conversation.agent_id).toBe(PRE_ID);
}, 30_000);

test('an already idle session is reported as idle, not as a failure', async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir('migent-interrupt-idle-'));
  provider.outcomes = ['idle', 'idle'];
  const stop = cancelWhenStarted(provider);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, fastRunner(provider));
  stop();
  expect(result.status).toBe('cancelled');
  const saved = savedExecution(workspace, sessionId);
  expect(String(named(saved, 'provider.interrupt')[0]?.summary)).toContain('idle');
  expect(named(saved, 'provider.warning')).toHaveLength(0);
}, 30_000);

test('a different id reported by the provider is warned about and interrupted too', async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir('migent-interrupt-mismatch-'));
  provider.reportedId = OTHER_ID;
  const stop = cancelWhenStarted(provider);
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, fastRunner(provider));
  stop();
  const targets = new Set(provider.interrupts().map((line) => line.split(' ')[0]));
  expect(targets).toEqual(new Set([PRE_ID, OTHER_ID]));
  const saved = savedExecution(workspace, sessionId);
  expect(named(saved, 'provider.warning').some((event) => String(event.summary).includes('not the expected'))).toBe(true);
}, 30_000);

test('timeout interrupts the server-side turn and keeps the timeout outcome', async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir('migent-interrupt-timeout-'));
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, fastRunner(provider, 2));
  expect(result.status).not.toBe('cancelled');
  expect(provider.interrupts()[0]).toBe(`${PRE_ID} alive`);
  const saved = savedExecution(workspace, sessionId);
  expect(saved.execution.status).toBe('failed');
  expect(JSON.stringify(saved.execution)).toContain('timed out');
}, 30_000);

test('a provider without an interrupt command keeps its lifecycle', async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir('migent-interrupt-none-'));
  (provider as { interruptCommand?: unknown }).interruptCommand = undefined;
  const stop = cancelWhenStarted(provider);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, fastRunner(provider));
  stop();
  expect(result.status).toBe('cancelled');
  expect(provider.interrupts()).toEqual([]);
}, 30_000);
