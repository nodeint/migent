import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { EXECUTION_STATUSES, SESSION_EVENT_TEMPLATES, SESSION_EVENTS, SESSION_FILES, SESSION_STATUS_CATALOG, STAGE_OUTCOME_STATUSES } from '../src/index.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Test files, plus the shared event-validation helper the guards call. */
function testFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'fixtures') continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...testFiles(full));
    else if (entry.endsWith('.test.ts') || entry === 'event-validation.ts') out.push(full);
  }
  return out;
}

const OWNERS = ['session', 'engine', 'kernel', 'adapters', 'cli'];
const allTests = OWNERS.flatMap((name) => testFiles(path.join(repo, 'packages', name, 'test')));

/** A writer test counts only if it calls a contracts validator or the shared helper. */
const VALIDATES = /\b(assertEventsValid|validationIssues|isValid)\(/;
const validating = allTests.map((file) => readFileSync(file, 'utf8')).filter((text) => VALIDATES.test(text));
const corpus = validating.join('\n');

/** Registered names no writer emits, each with its reason. */
const NEVER_WRITTEN = new Map<string, string>([
  ['session.corrupt', 'An unreadable-state status; nothing appends it as an event.'],
  ['session.expired', 'Derived from a pending `resume.expired`; the fold computes it and no writer appends it.'],
]);

const templated = new Set([
  ...SESSION_STATUS_CATALOG.map((row) => `session.${row.name}`),
  ...EXECUTION_STATUSES.map((status) => `execution.${status}`),
  ...STAGE_OUTCOME_STATUSES.map((status) => `stage.${status}`),
]);

test('the template heads in the registry cover every templated event name', () => {
  const heads = new Set(SESSION_EVENT_TEMPLATES.map((entry) => entry.head));
  for (const name of templated) expect(heads.has(`${name.split('.')[0]}.`), name).toBe(true);
});

test('every registered event name is named by a test file that validates records against a schema', () => {
  const names = SESSION_EVENTS.map((entry) => entry.event).filter((name) => !NEVER_WRITTEN.has(name));
  // Templated names are matched by status: a validating file must name the full event or build it from the status.
  const uncovered = names.filter((name) => {
    if (corpus.includes(name)) return false;
    if (!templated.has(name)) return true;
    const [family, status] = name.split('.');
    return !new RegExp(`['"\`]${family}\\.${status}['"\`]|${family}\\.\\$\\{`).test(corpus);
  });
  expect(uncovered).toEqual([]);
});

test('every session file key is exercised by a writer test', () => {
  const guards = ['session-file-writers.test.ts', 'session-event-guard.test.ts', 'event-validation.ts', 'diagnostics-file.test.ts'];
  const text = guards.flatMap((name) => OWNERS.flatMap((owner) => testFiles(path.join(repo, 'packages', owner, 'test')).filter((file) => file.endsWith(name)))).map((file) => readFileSync(file, 'utf8')).join('\n');
  const schemaNames: Record<string, string> = {
    manifest: 'SessionManifest', status: 'SessionStatusFile', lock: 'SessionLockFile', execution: 'SessionExecution', questions: 'SessionQuestions',
    'execution-questions': 'ExecutionQuestions', 'execution-input': 'ExecutionInput', next: 'SessionNext', diagnostics: 'SessionDiagnostics', events: 'SessionEvent',
  };
  for (const entry of SESSION_FILES) {
    expect(schemaNames[entry.key], `no schema name for ${entry.key}`).toBeDefined();
    expect(text.includes(schemaNames[entry.key]), entry.key).toBe(true);
  }
});

test('the never-written exemptions are registered and few', () => {
  const names = new Set(SESSION_EVENTS.map((entry) => entry.event));
  for (const name of NEVER_WRITTEN.keys()) expect(names.has(name), name).toBe(true);
  expect(NEVER_WRITTEN.size).toBeLessThanOrEqual(2);
});
