import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { StageOutcome } from '@nodeint/migent-kernel';
import { createWorkflowSession, SessionLock, SessionStore } from '@nodeint/migent-session';
import { expect, test } from 'vitest';

import { tempDir } from './support.ts';

const CONFIG = `agents:
  fake:
    client:
      type: fake
    model: m1
roles:
  developer:
    agent: fake
`;
const WORKFLOW = `id: wf
stages:
  - id: implement
    role: developer
  - id: review
    role: developer
    depends_on: [implement]
completion:
  stage: review
`;

const QUESTION = {
  id: '1', question: 'Which?', context: 'Because.', selection: 'single', recommended: ['A'], options: [{ id: 'A', label: 'A', description: 'first' }, { id: 'B', label: 'B', description: 'second' }],
};

type Save = { status: 'completed' | 'cancelled'; outcome: StageOutcome | null };

interface Fixture {
  store: SessionStore;
  sessionId: string;
  lock: SessionLock;
  /** Releases the session lock and removes the temporary workspace. */
  dispose(): void;
}

function sessionWith(saves: readonly (readonly [string, Save])[]): Fixture {
  const workspace = tempDir('migent-resume-guard-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), WORKFLOW, 'utf8');
  const sessionId = createWorkflowSession(workspace, 'wf', { task: 'task' });
  const store = new SessionStore(workspace);
  const lock = SessionLock.acquire(path.join(workspace, '.migent', 'sessions', sessionId));
  const dispose = () => {
    lock.release();
    rmSync(workspace, { recursive: true, force: true });
  };
  try {
    for (const [stageId, save] of saves) {
      const [record, , created] = store.loadOrCreate({
        client: 'fake', model: 'm1', options: {}, workspace, sessionId, stageId, stageAttempt: null, executionOrder: null, prompt: 'go',
      });
      store.saveExecution(created, record, save);
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return { store, sessionId, lock, dispose };
}

const REFUSED = (id: string, status: string) => `Session ${id} is ${status}, not blocked.`;

test('resumeBlockedSession accepts a blocked session', () => {
  const { store, sessionId, dispose } = sessionWith([['implement', { status: 'completed', outcome: new StageOutcome('blocked', { blocker: 'gate' }) }]]);
  try {
    expect(store.readSessionStatus(sessionId).status).toBe('blocked');
    expect(store.resumeBlockedSession(sessionId)).toHaveLength(1);
    expect(store.readSessionStatus(sessionId).status).toBe('active');
    // The session is active now with a blocked latest stage: the guard still accepts it.
    expect(() => store.resumeBlockedSession(sessionId)).not.toThrow();
  } finally {
    dispose();
  }
});

const REFUSED_CASES: [string, readonly (readonly [string, Save])[]][] = [
  [
    'question',
    [['implement', { status: 'completed', outcome: new StageOutcome('question', { question: 'Which?', questions: [QUESTION as never] }) }]],
  ],
  ['cancelled', [['implement', { status: 'cancelled', outcome: null }]]],
  [
    'completed',
    [
      ['implement', { status: 'completed', outcome: new StageOutcome('complete') }],
      ['review', { status: 'completed', outcome: new StageOutcome('complete') }],
    ],
  ],
];

test.each(REFUSED_CASES)('resumeBlockedSession refuses a %s session', (expected, saves) => {
  const { store, sessionId, dispose } = sessionWith(saves);
  try {
    const status = String(store.readSessionStatus(sessionId).status);
    expect(status).toBe(expected);
    expect(() => store.resumeBlockedSession(sessionId)).toThrow(REFUSED(sessionId, status));
  } finally {
    dispose();
  }
});
