import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DIAGNOSTICS_SCHEMA_VERSION,
  EXECUTION_SCHEMA_VERSION,
  isValid,
  LIFECYCLE_EVENT_VERSION,
  MANIFEST_SCHEMA_VERSION,
  NEXT_SCHEMA_VERSION,
  QUESTIONS_SCHEMA_VERSION,
  SessionLockFile,
  SessionManifest,
  SessionNext,
  SessionQuestions,
  SessionStatusFile,
  validationIssues,
} from '@nodeint/migent-contracts';
import { EXECUTION_SCHEMA_VERSION as WRITER_EXECUTION_VERSION } from '@nodeint/migent-kernel';
import { parseYamlDocument } from '@nodeint/migent-workflow';
import { afterEach, expect, test } from 'vitest';

import { MANIFEST_SCHEMA_EVENT_LOG } from '../src/constants.ts';
import { publishNextSuggestions } from '../src/next-handoff.ts';
import { EVENT_VERSION } from '../src/session-events.ts';
import { readFoldedStatus } from '../src/session-fold.ts';
import { SessionLock } from '../src/session-lock.ts';
import { createAgentSession, createPreparedSession, createWorkflowSession } from '../src/session-records.ts';
import { SESSION_CONFIG } from './support.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'migent-file-writers-'));
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
  return root;
}

const sessionDirectory = (root: string, id: string) => path.join(root, '.migent', 'sessions', id);
const manifestOf = (root: string, id: string): unknown => parseYamlDocument(readFileSync(path.join(sessionDirectory(root, id), 'manifest.yaml'), 'utf8'));
const expectValid = (schema: Parameters<typeof isValid>[0], value: unknown): void => {
  expect(validationIssues(schema, value)).toEqual([]);
  expect(isValid(schema, value)).toBe(true);
};

test('version constants of the writers equal the contracts constants', () => {
  expect(EVENT_VERSION).toBe(LIFECYCLE_EVENT_VERSION);
  expect(MANIFEST_SCHEMA_EVENT_LOG).toBe(MANIFEST_SCHEMA_VERSION);
  expect(QUESTIONS_SCHEMA_VERSION).toBe(1);
  expect(NEXT_SCHEMA_VERSION).toBe(1);
  expect(WRITER_EXECUTION_VERSION).toBe(EXECUTION_SCHEMA_VERSION);
  expect(DIAGNOSTICS_SCHEMA_VERSION).toBe(2);
});

test('manifest.yaml and status.json of a workflow, prepared and role session validate', () => {
  const root = workspace();
  const ids = [
    createWorkflowSession(root, 'plan', { task: 'Plan the work' }),
    createPreparedSession(root, { title: 'Prepared target', workflowId: 'implement' }),
    createAgentSession(root, 'developer', 'Fix it'),
  ];
  for (const id of ids) {
    expectValid(SessionManifest, manifestOf(root, id));
    expectValid(SessionStatusFile, JSON.parse(readFileSync(path.join(sessionDirectory(root, id), 'status.json'), 'utf8')));
    expect(readFoldedStatus(root, sessionDirectory(root, id)).session_id).toBe(id);
  }
});

test('session.lock validates while held', () => {
  const root = workspace();
  const id = createWorkflowSession(root, 'plan', { task: 'Plan the work' });
  const lock = SessionLock.acquire(sessionDirectory(root, id));
  try {
    expectValid(SessionLockFile, JSON.parse(readFileSync(path.join(sessionDirectory(root, id), 'session.lock'), 'utf8')));
  } finally {
    lock.release();
  }
});

test('next.json and questions.json validate', () => {
  const root = workspace();
  const id = createWorkflowSession(root, 'plan', { task: 'Plan the work' });
  const directory = sessionDirectory(root, id);
  mkdirSync(path.join(directory, 'outputs'));
  writeFileSync(path.join(directory, 'outputs', 'plan.md'), 'The approved plan\n');
  writeFileSync(path.join(directory, 'status.json'), JSON.stringify({ session_id: id, workflow_id: 'plan', status: 'completed', outputs: { approved_plan: { path: 'outputs/plan.md' } } }));
  const published = publishNextSuggestions(root, id);
  expectValid(SessionNext, JSON.parse(readFileSync(published.path!, 'utf8')));
  expectValid(SessionQuestions, JSON.parse(readFileSync(path.join(directory, 'questions.json'), 'utf8')));
});

test('a prepared then activated session writes valid lifecycle events', async () => {
  const { activatePreparedSession } = await import('../src/session-records.ts');
  const { SESSION_EVENTS } = await import('@nodeint/migent-contracts');
  const root = workspace();
  const prior = createWorkflowSession(root, 'plan', { task: 'Plan the work' });
  const directory = sessionDirectory(root, prior);
  mkdirSync(path.join(directory, 'outputs'));
  writeFileSync(path.join(directory, 'outputs', 'plan.md'), 'The approved plan\n');
  writeFileSync(path.join(directory, 'status.json'), JSON.stringify({ session_id: prior, workflow_id: 'plan', status: 'completed', outputs: { approved_plan: { path: 'outputs/plan.md' } } }));
  const prepared = createPreparedSession(root, { title: 'Prepared target', workflowId: 'implement', priorSessionId: prior });
  writeFileSync(path.join(sessionDirectory(root, prepared), 'task.md'), 'A task\n');
  activatePreparedSession(root, prepared);
  const schemas = new Map(SESSION_EVENTS.map((entry) => [entry.event, entry.schema]));
  const names = readFileSync(path.join(sessionDirectory(root, prepared), 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const event of names) {
    const name = String(event.event);
    expect(validationIssues(schemas.get(name)!, event), name).toEqual([]);
  }
  // session.prepared, session.activated and handoff.bound are the events this path writes.
  expect(names.map((event) => event.event)).toEqual(expect.arrayContaining(['session.created', 'handoff.bound', 'session.activated']));
  expect(['session.prepared', 'session.activated', 'handoff.bound'].every((name) => schemas.has(name))).toBe(true);
});
