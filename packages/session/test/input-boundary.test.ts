import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { SESSION_CONFIG } from './support.ts';

const control = vi.hoisted(() => ({ failNext: false, sawInput: [] as boolean[] }));

vi.mock('../src/session-store-execution.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/session-store-execution.ts')>();
  return {
    ...actual,
    writeStartedExecution: (...args: Parameters<typeof actual.writeStartedExecution>) => {
      control.sawInput.push(existsSync(path.join(args[0].directory, 'input.json')));
      if (control.failNext) {
        control.failNext = false;
        throw new Error('crash before execution.json');
      }
      return actual.writeStartedExecution(...args);
    },
  };
});

import { SessionLock } from '../src/session-lock.ts';
import { createWorkflowSession } from '../src/session-records.ts';
import { SessionStore } from '../src/session-store.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  control.failNext = false;
  control.sawInput.length = 0;
});

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'migent-input-boundary-'));
  roots.push(root);
  mkdirSync(path.join(root, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(root, '.migent', 'config.yaml'), SESSION_CONFIG);
  writeFileSync(path.join(root, '.migent', 'workflows', 'plan.yaml'), 'schema_version: 5\nid: plan\nstages:\n  - id: draft\n    role: planner\n    produces: { artifact: plan.md }\n');
  return root;
}

const humanInput = { kind: 'reply' as const, sent: 'steer', input: 'steer', respondsToExecutionId: '0000-plan--attempt-01' };

function start(store: SessionStore, root: string, id: string, withInput: boolean) {
  return store.loadOrCreate({
    client: 'fake', model: 'model', options: {}, workspace: root, sessionId: id, stageId: 'draft',
    stageAttempt: null, executionOrder: null, prompt: 'steer', ...(withInput ? { humanInput } : {}),
  });
}

test('input.json is on disk before execution.json is written', () => {
  const root = workspace();
  const id = createWorkflowSession(root, 'plan', { task: 'Plan the work' });
  const lock = SessionLock.acquire(path.join(root, '.migent', 'sessions', id));
  try {
    const [, , context] = start(new SessionStore(root), root, id, true);
    expect(control.sawInput).toEqual([true]);
    expect(existsSync(path.join(context.directory, 'execution.json'))).toBe(true);
  } finally {
    lock.release();
  }
});

test('an orphan directory without execution.json is not an execution; recovery records input in a new one', () => {
  const root = workspace();
  const id = createWorkflowSession(root, 'plan', { task: 'Plan the work' });
  const sessionDir = path.join(root, '.migent', 'sessions', id);
  const lock = SessionLock.acquire(sessionDir);
  try {
    const store = new SessionStore(root);
    control.failNext = true;
    expect(() => start(store, root, id, true)).toThrow('crash before execution.json');
    const executions = path.join(sessionDir, 'executions');
    const [orphan] = readdirSync(executions);
    expect(existsSync(path.join(executions, orphan!, 'prompt.md'))).toBe(true);
    expect(existsSync(path.join(executions, orphan!, 'input.json'))).toBe(true);
    expect(existsSync(path.join(executions, orphan!, 'execution.json'))).toBe(false);

    const [, , context] = start(store, root, id, true);
    expect(context.executionId).not.toBe(orphan);
    expect(existsSync(path.join(context.directory, 'input.json'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(context.directory, 'input.json'), 'utf8'))).toMatchObject({ execution_id: context.executionId, sent: 'steer' });
    const withExecution = readdirSync(executions).filter((name) => existsSync(path.join(executions, name, 'execution.json')));
    expect(withExecution).toEqual([context.executionId]);
    expect(store.executionSnapshots(id).map((snapshot) => snapshot.executionId)).toEqual([context.executionId]);
  } finally {
    lock.release();
  }
});
