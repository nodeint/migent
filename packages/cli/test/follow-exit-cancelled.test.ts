import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { main } from '../src/index.ts';
import { capture } from './support.ts';

const EXECUTION_ID = '0001-implement--attempt-01';

test('session follow --exit-when-done exits 130 on a cancelled session', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-cli-'));
  try {
    const root = path.join(workspace, '.migent');
    const sessionDirectory = path.join(root, 'sessions', 'run-1');
    const executionDirectory = path.join(sessionDirectory, 'executions', EXECUTION_ID);
    mkdirSync(executionDirectory, { recursive: true });
    writeFileSync(path.join(root, 'config.yaml'), 'schema_version: 1\n', 'utf8');
    writeFileSync(path.join(sessionDirectory, 'events.jsonl'), `${JSON.stringify({ event: 'provider.heartbeat', stage_id: 'implement', timestamp: '2026-09-19T10:20:30Z' })}\n`, 'utf8');
    writeFileSync(path.join(executionDirectory, 'execution.json'), JSON.stringify({ execution_id: EXECUTION_ID, stage_id: 'implement', status: 'cancelled' }), 'utf8');
    writeFileSync(
      path.join(sessionDirectory, 'status.json'),
      JSON.stringify({ session_id: 'run-1', status: 'cancelled', latest_execution_id: EXECUTION_ID, updated_at: '2026-09-19T10:20:30Z', task: 'ship the feature' }),
      'utf8',
    );
    const followed = await capture(() => main(['session', 'follow', 'run-1', '--exit-when-done'], workspace));
    expect(followed.value).toBe(130);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
