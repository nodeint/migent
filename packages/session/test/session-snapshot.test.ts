import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ExtensionCatalog } from '@nodeint/migent-contracts';
import { parseWorkflowMapping } from '@nodeint/migent-workflow';
import { afterEach, describe, expect, test } from 'vitest';

import { orderedEvents, readExecutions } from '../src/session-facts.ts';
import { writeWorkflowFreeze } from '../src/session-freeze.ts';
import { readBasisSeq, readSessionSnapshot } from '../src/session-snapshot.ts';
import { normalizeTurns, resolveExecutionClients } from '../src/usage-normalize.ts';
import { FakeClient, registryOf } from './support.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TIME = '2026-10-20T00:00:10.000+00:00';
const turn = (seq: number, input: number): Record<string, unknown> => ({
  v: 2, seq, event: 'provider.turn_completed', timestamp: TIME, execution_id: 'e1', provider: 'fake', data: {},
  details: { turn: seq, agent_id: 'a1', argv: ['fake'], usage: { input } },
});
const plugin = (seq: number): Record<string, unknown> => ({
  v: 2, seq, event: 'plugin.hook_invoked', timestamp: TIME, data: { plugin: 'p', invocation_id: 'i' },
});

function session(events: Record<string, unknown>[]): string {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-snapshot-'));
  dirs.push(workspace);
  const directory = path.join(workspace, '.migent', 'sessions', 's1');
  mkdirSync(path.join(directory, 'executions', 'e1'), { recursive: true });
  writeFileSync(path.join(directory, 'status.json'), JSON.stringify({ session_id: 's1', status: 'active' }));
  writeFileSync(path.join(directory, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  writeFileSync(
    path.join(directory, 'executions', 'e1', 'execution.json'),
    JSON.stringify({ execution_id: 'e1', execution_order: 1, stage_id: 'a', client: 'fake', status: 'completed', created_at: TIME, completed_at: TIME }),
  );
  return workspace;
}

const client = (): ReturnType<typeof registryOf> => {
  const fake = new FakeClient();
  fake.readUsage = (capture) => ({
    values: {
      input_tokens: capture.input as number, output_tokens: null, reasoning_tokens: null,
      cache_read_tokens: null, cache_write_tokens: null, cost_usd: null,
    },
    cumulative: [],
  });
  return registryOf({ fake });
};

test('turns equal normalizeTurns output for the same session', () => {
  const workspace = session([turn(1, 10), turn(2, 20)]);
  const clients = client();
  const snapshot = readSessionSnapshot(workspace, 's1', clients);
  const directory = path.join(workspace, '.migent', 'sessions', 's1');
  const events = orderedEvents(directory);
  const expected = normalizeTurns(events, resolveExecutionClients(events, readExecutions(directory), { status: 'active' }), clients);
  expect(snapshot.turns.map((item) => ({ executionId: item.execution_id, usage: item.usage, captured: item.captured })))
    .toEqual(expected.map((item) => ({
      executionId: item.executionId, usage: { ...item.usage }, captured: item.captured,
    })));
  expect(snapshot.turns).toHaveLength(2);
  expect(snapshot.corrupt).toBe(false);
});

test('basis_seq ignores plugin events', () => {
  const workspace = session([turn(1, 10), turn(2, 20), plugin(3), plugin(4)]);
  expect(readSessionSnapshot(workspace, 's1', client()).basis_seq).toBe(2);
  expect(readBasisSeq(workspace, 's1')).toBe(2);
});

test('events are the ordered parsed events, with their execution identity', () => {
  const workspace = session([turn(1, 10), plugin(2), turn(3, 20)]);
  const snapshot = readSessionSnapshot(workspace, 's1', client());
  const expected = orderedEvents(path.join(workspace, '.migent', 'sessions', 's1'));
  expect(snapshot.events).toEqual(expected.map((event) => ({
    v: event.v, seq: event.seq, event: event.event, timestamp: event.timestamp, executionId: event.executionId,
    stageId: event.stageId, summary: event.summary, data: event.data, raw: event.raw,
  })));
  expect(snapshot.events.map((event) => event.seq)).toEqual([1, 2, 3]);
  expect(snapshot.events[0]?.executionId).toBe('e1');
});

test('execution_clients equals resolveExecutionClients', () => {
  const workspace = session([turn(1, 10)]);
  const snapshot = readSessionSnapshot(workspace, 's1', client());
  const directory = path.join(workspace, '.migent', 'sessions', 's1');
  const resolved = resolveExecutionClients(orderedEvents(directory), readExecutions(directory), { status: 'active' });
  expect(snapshot.execution_clients).toEqual(Object.fromEntries(resolved));
  expect(snapshot.execution_clients).toEqual({ e1: 'fake' });
});

describe('the snapshot workflow carries no extension data', () => {
  // TypeBox schemas are plain JSON Schema objects.
  const field = (key: string): never => {
    const schema: Record<string, unknown> = { type: 'object', properties: { [key]: { type: 'string' } }, required: [] };
    return schema as never;
  };
  // The plugin is absent from the production catalog, so only the freeze's record says who owned these keys.
  const catalog: ExtensionCatalog = [{
    plugin: 'gone', version: 1, fields: { workflow: field('gone_flow'), stage: field('gone_stage'), agent: field('gone_agent') },
  }];
  const inline = { client: { type: 'fake' }, model: 'm1', gone_agent: 'x', unowned: 'kept' };

  function frozen(agent: Record<string, unknown>): string {
    const workspace = session([]);
    const directory = path.join(workspace, '.migent', 'sessions', 's1');
    writeFileSync(path.join(workspace, '.migent', 'config.yaml'), 'roles:\n  dev: {}\n');
    const document = parseWorkflowMapping(
      { schema_version: 8, id: 'flow', gone_flow: 'a', stages: [{ id: 'one', role: 'dev', depends_on: [], gone_stage: 'b', agent }] },
      'flow.yaml',
      { extensions: catalog },
    );
    writeWorkflowFreeze(directory, { workspace, workflow: document, extensions: catalog });
    return workspace;
  }

  test('no extensions field, and an inline stage agent loses recorded keys but keeps unowned fields', () => {
    const { workflow } = readSessionSnapshot(frozen(inline), 's1', client());
    const stage = (workflow as { stages: Record<string, Record<string, unknown>> }).stages.one;
    expect(workflow).not.toHaveProperty('extensions');
    expect(stage).not.toHaveProperty('extensions');
    expect(stage.agent).toEqual({ kind: 'inline', value: { client: { type: 'fake' }, model: 'm1', unowned: 'kept' } });
  });
});
