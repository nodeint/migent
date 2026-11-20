import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { AgentToolRunner } from '../src/index.ts';
import { FakeClient, registryOf, tempDir, UnstartableProvider } from './support.ts';

test('MIGENT_DEBUG writes wrapper and executor steps to debug.log for successful and failed runs', async () => {
  const previous = process.env.MIGENT_DEBUG;
  process.env.MIGENT_DEBUG = '1';
  try {
    for (const provider of [new FakeClient(), new UnstartableProvider()]) {
      const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
      const tmp = tempDir('migent-runner-');
      const result = await runner.run({ client: 'fake', model: 'm1', prompt: 'p', workspace: tmp });
      const executionDirectory = path.join(tmp, '.migent', 'sessions', result.session_id, 'executions', result.execution_id);
      const log = readFileSync(path.join(executionDirectory, 'debug.log'), 'utf8');
      expect(log).toContain('wrapper spawned');
      expect(log).toContain('wrapper ready');
      expect(log).toContain('wrapper: listening');
      expect(log).toContain('wrapper: provider spawned');
    }
  } finally {
    if (previous === undefined) delete process.env.MIGENT_DEBUG;
    else process.env.MIGENT_DEBUG = previous;
  }
}, 30_000);
