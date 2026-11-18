import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { SealedMetricsCurrent, validationIssues } from '@nodeint/migent-contracts';
import { AgentToolRunner, executeNamedWorkflow } from '@nodeint/migent-engine';
import { buildMetrics } from '@nodeint/migent-plugins';
import { readSessionSnapshot, sealedMetricsPath } from '@nodeint/migent-session';
import { afterEach, expect, test } from 'vitest';

import { blank, tempDir } from './metrics-fixtures.ts';
import { registryOf, removeWorkspace, ScriptedClient } from './support.ts';

// P1 baseline with a real child process: the plugin's builder equals the core seal of a real fake-client run.
// Retired with `sessionMetrics` in P3.

const workspaces: string[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) removeWorkspace(workspace);
});

test('plugin output equals the core seal on a real fake-client run', async () => {
  const workspace = tempDir('migent-equiv-');
  workspaces.push(workspace);
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), `\
agents:
  fake:
    client:
      type: fake
    model: m1
roles:
  developer:
    agent: fake
`, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'once.yaml'), `\
id: once
stages:
  - id: implement
    role: developer
    depends_on: []
    produces:
      artifact: notes.md
completion:
  stage: implement
`, 'utf8');
  const provider = new ScriptedClient(['status: complete\n\ndone'], ['# notes\n']);
  provider.captureUsage = () => ({ total: 4 });
  provider.readUsage = () => ({ values: { ...blank(), input_tokens: 4 }, cumulative: [] });
  const clients = registryOf({ fake: provider });
  const result = await executeNamedWorkflow(workspace, { workflowId: 'once', task: 'write notes' }, new AgentToolRunner(clients, 10));
  expect(result.status).toBe('completed');
  const sealed = readFileSync(sealedMetricsPath(workspace, result.sessionId), 'utf8');
  const actual = buildMetrics(result.sessionId, readSessionSnapshot(workspace, result.sessionId, clients));
  expect(JSON.stringify(actual, null, 2)).toBe(sealed);
  expect(validationIssues(SealedMetricsCurrent, actual)).toEqual([]);
});

