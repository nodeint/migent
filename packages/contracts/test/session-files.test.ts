import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { isValid, SESSION_CLIENT_EVENT_FORMS, SESSION_EVENTS, SessionDiagnostics, SessionEvent, SessionExecution, SessionManifest, SessionStatusFile } from '../src/index.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'session');
const json = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
const lines = (name: string): unknown[] => readFileSync(path.join(fixtures, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);

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
