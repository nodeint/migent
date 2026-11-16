import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { sessionOptions } from '@nodeint/migent-kernel';
import { resolveRoleTarget } from '@nodeint/migent-kernel';
import { createWorkflowSession, SessionStore } from '@nodeint/migent-session';
import { expect, onTestFinished, test } from 'vitest';
import { parse } from 'yaml';

import { bindTarget, invokeOnce, targetFromAgent } from '../src/agent-invocation.ts';
import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { FakeClient, holdSessionLock, registryOf, ScriptedClient, tempDir } from './support.ts';

class EffortClient extends FakeClient {
  public readonly effortOption = 'effort';
}

class EventingClient extends FakeClient {
  public override createEventParser(): (line: string) => Record<string, unknown> | null {
    return () => ({ event: 'provider.warning', summary: 'seen from invokeOnce' });
  }
}

/** A temporary workspace that is removed when the test ends, pass or fail. */
function scratchDir(prefix: string): string {
  const directory = tempDir(prefix);
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeWorkspace(config: string, workflow?: string): string {
  const workspace = scratchDir('migent-invocation-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), config, 'utf8');
  if (workflow !== undefined) writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), workflow, 'utf8');
  return workspace;
}

const config = (model: string, effort = ''): string => [
  'schema_version: 7', 'agents:', '  main:', '    client:', '      type: fake', `    model: ${model}`,
  ...(effort === '' ? [] : [`    effort: ${effort}`]),
  'roles:', '  developer:', '    agent: main', '',
].join('\n');

test('bindTarget gives the adapter, model, validated options and profile', () => {
  const client = new FakeClient();
  const registry = registryOf({ fake: client });
  const target = { client: 'fake', model: 'm1', options: { effort: 'high' } };
  const bound = bindTarget(target, registry);
  expect(bound.client).toBe(client);
  expect(bound.model).toBe('m1');
  expect(bound.resolvedOptions).toEqual({ effort: 'high' });
  expect(bound.profile).toEqual(sessionOptions(client, { effort: 'high' }));
  expect(bound.resolvedOptions).not.toBe(target.options);
});

test('bindTarget rejects invalid options and unknown clients', () => {
  const registry = registryOf({ fake: new FakeClient() });
  expect(() => bindTarget({ client: 'fake', model: 'm', options: { effort: ' ' } }, registry)).toThrow('empty');
  expect(() => bindTarget({ client: 'nope', model: 'm', options: {} }, registry)).toThrow();
});

test('targetFromAgent folds effort like resolveRoleTarget', () => {
  const registry = registryOf({ fake: new EffortClient() });
  const workspace = writeWorkspace(config('m1', 'high'));
  const parsed = parse(readFileSync(path.join(workspace, '.migent', 'config.yaml'), 'utf8')) as Record<string, unknown>;
  const fromAgent = targetFromAgent(parsed, 'main', registry);
  expect(fromAgent).toEqual({ client: 'fake', model: 'm1', options: { effort: 'high' } });
  expect(fromAgent).toEqual(resolveRoleTarget(workspace, 'developer', { registry }));
});

test('a resumed stage keeps its frozen target after the live agent changes', async () => {
  const workflow = [
    'schema_version: 3', 'id: wf', 'stages:',
    '  - { id: one, role: developer }', '  - { id: two, role: developer }', '',
  ].join('\n');
  const workspace = writeWorkspace(config('m1'), workflow);
  const sessionId = createWorkflowSession(workspace, 'wf', { task: 'Do it' });
  const provider = new ScriptedClient(['status: complete\n\ndone', 'status: complete\n\ndone']);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, maxDispatches: 1 }, runner);
  expect(first.status).not.toBe('failed');
  expect(provider.calls).toHaveLength(1);
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), config('m2'), 'utf8');
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner);
  expect(provider.calls.map((call) => call.model)).toEqual(['m1', 'm1']);
}, 30_000);

test('invokeOnce runs one turn with no session or stage', async () => {
  const provider = new FakeClient();
  const bound = bindTarget({ client: 'fake', model: 'm1', options: {} }, registryOf({ fake: provider }));
  const workspace = scratchDir('migent-once-');
  const result = await invokeOnce(bound, 'hello there', { workspace });
  expect(result.invokeError).toBeNull();
  expect(result.exitCode).toBe(0);
  expect(result.responseText).toContain('echo:hello there');
  expect(provider.calls).toHaveLength(1);
  expect(provider.calls[0]).toMatchObject({ model: 'm1', agentId: null, workspace });
});

test('invokeOnce records provider events through the session event log', async () => {
  const workflow = ['schema_version: 3', 'id: wf', 'stages:', '  - { id: one, role: developer }', ''].join('\n');
  const workspace = writeWorkspace(config('m1'), workflow);
  const sessionId = createWorkflowSession(workspace, 'wf', { task: 'Do it' });
  holdSessionLock(workspace, sessionId);
  const store = new SessionStore(workspace);
  const [, , context] = store.loadOrCreate({
    client: 'fake', model: 'm1', options: null, workspace, sessionId, stageId: 'one', stageAttempt: 1, executionOrder: 1, prompt: 'go',
  });
  const bound = bindTarget({ client: 'fake', model: 'm1', options: {} }, registryOf({ fake: new EventingClient() }));
  await invokeOnce(bound, 'hello', { workspace, recordTo: { store, context } });
  const lines = readFileSync(path.join(workspace, '.migent', 'sessions', sessionId, 'events.jsonl'), 'utf8');
  expect(lines).toContain('seen from invokeOnce');
}, 30_000);
