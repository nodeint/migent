import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { createAgentSession, createPreparedSession, SessionLock } from '@nodeint/migent-session';
import { afterEach, expect, test } from 'vitest';

import { main } from '../src/index.ts';
import { cleanWorkspaces, stoppedSession } from './complete-fixtures.ts';
import { capture } from './support.ts';

afterEach(cleanWorkspaces);

test('complete prints the human report on stderr and exits 0', async () => {
  const { workspace, sessionId, directory } = stoppedSession();
  const result = await capture(() => main(['session', 'complete', sessionId], workspace));
  expect(result.value).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(`Session ${sessionId} completed manually.`);
  expect(result.stderr).toContain('warning: required artifact missing: notes');
  expect(result.stderr).toMatch(/artifact: .*plan\.md/);
  expect(result.stderr).toContain(`next: ${path.join(directory, 'next.json')}`);
  expect(result.stderr).toContain('migent session run --workflow implement --prior');
  const status = JSON.parse(readFileSync(path.join(directory, 'status.json'), 'utf8'));
  expect(status.status).toBe('completed');
  expect(status.outputs.plan.published_by_execution_id).toBe('manual');

  const again = await capture(() => main(['session', 'complete', sessionId], workspace));
  expect(again.value).toBe(0);
  expect(again.stderr).toContain('already completed');
  expect(again.stderr).not.toContain('warning:');
});

test('complete --json writes exactly one object on stdout', async () => {
  const { workspace, sessionId, directory } = stoppedSession();
  const result = await capture(() => main(['session', 'complete', sessionId, '--json'], workspace));
  expect(result.value).toBe(0);
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    session_id: sessionId,
    status: 'completed',
    already_completed: false,
    missing_outputs: ['notes'],
    outputs: [{ name: 'plan', path: expect.stringContaining('plan.md') }],
    next: { path: path.join(directory, 'next.json') },
  });
  expect(path.isAbsolute(payload.outputs[0].path)).toBe(true);
  expect(payload.next.suggestions[0]).toMatchObject({ workflow: 'implement' });
  expect(existsSync(path.join(directory, 'plugins', 'metrics', 'metrics.json'))).toBe(true);

  const again = await capture(() => main(['session', 'complete', sessionId, '--json'], workspace));
  expect(again.value).toBe(0);
  expect(JSON.parse(again.stdout)).toMatchObject({ already_completed: true, missing_outputs: [] });
});

test('complete exits 2 for missing, prepared, role, and running sessions', async () => {
  const { workspace, sessionId, directory } = stoppedSession();
  const missing = await capture(() => main(['session', 'complete', 'nope'], workspace));
  expect(missing.value).toBe(2);
  expect(missing.stderr).toContain('does not exist');

  const prepared = createPreparedSession(workspace, { title: 'Later', workflowId: 'plan' });
  const notStarted = await capture(() => main(['session', 'complete', prepared], workspace));
  expect(notStarted.value).toBe(2);
  expect(notStarted.stderr).toContain(`migent session run --session ${prepared}`);

  const role = createAgentSession(workspace, 'planner', 'A role');
  const roleResult = await capture(() => main(['session', 'complete', role], workspace));
  expect(roleResult.value).toBe(2);
  expect(roleResult.stderr).toContain('role session');

  const lock = SessionLock.acquire(directory);
  try {
    const running = await capture(() => main(['session', 'complete', sessionId, '--json'], workspace));
    expect(running.value).toBe(2);
    expect(running.stdout).toBe('');
    expect(running.stderr).toContain(`migent session cancel ${sessionId}`);
  } finally {
    lock.release();
  }
});

test('continue leaves a manually completed session stopped', async () => {
  const { workspace, sessionId } = stoppedSession();
  await capture(() => main(['session', 'complete', sessionId], workspace));
  const executions = path.join(workspace, '.migent', 'sessions', sessionId, 'executions');
  const before = readdirSync(executions);
  const resumed = await capture(() => main(['session', 'continue', sessionId], workspace));
  expect(resumed.stderr).not.toContain('stage extra');
  expect(readdirSync(executions)).toEqual(before);
  const status = JSON.parse(readFileSync(path.join(workspace, '.migent', 'sessions', sessionId, 'status.json'), 'utf8'));
  expect(status.status).toBe('completed');
});

test('complete twice records one plugin decision and does not rewrite the metrics', async () => {
  const { workspace, sessionId, directory } = stoppedSession();
  await capture(() => main(['session', 'complete', sessionId, '--json'], workspace));
  const file = path.join(directory, 'plugins', 'metrics', 'metrics.json');
  const before = readFileSync(file, 'utf8');
  const events = (): string[] => readFileSync(path.join(directory, 'events.jsonl'), 'utf8').split('\n').filter((line) => line.includes('"plugin.decision"'));
  expect(events()).toHaveLength(1);
  const again = await capture(() => main(['session', 'complete', sessionId, '--json'], workspace));
  expect(JSON.parse(again.stdout)).toMatchObject({ already_completed: true });
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(events()).toHaveLength(1);
});

test('complete a session with no frozen workflow writes no metrics', async () => {
  const { workspace, sessionId, directory } = stoppedSession();
  rmSync(path.join(directory, 'workflow.frozen.yaml'), { force: true });
  const result = await capture(() => main(['session', 'complete', sessionId, '--json'], workspace));
  expect(result.value).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'completed' });
  expect(existsSync(path.join(directory, 'plugins', 'metrics', 'metrics.json'))).toBe(false);
});
