import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { AgentToolRunner } from '@nodeint/migent-engine';
import { createPluginRegistry } from '@nodeint/migent-plugins';
import { afterEach, expect, test } from 'vitest';

import { cliHooks } from '../src/hooks.ts';
import { main } from '../src/index.ts';
import { cleanWorkspaces, workspaces } from './complete-fixtures.ts';
import { capture, registryOf, ScriptedClient, writeFakeWorkflowWorkspace } from './support.ts';

afterEach(() => {
  cliHooks.runner = null;
  cleanWorkspaces();
});

const DOWNSTREAM_FLOW =
  'schema_version: 8\nid: plan\nstages:\n  - { id: draft, role: planner }\ndownstream:\n  - workflow: implement\n    task: Build it\n';

test('a role session under the real default registry gets no recommendation prompt and no file', async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: DOWNSTREAM_FLOW });
  workspaces.push(workspace);
  const client = new ScriptedClient(['status: complete\n\nrole answer']);
  const runner = new AgentToolRunner(registryOf({ fake: client }), 10);
  runner.pluginRegistry = createPluginRegistry();
  cliHooks.runner = runner;

  const ran = await capture(() => main(['session', 'run', '--role', 'planner', '--task', 'demo', '--prompt', 'hello', '--json'], workspace));

  expect(ran.value).toBe(0);
  expect(client.calls).toHaveLength(1);
  expect(client.calls[0]?.prompt).not.toContain('Response extensions');
  expect(client.calls[0]?.prompt).not.toContain('`next`');
  const sessions = path.join(workspace, '.migent', 'sessions');
  const [id] = readdirSync(sessions);
  expect(id).toBeDefined();
  expect(existsSync(path.join(sessions, id ?? '', 'plugins', 'next'))).toBe(false);
});
