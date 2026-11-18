import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { StageOutcome } from '@nodeint/migent-kernel';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

/** Every durable write the session package makes, in order, as `<kind>:<file under the session>`. */
const writes: string[] = [];

vi.mock('@nodeint/migent-kernel', async (importOriginal) => {
  const original = await importOriginal<typeof import('@nodeint/migent-kernel')>();
  const note = (kind: string, file: string): void => {
    writes.push(`${kind}:${file}`);
  };
  return {
    ...original,
    appendLineSynced: (file: string, line: string): void => {
      note('append', file);
      original.appendLineSynced(file, line);
    },
    writeJsonAtomic: (file: string, value: unknown): void => {
      note('json', file);
      (original.writeJsonAtomic as (f: string, v: unknown) => void)(file, value);
    },
    writeFileAtomic: (file: string, text: string): void => {
      note('file', file);
      original.writeFileAtomic(file, text);
    },
  };
});

const { EVENT_VERSION } = await import('../src/session-events.ts');
const { SessionLock } = await import('../src/session-lock.ts');
const { createWorkflowSession } = await import('../src/session-records.ts');
const { SessionStore } = await import('../src/session-store.ts');
const { SESSION_CONFIG } = await import('./support.ts');

const roots: string[] = [];
beforeEach(() => {
  writes.length = 0;
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): { root: string; id: string; directory: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'migent-event-char-'));
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

function startExecution(root: string, id: string) {
  const store = new SessionStore(root);
  const [record, , context] = store.loadOrCreate({
    client: 'fake', model: 'model', options: {}, workspace: root, sessionId: id, stageId: 'work',
    stageAttempt: null, executionOrder: null, prompt: 'go',
  });
  return { store, record, context };
}

const lines = (file: string): Record<string, unknown>[] =>
  existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];

/** What a write list says about one session file, by base name relative to the session directory. */
const relative = (directory: string): string[] =>
  writes.map((entry) => entry.replace(`${directory}${path.sep}`, '').split(path.sep).join('/'));

test('event envelope keeps its key order, the v field and a gapless sequence', () => {
  const { root, id, directory } = workspace();
  const lock = SessionLock.acquire(directory);
  try {
    const { store, context } = startExecution(root, id);
    store.recordProviderEvent(context, { event: 'provider.warning', execution_id: context.executionId, stage_id: 'work', summary: 'careful', timestamp: '2026-01-01T00:00:00Z', extra_key: 1 });
  } finally {
    lock.release();
  }
  const events = lines(path.join(directory, 'events.jsonl'));
  expect(EVENT_VERSION).toBe(2);
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
  for (const event of events) {
    expect(event.v).toBe(EVENT_VERSION);
    const keys = Object.keys(event);
    expect(keys.slice(0, 4)).toEqual(['v', 'seq', 'event', 'timestamp']);
    expect(keys.at(-1)).toBe('data');
  }
  const warning = events.find((event) => event.event === 'provider.warning')!;
  expect(Object.keys(warning)).toEqual(['v', 'seq', 'event', 'timestamp', 'execution_id', 'stage_id', 'summary', 'extra_key', 'data']);
  expect(warning.data).toEqual({});
});

test('sequence numbering is one counter over events.jsonl and every stream.jsonl', () => {
  const { root, id, directory } = workspace();
  const lock = SessionLock.acquire(directory);
  try {
    const { store, context } = startExecution(root, id);
    const before = lines(path.join(directory, 'events.jsonl')).length;
    store.recordProviderEvent(context, { event: 'provider.item_started', execution_id: context.executionId });
    store.recordProviderEvent(context, { event: 'provider.warning', execution_id: context.executionId });
    store.recordProviderEvent(context, { event: 'provider.item_completed', execution_id: context.executionId });
    const stream = lines(path.join(context.directory, 'stream.jsonl'));
    const log = lines(path.join(directory, 'events.jsonl'));
    expect(stream.map((event) => event.seq)).toEqual([before + 1, before + 3]);
    expect(log.at(-1)).toMatchObject({ event: 'provider.warning', seq: before + 2 });
  } finally {
    lock.release();
  }
});

test.each([
  ['provider.heartbeat', true, 'stream'],
  ['provider.item_started', true, 'stream'],
  ['provider.item_completed', true, 'stream'],
  ['provider.heartbeat', false, 'log'],
  ['provider.item_started', false, 'log'],
  ['provider.turn_completed', true, 'log'],
  ['provider.stage_started', true, 'log'],
  ['provider.quota', true, 'log'],
  ['provider.error', true, 'log'],
  ['verify.started', true, 'log'],
  ['verify.heartbeat', true, 'log'],
  ['verify.failed', true, 'log'],
  ['verify.passed', true, 'log'],
])('%s with execution id %s is written to %s', (name, withExecution, destination) => {
  const { root, id, directory } = workspace();
  const lock = SessionLock.acquire(directory);
  try {
    const { store, context } = startExecution(root, id);
    const event: Record<string, unknown> = { event: name };
    if (withExecution) event.execution_id = context.executionId;
    store.recordProviderEvent(context, event);
    const inLog = lines(path.join(directory, 'events.jsonl')).some((entry) => entry.event === name);
    const inStream = lines(path.join(context.directory, 'stream.jsonl')).some((entry) => entry.event === name);
    expect({ inLog, inStream }).toEqual(destination === 'stream' ? { inLog: false, inStream: true } : { inLog: true, inStream: false });
  } finally {
    lock.release();
  }
});

test('lifecycle events go to events.jsonl and never to a stream', () => {
  const { root, id, directory } = workspace();
  const lock = SessionLock.acquire(directory);
  try {
    const { context } = startExecution(root, id);
    const names = lines(path.join(directory, 'events.jsonl')).map((event) => event.event);
    expect(names).toEqual(expect.arrayContaining(['session.created', 'execution.started']));
    expect(existsSync(path.join(context.directory, 'stream.jsonl'))).toBe(false);
  } finally {
    lock.release();
  }
});

test.each([
  'provider.stage_started',
  'provider.turn_completed',
  'provider.turn_failed',
  'provider.quota',
  'provider.cancelled',
  'provider.error',
  'provider.warning',
  'verify.started',
  'verify.failed',
  'verify.passed',
])('%s folds status.json', (name) => {
  const { root, id, directory } = workspace();
  const lock = SessionLock.acquire(directory);
  try {
    const { store, context } = startExecution(root, id);
    writes.length = 0;
    store.recordProviderEvent(context, { event: name, execution_id: context.executionId });
    expect(relative(directory)).toEqual(['events.jsonl', 'status.json'].map((file) => (file === 'events.jsonl' ? `append:${file}` : `json:${file}`)));
  } finally {
    lock.release();
  }
});

test.each(['provider.heartbeat', 'verify.heartbeat', 'provider.item_started', 'provider.item_completed', 'provider.unknown_kind'])(
  '%s does not fold status.json',
  (name) => {
    const { root, id, directory } = workspace();
    const lock = SessionLock.acquire(directory);
    try {
      const { store, context } = startExecution(root, id);
      writes.length = 0;
      store.recordProviderEvent(context, { event: name, execution_id: context.executionId });
      expect(writes.filter((entry) => entry.startsWith('json:') && entry.endsWith('status.json'))).toEqual([]);
      expect(writes).toHaveLength(1);
    } finally {
      lock.release();
    }
  },
);

test('saving a finished execution appends its events, then folds status.json once', () => {
  const { root, id, directory } = workspace();
  const lock = SessionLock.acquire(directory);
  try {
    const { store, record, context } = startExecution(root, id);
    writes.length = 0;
    store.saveExecution(context, record, { status: 'completed', outcome: new StageOutcome('complete') });
  } finally {
    lock.release();
  }
  // An event-log manifest has no status to rewrite, and no downstream is configured.
  const order = relative(directory).filter((entry) => !entry.includes('executions/'));
  expect(order).toEqual(['append:events.jsonl', 'append:events.jsonl', 'append:events.jsonl', 'json:status.json']);
  const names = lines(path.join(directory, 'events.jsonl')).map((event) => event.event);
  expect(names.slice(-3)).toEqual(['execution.completed', 'stage.complete', 'session.completed']);
  const status = JSON.parse(readFileSync(path.join(directory, 'status.json'), 'utf8')) as Record<string, unknown>;
  expect(status.status).toBe('completed');
});

test('saving the completing execution of a legacy manifest writes events, manifest status, status.json, then next suggestions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'migent-event-char-'));
  roots.push(root);
  mkdirSync(path.join(root, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(root, '.migent', 'config.yaml'), SESSION_CONFIG);
  writeFileSync(
    path.join(root, '.migent', 'workflows', 'plan.yaml'),
    `schema_version: 5
id: plan
stages:
  - id: draft
    role: planner
    produces: { artifact: plan.md }
outputs:
  - { name: approved_plan, from_stage: draft, artifact: plan.md }
downstream:
  - workflow: implement
    task: Implement the plan
    artifacts: { plan: approved_plan }
`,
  );
  writeFileSync(path.join(root, '.migent', 'workflows', 'implement.yaml'), 'schema_version: 5\nid: implement\nstages:\n  - { id: work, role: developer }\n');
  const id = createWorkflowSession(root, 'plan', { task: 'Plan' });
  const directory = path.join(root, '.migent', 'sessions', id);
  const manifest = path.join(directory, 'manifest.yaml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('schema_version: 2', 'schema_version: 1\nstatus: running'));
  const lock = SessionLock.acquire(directory);
  try {
    const store = new SessionStore(root);
    const [record, , context] = store.loadOrCreate({
      client: 'fake', model: 'model', options: {}, workspace: root, sessionId: id, stageId: 'draft',
      stageAttempt: null, executionOrder: null, prompt: 'go',
    });
    mkdirSync(context.artifactDirectory, { recursive: true });
    writeFileSync(path.join(context.artifactDirectory, 'plan.md'), 'plan\n');
    writes.length = 0;
    store.saveExecution(context, record, { status: 'completed', outcome: new StageOutcome('complete') });
  } finally {
    lock.release();
  }
  expect(relative(directory).filter((entry) => !entry.includes('executions/'))).toEqual([
    'append:events.jsonl',
    'append:events.jsonl',
    'append:events.jsonl',
    'append:events.jsonl',
    'file:manifest.yaml',
    'json:status.json',
    'json:next.json',
  ]);
});
