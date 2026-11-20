import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { interruptSession } from '@nodeint/migent-kernel';
import { expect, test } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { cancelWhenStarted, PRE_ID, ServerProvider, setup } from './interrupt-support.ts';
import { registryOf, tempDir } from './support.ts';

test('an interrupt command that hangs is killed at its timeout and reported failed', async () => {
  const root = tempDir('migent-interrupt-hang-');
  const pidFile = path.join(root, 'hang.pid');
  const provider = new ServerProvider(root);
  provider.interruptCommand = () => ({
    argv: [process.execPath, '-e', `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000)`],
  });
  const startedAt = Date.now();
  const report = await interruptSession(
    provider,
    { agentId: PRE_ID, cwd: root },
    { attempts: 3, retryDelayMs: 10, commandTimeoutMs: 500 },
  );
  expect(report?.outcome).toBe('failed');
  expect(report?.attempts).toBe(1);
  expect(Date.now() - startedAt).toBeLessThan(10_000);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(() => process.kill(pid, 0)).toThrow();
}, 30_000);

test('a provider without an interrupt command is stopped without the exit grace period', async () => {
  const { workspace, sessionId } = setup();
  const provider = new ServerProvider(tempDir('migent-interrupt-nograce-'));
  (provider as { interruptCommand?: unknown }).interruptCommand = undefined;
  // Production grace setting, not the shortened one the unit tests use.
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 30);
  expect(runner.executor.interruptExitGraceMs).toBe(3000);
  const stop = cancelWhenStarted(provider);
  const startedAt = Date.now();
  let cancelledAt = 0;
  const timer = setInterval(() => {
    if (cancelledAt === 0 && existsSync(provider.pidFile)) cancelledAt = Date.now();
  }, 10);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner);
  clearInterval(timer);
  stop();
  expect(result.status).toBe('cancelled');
  // Killing the group takes well under the 3s grace; the grace must not be added on top.
  expect(Date.now() - Math.max(cancelledAt, startedAt)).toBeLessThan(2900);
}, 30_000);
