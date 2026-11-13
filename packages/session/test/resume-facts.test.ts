import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ClientRegistry, TurnUsage } from '@nodeint/migent-kernel';
import { afterEach, describe, expect, test } from 'vitest';

import { resumeFacts } from '../src/resume-facts.ts';
import { FakeClient, registryOf } from './support.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const COMPLETED = '2026-10-20T00:00:10.000+00:00';

function turn(seq: number, usage: Record<string, unknown> | null): Record<string, unknown> {
  const details: Record<string, unknown> = { turn: seq, agent_id: 'agent-1', argv: ['fake'] };
  if (usage !== null) details.usage = usage;
  return { v: 2, seq, event: 'provider.turn_completed', timestamp: COMPLETED, execution_id: 'e1', provider: 'fake', data: {}, details };
}

function session(
  events: Record<string, unknown>[],
  execution: Record<string, unknown> = {},
): { workspace: string } {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-resume-facts-'));
  dirs.push(workspace);
  const directory = path.join(workspace, '.migent', 'sessions', 's1');
  mkdirSync(path.join(directory, 'executions', 'e1'), { recursive: true });
  writeFileSync(path.join(directory, 'status.json'), JSON.stringify({ session_id: 's1', status: 'active' }));
  writeFileSync(path.join(directory, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : ''));
  writeFileSync(
    path.join(directory, 'executions', 'e1', 'execution.json'),
    JSON.stringify({
      execution_id: 'e1',
      execution_order: 1,
      stage_id: 'a',
      client: 'fake',
      status: 'completed',
      created_at: '2026-10-20T00:00:00.000+00:00',
      completed_at: COMPLETED,
      ...execution,
    }),
  );
  return { workspace };
}

type Read = (capture: Record<string, unknown>) => { values: Partial<TurnUsage>; cumulative: string[] };

const BLANK: TurnUsage = {
  input_tokens: null,
  output_tokens: null,
  reasoning_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  cost_usd: null,
};

function clientWith(usage: Read): ClientRegistry {
  const client = new FakeClient();
  client.readUsage = (capture) => {
    const read = usage(capture);
    return { values: { ...BLANK, ...read.values }, cumulative: read.cumulative };
  };
  return registryOf({ fake: client });
}

describe('resumeFacts', () => {
  const incremental = clientWith((capture) => ({
    values: {
      input_tokens: capture.input as number,
      cache_read_tokens: capture.read as number,
      cache_write_tokens: capture.write as number,
    },
    cumulative: [],
  }));

  test('the last captured turn gives input + cache read + cache write', () => {
    const { workspace } = session([
      turn(1, { input: 100, read: 0, write: 50 }),
      turn(2, { input: 10, read: 900, write: 40 }),
    ]);
    expect(resumeFacts(workspace, { sessionId: 's1', executionId: 'e1' }, incremental)).toEqual({ completedAt: COMPLETED, contextTokens: 950 });
  });

  test('cumulative usage is normalized against the previous turn', () => {
    const cumulative = clientWith((capture) => ({ values: { input_tokens: capture.total as number }, cumulative: ['input_tokens'] }));
    const { workspace } = session([turn(1, { total: 100 }), turn(2, { total: 130 })]);
    expect(resumeFacts(workspace, { sessionId: 's1', executionId: 'e1' }, cumulative).contextTokens).toBe(30);
  });

  test('no captured turn leaves the context unknown', () => {
    const { workspace } = session([turn(1, null)]);
    expect(resumeFacts(workspace, { sessionId: 's1', executionId: 'e1' }, incremental)).toEqual({ completedAt: COMPLETED, contextTokens: null });
  });

  test('an unknown execution reads as unknown', () => {
    const { workspace } = session([]);
    expect(resumeFacts(workspace, { sessionId: 's1', executionId: 'missing' }, incremental)).toEqual({ completedAt: null, contextTokens: null });
  });

  test('a cancelled source uses the cancel time', () => {
    const cancelledAt = '2026-10-20T00:05:00.000+00:00';
    const { workspace } = session([turn(1, { input: 5, read: 5, write: 5 })], { status: 'cancelled', completed_at: cancelledAt });
    expect(resumeFacts(workspace, { sessionId: 's1', executionId: 'e1' }, incremental)).toEqual({ completedAt: cancelledAt, contextTokens: 15 });
  });
});
