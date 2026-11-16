import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { SessionEventLog, sessionEventLog, subscribeSessionEvents } from '../src/event-log.ts';
import { SessionLock } from '../src/session-lock.ts';
import { createWorkflowSession } from '../src/session-records.ts';
import { repairSessionUnlocked } from '../src/session-repair.ts';
import { SessionStore } from '../src/session-store.ts';
import { SESSION_CONFIG } from './support.ts';

const roots: string[] = [];
const unsubscribers: (() => void)[] = [];
afterEach(() => {
  for (const off of unsubscribers.splice(0)) off();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function workspace(): { root: string; id: string; directory: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'migent-event-log-'));
  roots.push(root);
  mkdirSync(path.join(root, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(root, '.migent', 'config.yaml'), SESSION_CONFIG);
  writeFileSync(
    path.join(root, '.migent', 'workflows', 'implement.yaml'),
    'schema_version: 5\nid: implement\nstages:\n  - { id: work, role: developer }\n',
  );
  const id = createWorkflowSession(root, 'implement', { task: 'Do it' });
  return { root, id, directory: path.join(root, '.migent', 'sessions', id) };
}

const draft = (event: string) => ({ event, timestamp: '2026-01-01T00:00:00Z', data: {} });

test('delivery follows commit, in sequence order, once for a multi-event operation', () => {
  const { root, directory } = workspace();
  const seen: { event: unknown; seq: unknown; folded: boolean }[] = [];
  unsubscribers.push(
    subscribeSessionEvents((_id, record) => {
      const status = JSON.parse(readFileSync(path.join(directory, 'status.json'), 'utf8')) as Record<string, unknown>;
      seen.push({ event: record.event, seq: record.seq, folded: status.status === 'active' });
    }),
  );
  const lock = SessionLock.acquire(directory);
  try {
    sessionEventLog.record(directory, draft('session.activated'));
    sessionEventLog.record(directory, draft('baseline.captured'));
    expect(seen).toEqual([]);
    sessionEventLog.commit(root, directory);
    expect(seen.map((entry) => entry.event)).toEqual(['session.activated', 'baseline.captured']);
    expect(seen[1]!.seq).toBe((seen[0]!.seq as number) + 1);
    expect(seen.every((entry) => entry.folded)).toBe(true);
    sessionEventLog.commit(root, directory);
    expect(seen).toHaveLength(2);
  } finally {
    lock.release();
  }
});

/** Make the atomic `status.json` write of `directory` fail by putting a directory in its place. */
function breakFold(directory: string): () => void {
  const status = path.join(directory, 'status.json');
  const hidden = path.join(directory, 'status.hidden');
  renameSync(status, hidden);
  mkdirSync(status);
  return () => {
    rmSync(status, { recursive: true });
    renameSync(hidden, status);
  };
}

test('a failed fold on the owning session delivers nothing and keeps the queue for the retry', () => {
  const { root, directory } = workspace();
  const events: { event: unknown; seq: unknown }[] = [];
  unsubscribers.push(
    subscribeSessionEvents((_id, record) => void events.push({ event: record.event, seq: record.seq })),
  );
  const lock = SessionLock.acquire(directory);
  try {
    sessionEventLog.record(directory, draft('session.activated'));
    sessionEventLog.record(directory, draft('baseline.captured'));
    const restore = breakFold(directory);
    expect(() => sessionEventLog.commit(root, directory)).toThrow();
    expect(events).toEqual([]);
    expect(readFileSync(path.join(directory, 'events.jsonl'), 'utf8')).toContain('baseline.captured');
    restore();
    sessionEventLog.commit(root, directory);
    expect(events.map((entry) => entry.event)).toEqual(['session.activated', 'baseline.captured']);
    sessionEventLog.commit(root, directory);
    expect(events).toHaveLength(2);
  } finally {
    lock.release();
  }
});

test('a failed fold in a folding provider event keeps the record for the next commit', () => {
  const { root, id, directory } = workspace();
  const events: unknown[] = [];
  unsubscribers.push(subscribeSessionEvents((_id, record) => void events.push(record.event)));
  const lock = SessionLock.acquire(directory);
  try {
    const store = new SessionStore(root);
    const [, , context] = store.loadOrCreate({
      client: 'fake', model: 'model', options: {}, workspace: root, sessionId: id, stageId: 'work',
      stageAttempt: null, executionOrder: null, prompt: 'go',
    });
    events.length = 0;
    const restore = breakFold(directory);
    const warning = { event: 'provider.warning', execution_id: context.executionId };
    expect(() => store.recordProviderEvent(context, warning)).toThrow();
    expect(events).toEqual([]);
    expect(readFileSync(path.join(directory, 'events.jsonl'), 'utf8')).toContain('provider.warning');
    restore();
    sessionEventLog.commit(root, directory);
    expect(events).toEqual(['provider.warning']);
  } finally {
    lock.release();
  }
});

test('releasing the lock drops undelivered records', () => {
  const { root, directory } = workspace();
  const events: unknown[] = [];
  unsubscribers.push(subscribeSessionEvents((_id, record) => void events.push(record.event)));
  const lock = SessionLock.acquire(directory);
  sessionEventLog.record(directory, draft('session.activated'));
  lock.release();
  const next = SessionLock.acquire(directory);
  try {
    sessionEventLog.commit(root, directory);
    expect(events).toEqual([]);
  } finally {
    next.release();
  }
});

test('a refold delivers nothing', () => {
  const { root, directory } = workspace();
  const events: unknown[] = [];
  unsubscribers.push(subscribeSessionEvents((_id, record) => void events.push(record.event)));
  const lock = SessionLock.acquire(directory);
  try {
    sessionEventLog.commit(root, directory);
    expect(events).toEqual([]);
  } finally {
    lock.release();
  }
});

test('a throwing listener does not fail the write or the commit', () => {
  const { root, directory } = workspace();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const later: unknown[] = [];
  unsubscribers.push(
    subscribeSessionEvents(() => {
      throw new Error('boom');
    }),
    subscribeSessionEvents((_id, record) => void later.push(record.event)),
  );
  const lock = SessionLock.acquire(directory);
  try {
    sessionEventLog.record(directory, draft('session.activated'));
    expect(() => sessionEventLog.commit(root, directory)).not.toThrow();
    expect(later).toEqual(['session.activated']);
  } finally {
    lock.release();
  }
});

test('a write from a listener throws and the original write stays', () => {
  const { root, directory } = workspace();
  const failures: unknown[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  unsubscribers.push(
    subscribeSessionEvents(() => {
      try {
        sessionEventLog.record(directory, draft('baseline.captured'));
      } catch (error) {
        failures.push((error as Error).message);
      }
      try {
        sessionEventLog.commit(root, directory);
      } catch (error) {
        failures.push((error as Error).message);
      }
    }),
  );
  const lock = SessionLock.acquire(directory);
  try {
    sessionEventLog.record(directory, draft('session.activated'));
    sessionEventLog.commit(root, directory);
  } finally {
    lock.release();
  }
  expect(failures).toHaveLength(2);
  const log = readFileSync(path.join(directory, 'events.jsonl'), 'utf8');
  expect(log).not.toContain('baseline.captured');
});

test('log writes without a held lock throw and leave files and subscribers untouched', () => {
  const { root, directory } = workspace();
  const events: unknown[] = [];
  unsubscribers.push(subscribeSessionEvents((_id, record) => void events.push(record.event)));
  const eventsFile = path.join(directory, 'events.jsonl');
  const statusFile = path.join(directory, 'status.json');
  const eventsBefore = readFileSync(eventsFile, 'utf8');
  const statusBefore = readFileSync(statusFile, 'utf8');
  const unlocked = /is not locked by this process/;
  expect(() => sessionEventLog.record(directory, draft('session.activated'))).toThrow(unlocked);
  expect(() => sessionEventLog.recordStream(directory, draft('provider.item_started'))).toThrow(unlocked);
  expect(() => sessionEventLog.commit(root, directory)).toThrow(unlocked);
  expect(() => sessionEventLog.commitFolded(directory, { session_id: 'x' })).toThrow(unlocked);
  expect(events).toEqual([]);
  expect(readFileSync(eventsFile, 'utf8')).toBe(eventsBefore);
  expect(readFileSync(statusFile, 'utf8')).toBe(statusBefore);
});

test('a lock taken by another process makes the write throw without notification', () => {
  const { directory } = workspace();
  const events: unknown[] = [];
  unsubscribers.push(subscribeSessionEvents((_id, record) => void events.push(record.event)));
  const eventsBefore = readFileSync(path.join(directory, 'events.jsonl'), 'utf8');
  const lock = SessionLock.acquire(directory);
  rmSync(path.join(directory, 'session.lock'));
  try {
    expect(() => sessionEventLog.record(directory, draft('baseline.captured'))).toThrow(/lock was taken/);
    expect(events).toEqual([]);
    expect(readFileSync(path.join(directory, 'events.jsonl'), 'utf8')).toBe(eventsBefore);
  } finally {
    lock.abandon();
  }
});

test('releasing or abandoning an old lock handle keeps the current holder queue', () => {
  const { root, directory } = workspace();
  const events: unknown[] = [];
  unsubscribers.push(subscribeSessionEvents((_id, record) => void events.push(record.event)));
  for (const cleanup of ['release', 'abandon'] as const) {
    events.length = 0;
    const old = SessionLock.acquire(directory);
    old.release();
    const current = SessionLock.acquire(directory);
    try {
      sessionEventLog.record(directory, draft('baseline.captured'));
      old[cleanup]();
      sessionEventLog.commit(root, directory);
      expect(events).toEqual(['baseline.captured']);
    } finally {
      current.release();
    }
  }
});

test('provider events that fold are delivered after the fold, heartbeats and items right away', () => {
  const { root, id, directory } = workspace();
  const events: unknown[] = [];
  unsubscribers.push(subscribeSessionEvents((_id, record) => void events.push(record.event)));
  const lock = SessionLock.acquire(directory);
  try {
    const store = new SessionStore(root);
    const [, , context] = store.loadOrCreate({
      client: 'fake', model: 'model', options: {}, workspace: root, sessionId: id, stageId: 'work',
      stageAttempt: null, executionOrder: null, prompt: 'go',
    });
    events.length = 0;
    store.recordProviderEvent(context, { event: 'provider.heartbeat', execution_id: context.executionId });
    store.recordProviderEvent(context, { event: 'provider.item_started', execution_id: context.executionId });
    store.recordProviderEvent(context, { event: 'provider.warning', execution_id: context.executionId });
    expect(events).toEqual(['provider.heartbeat', 'provider.item_started', 'provider.warning']);
  } finally {
    lock.release();
  }
});

test('subscribe returns an unsubscribe function and each log keeps its own listeners', () => {
  const log = new SessionEventLog();
  const off = log.subscribe(() => undefined);
  off();
  const events: unknown[] = [];
  unsubscribers.push(subscribeSessionEvents((_id, record) => void events.push(record.event)));
  expect(events).toEqual([]);
});

test('recordStream delivers heartbeat and item records at once, and holds a folding kind for commit', () => {
  const { root, id, directory } = workspace();
  const events: unknown[] = [];
  unsubscribers.push(subscribeSessionEvents((_id, record) => void events.push(record.event)));
  const lock = SessionLock.acquire(directory);
  try {
    const store = new SessionStore(root);
    const [, , context] = store.loadOrCreate({
      client: 'fake', model: 'model', options: {}, workspace: root, sessionId: id, stageId: 'work',
      stageAttempt: null, executionOrder: null, prompt: 'go',
    });
    sessionEventLog.commit(root, directory);
    events.length = 0;
    sessionEventLog.recordStream(directory, { event: 'provider.heartbeat', execution_id: context.executionId });
    sessionEventLog.recordStream(directory, { event: 'provider.item_started', execution_id: context.executionId });
    expect(events).toEqual(['provider.heartbeat', 'provider.item_started']);
    sessionEventLog.recordStream(directory, { event: 'provider.warning', execution_id: context.executionId });
    expect(events).toHaveLength(2);
    sessionEventLog.commit(root, directory);
    expect(events).toEqual(['provider.heartbeat', 'provider.item_started', 'provider.warning']);
  } finally {
    lock.release();
  }
});

test('a notification is a frozen snapshot of the record as written', () => {
  const { root, directory } = workspace();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const nested = { value: 'persisted' };
  const received: { first: unknown; second: unknown; frozen: boolean }[] = [];
  let first: unknown;
  unsubscribers.push(
    subscribeSessionEvents((_id, record) => {
      const data = record.data as { nested: { value: string } };
      first = data.nested.value;
      try {
        data.nested.value = 'listener changed it';
      } catch {
        // A frozen record throws in strict mode.
      }
    }),
    subscribeSessionEvents((_id, record) => {
      const data = record.data as { nested: { value: string } };
      received.push({ first, second: data.nested.value, frozen: Object.isFrozen(data.nested) });
    }),
  );
  const lock = SessionLock.acquire(directory);
  try {
    sessionEventLog.record(directory, { event: 'session.activated', timestamp: '2026-01-01T00:00:00Z', data: { nested } });
    nested.value = 'mutated after append';
    sessionEventLog.commit(root, directory);
  } finally {
    lock.release();
  }
  expect(received).toEqual([{ first: 'persisted', second: 'persisted', frozen: true }]);
  const persisted = readFileSync(path.join(directory, 'events.jsonl'), 'utf8');
  expect(persisted).toContain('"value":"persisted"');
});

test('repair delivers the events it restored after status.json is written, and a pure refold delivers nothing', () => {
  const { root, id, directory } = workspace();
  const lock = SessionLock.acquire(directory);
  const store = new SessionStore(root);
  store.loadOrCreate({
    client: 'fake', model: 'model', options: {}, workspace: root, sessionId: id, stageId: 'work',
    stageAttempt: null, executionOrder: null, prompt: 'go',
  });
  sessionEventLog.commit(root, directory);
  const events: unknown[] = [];
  unsubscribers.push(subscribeSessionEvents((_id, record) => void events.push(record.event)));
  try {
    repairSessionUnlocked(root, id);
    expect(events).toEqual([]);
    const log = path.join(directory, 'events.jsonl');
    const kept = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '' && !line.includes('"execution.started"'));
    writeFileSync(log, `${kept.join('\n')}\n`);
    repairSessionUnlocked(root, id);
    expect(events).toContain('execution.started');
    expect(events.filter((event) => event === 'execution.started')).toHaveLength(1);
  } finally {
    lock.release();
  }
});
