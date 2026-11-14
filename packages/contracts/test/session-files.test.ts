import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import type { ClientEventCurrent, ClientEventHistorical, SessionEventName, SessionEventRecord } from '../src/index.ts';
import * as contracts from '../src/index.ts';
import { EXECUTION_STATUSES, FIXED_LIFECYCLE_EVENTS, isValid, RESUME_EVENTS, SCHEMA_BASE, SESSION_CLIENT_EVENT_FORMS, SESSION_EVENTS, SESSION_FILES, SESSION_STATUS_CATALOG, SessionDiagnostics, SessionEvent, SessionExecution, SessionManifest, SessionStatusFile, STAGE_OUTCOME_STATUSES,STATUS_LIFECYCLE_EVENTS } from '../src/index.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'session');
const json = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
const lines = (name: string): unknown[] => readFileSync(path.join(fixtures, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);

const exportedSchemas = new Set<unknown>(Object.values(contracts).filter((value) => typeof value === 'object' && value !== null));

describe('session file registry (AC1, AC2)', () => {
  test('every file has a unique key, a class, an exported schema and a session/ $id', () => {
    expect(new Set(SESSION_FILES.map((entry) => entry.key)).size).toBe(SESSION_FILES.length);
    for (const entry of SESSION_FILES) {
      expect(['guaranteed', 'known']).toContain(entry.class);
      expect(exportedSchemas.has(entry.schema), entry.key).toBe(true);
      expect((entry.schema as { $id: string }).$id).toMatch(new RegExp(`^${SCHEMA_BASE}/session/`));
    }
  });

  test('event names are unique, classed, exported and cover every templated status', () => {
    const names = SESSION_EVENTS.map((entry) => entry.event);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of SESSION_EVENTS) {
      expect(entry.class).toBe('known');
      expect((entry.schema as { $id: string }).$id).toBe(`${SCHEMA_BASE}/session/event/${entry.event}.json`);
    }
    const exported = new Set<unknown>([
      ...Object.values(FIXED_LIFECYCLE_EVENTS),
      ...Object.values(STATUS_LIFECYCLE_EVENTS),
      ...Object.values(RESUME_EVENTS),
      ...Object.values(SESSION_CLIENT_EVENT_FORMS).map((forms) => forms.schema),
    ]);
    for (const entry of SESSION_EVENTS) expect(exported.has(entry.schema), `${entry.event} exported`).toBe(true);
    for (const status of SESSION_STATUS_CATALOG) expect(names).toContain(`session.${status.name}`);
    for (const status of EXECUTION_STATUSES) expect(names).toContain(`execution.${status}`);
    for (const status of STAGE_OUTCOME_STATUSES) expect(names).toContain(`stage.${status}`);
  });

  test('no session schema closes its objects', () => {
    const walk = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return;
      expect((value as { additionalProperties?: unknown }).additionalProperties).not.toBe(false);
      for (const item of Object.values(value)) walk(item);
    };
    for (const entry of SESSION_FILES) walk(entry.schema);
    for (const entry of SESSION_EVENTS) walk(entry.schema);
  });

  test('generated schema files exist for every session schema', () => {
    const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'session');
    const files = new Set(readdirSync(directory));
    for (const entry of SESSION_FILES) expect(files.has((entry.schema as { $id: string }).$id.split('/').pop()!), entry.key).toBe(true);
  });
});

describe('older versions validate (AC3)', () => {
  test('manifest v1 and unversioned', () => {
    expect(isValid(SessionManifest, json('manifest-v1.json'))).toBe(true);
    expect(isValid(SessionManifest, json('manifest-unversioned.json'))).toBe(true);
    expect(isValid(SessionManifest, { session_id: 's', created_at: 'x', schema_version: 2, workflow_id: 'w' })).toBe(true);
    expect(isValid(SessionManifest, { session_id: 's' })).toBe(false);
  });

  test('events: envelope and per-event schemas', () => {
    const byName = new Map(SESSION_EVENTS.map((entry) => [entry.event, entry.schema]));
    for (const line of lines('events-legacy.jsonl')) {
      expect(isValid(SessionEvent, line)).toBe(true);
      const schema = byName.get((line as { event: string }).event);
      expect(schema, JSON.stringify(line)).toBeDefined();
      expect(isValid(schema!, line), JSON.stringify(line)).toBe(true);
    }
  });

  test('historical client events fail the current form but pass the union', () => {
    const [, , historical] = lines('events-legacy.jsonl');
    const forms = SESSION_CLIENT_EVENT_FORMS['provider.turn_completed']!;
    expect(isValid(forms.current, historical)).toBe(false);
    expect(isValid(forms.historical, historical)).toBe(true);
  });

  test('diagnostics v1, execution without late fields, status v1', () => {
    expect(isValid(SessionDiagnostics, json('diagnostics-v1.json'))).toBe(true);
    expect(isValid(SessionExecution, json('execution-old.json'))).toBe(true);
    expect(isValid(SessionStatusFile, json('status-v1.json'))).toBe(true);
  });
});

// Compile-time consumer checks: the exported event types keep concrete fields and literals.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(): T | undefined => undefined;
assertType<Equal<SessionEventRecord<'task.frozen'>['data']['sha256'], string>>();
assertType<Equal<SessionEventRecord<'task.frozen'>['event'], 'task.frozen'>>();
assertType<Equal<SessionEventRecord<'execution.started'>['data']['execution_order'], number>>();
assertType<Equal<ClientEventCurrent<'provider.exit_anomaly'>['client'], string>>();
assertType<Equal<ClientEventHistorical<'provider.exit_anomaly'>['client'], string | undefined>>();
assertType<Equal<NonNullable<ClientEventCurrent<'verify.failed'>['details']>['red'], number>>();
assertType<Equal<'session.created' extends SessionEventName ? true : false, true>>();
assertType<Equal<'task.bogus' extends SessionEventName ? true : false, false>>();

describe('event type exports', () => {
  test('narrow event records expose their literal event name', () => {
    const record: SessionEventRecord<'task.frozen'> = { event: 'task.frozen', timestamp: 't', data: { sha256: 'x' } };
    expect(isValid(FIXED_LIFECYCLE_EVENTS['task.frozen'], record)).toBe(true);
  });
});
