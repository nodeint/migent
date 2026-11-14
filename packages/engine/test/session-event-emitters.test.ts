import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isValid, SESSION_CLIENT_EVENT_FORMS, SESSION_EVENTS, validationIssues } from '@nodeint/migent-contracts';
import { createWorkflowSession, SessionStore } from '@nodeint/migent-session';
import { expect, test } from 'vitest';

import { ProviderEventReporter } from '../src/index.ts';
import { tempDir } from './support.ts';

/** Names the integration guard cannot reach with a fake client, written through the real reporter. */
const CLIENT_EVENTS: [string, Record<string, unknown>][] = [
  ['provider.quota', { retry_at: '2026-01-01T00:00:00Z', window: '5h' }],
  ['provider.interrupt', { agent_id: 'a1', reason: 'cancelled', phase: 'after', outcome: 'interrupted', attempts: 1 }],
  ['provider.heartbeat', { elapsed_seconds: 30 }],
  ['provider.warning', {}],
  ['provider.error', {}],
  ['provider.cancelled', {}],
  ['provider.turn_failed', {}],
  ['provider.exit_anomaly', { turn: 1, client: 'fake', exit_code: 1, signal: null, origin: 'exit-only', accepted: true, reason: null }],
  ['provider.item_started', { kind: 'tool' }],
  ['provider.item_completed', { kind: 'tool' }],
  ['verify.heartbeat', { turn: 1, command: 'x', elapsed_seconds: 5 }],
];

test('client events the reporter writes validate against their registered schema', () => {
  const workspace = tempDir('migent-emitters-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), ['schema_version: 7', 'roles:', '  dev:', '    agent: { client: { type: fake }, model: fake }', ''].join('\n'));
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), ['schema_version: 3', 'id: wf', 'stages:', '  - { id: one, role: dev }', ''].join('\n'));
  const sessionId = createWorkflowSession(workspace, 'wf', { task: 'Do it' });
  const store = new SessionStore(workspace);
  const [, , context] = store.loadOrCreate({
    client: 'fake', model: 'm', options: null, workspace, sessionId, stageId: 'one', stageAttempt: 1, executionOrder: 1, prompt: 'go',
  });
  const reporter = new ProviderEventReporter({ store, context }, { client: 'fake', model: 'm' });
  const schemas = new Map(SESSION_EVENTS.map((entry) => [entry.event, entry.schema]));
  for (const [name, details] of CLIENT_EVENTS) {
    reporter.emit(name, 'summary', details);
    const lines = [
      path.join(workspace, '.migent', 'sessions', sessionId, 'events.jsonl'),
      path.join(context.directory, 'stream.jsonl'),
    ].flatMap((file) => {
      try {
        return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        return [];
      }
    });
    const record = lines.filter((line) => line.event === name).at(-1);
    expect(record, name).toBeDefined();
    expect(validationIssues(schemas.get(name)!, record), name).toEqual([]);
    expect(validationIssues((SESSION_CLIENT_EVENT_FORMS as Record<string, { current: Parameters<typeof isValid>[0] }>)[name].current, record), `${name} current`).toEqual([]);
  }
});

test('every correction policy event is registered and its client form accepts a record', async () => {
  const { CORRECTION_POLICY } = await import('@nodeint/migent-kernel');
  const registered = new Set(SESSION_EVENTS.map((entry) => entry.event));
  for (const rule of Object.values(CORRECTION_POLICY)) {
    expect(registered.has(rule.event), rule.event).toBe(true);
    const record = { v: 2, seq: 1, event: rule.event, timestamp: '2026-01-01T00:00:00.000+00:00', client: 'fake', session_id: '1', details: { turn: 1, error_kind: 'x' } };
    expect(validationIssues(SESSION_CLIENT_EVENT_FORMS[rule.event].current, record), rule.event).toEqual([]);
  }
  // Named here so the coverage guard sees the names the policy table owns.
  expect(['stage.output_missing', 'question.file_invalid', 'handoff.file_invalid', 'response.contract_invalid'].every((name) => registered.has(name))).toBe(true);
});
