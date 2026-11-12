import { describe, expect, test } from 'vitest';

import { exitCode, isValid, SESSION_STATUS_CATALOG, SessionStatus, SessionStatusEntry } from '../src/index.ts';

const ROWS = {
  active: { kind: 'running', precedence: null, exit: null, ends_scheduling: false, manually_completable: true, refreshable: true, closed: false, terminal_fields: false, manifest: null, resolution: null },
  prepared: { kind: 'not_started', precedence: null, exit: null, ends_scheduling: false, manually_completable: false, refreshable: false, closed: false, terminal_fields: false, manifest: 'read', resolution: null },
  completed: { kind: 'terminal', precedence: null, exit: 'completed', ends_scheduling: true, manually_completable: false, refreshable: false, closed: true, terminal_fields: true, manifest: 'mirrored', resolution: null },
  blocked: { kind: 'stage_stop', precedence: 0, exit: 'blocked', ends_scheduling: true, manually_completable: true, refreshable: true, closed: false, terminal_fields: true, manifest: 'mirrored', resolution: { event: 'session.active', from: 'blocked' } },
  question: { kind: 'stage_stop', precedence: 1, exit: 'question', ends_scheduling: true, manually_completable: true, refreshable: true, closed: false, terminal_fields: false, manifest: 'mirrored', resolution: { event: 'session.active', from: 'question' } },
  cancelled: { kind: 'session_stop', precedence: null, exit: 'cancelled', ends_scheduling: true, manually_completable: true, refreshable: false, closed: true, terminal_fields: true, manifest: 'mirrored', resolution: { event: 'session.active', from: 'cancelled' } },
  corrupt: { kind: 'invalid', precedence: null, exit: null, ends_scheduling: false, manually_completable: false, refreshable: false, closed: false, terminal_fields: false, manifest: null, resolution: null },
};

describe('session status catalog', () => {
  test('rows and order are pinned', () => {
    expect(SESSION_STATUS_CATALOG.map((row) => row.name)).toEqual(Object.keys(ROWS));
    for (const row of SESSION_STATUS_CATALOG) {
      const { name, ...rest } = row;
      expect(rest).toEqual(ROWS[name]);
    }
  });

  test('every row validates and its exit resolves', () => {
    for (const row of SESSION_STATUS_CATALOG) {
      expect(isValid(SessionStatusEntry, row)).toBe(true);
      if (row.exit) expect([0, 1, 9, 130]).toContain(exitCode(row.exit));
    }
  });

  test('SessionStatus enumerates the names in order', () => {
    const names = (SessionStatus as unknown as { anyOf: { const: string }[] }).anyOf.map((item) => item.const);
    expect(names).toEqual(SESSION_STATUS_CATALOG.map((row) => row.name));
  });
});
