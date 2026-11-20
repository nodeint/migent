import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

/** Durable writes in order, and a switch that makes the status.json fold fail. */
const writes: string[] = [];
const failure = { armed: false, foldFails: false };

vi.mock('@nodeint/migent-kernel', async (importOriginal) => {
  const original = await importOriginal<typeof import('@nodeint/migent-kernel')>();
  return {
    ...original,
    appendLineSynced: (file: string, line: string): void => {
      writes.push(`append:${path.basename(file)}`);
      original.appendLineSynced(file, line);
    },
    writeFileAtomic: (file: string, text: string): void => {
      writes.push(`file:${path.basename(file)}`);
      original.writeFileAtomic(file, text);
      if (failure.armed && path.basename(file) === 'workflow.frozen.yaml') failure.foldFails = true;
    },
    writeJsonAtomic: (file: string, value: unknown): void => {
      writes.push(`json:${path.basename(file)}`);
      if (failure.foldFails && path.basename(file) === 'status.json') throw new Error('fold failed');
      (original.writeJsonAtomic as (f: string, v: unknown) => void)(file, value);
    },
  };
});

const { createWorkflowSession } = await import('@nodeint/migent-session');
const { AgentToolRunner, executeNamedWorkflow } = await import('../src/index.ts');
const { registryOf, ScriptedClient, tempDir: makeTempDir } = await import('./support.ts');

const roots: string[] = [];
beforeEach(() => {
  writes.length = 0;
  failure.armed = false;
  failure.foldFails = false;
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CONFIG = `\
agents:
  fake:
    client:
      type: fake
    model: m1
roles:
  developer:
    agent: fake
`;

const WORKFLOW = `schema_version: 8
id: wf
stages:
  - id: one
    role: developer
  - id: two
    role: developer
    depends_on: [one]
`;

const EDITED = WORKFLOW + '  - id: three\n    role: developer\n    depends_on: [two]\n';

function setup(): { workspace: string; sessionId: string; directory: string } {
  const workspace = makeTempDir('migent-refreeze-');
  roots.push(workspace);
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), WORKFLOW, 'utf8');
  const sessionId = createWorkflowSession(workspace, 'wf', { task: 'task' });
  return { workspace, sessionId, directory: path.join(workspace, '.migent', 'sessions', sessionId) };
}

const eventNames = (directory: string): unknown[] =>
  readFileSync(path.join(directory, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { event: unknown }).event);

async function stopAfterFirstStage(
  workspace: string,
  sessionId: string,
): Promise<InstanceType<typeof AgentToolRunner>> {
  const provider = new ScriptedClient(['status: complete\n\none', 'status: complete\n\ntwo']);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, maxDispatches: 1 }, runner);
  expect(first.code).toBe(5);
  return runner;
}

test('refreshing a workflow writes the freeze, then the event, then folds status.json', async () => {
  const { workspace, sessionId, directory } = setup();
  const runner = await stopAfterFirstStage(workspace, sessionId);
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), EDITED, 'utf8');
  writes.length = 0;
  await executeNamedWorkflow(workspace, { sessionId, refreshWorkflow: true, maxDispatches: 1 }, runner);
  const start = writes.indexOf('file:workflow.frozen.yaml');
  const refresh = writes.slice(start, writes.indexOf('json:status.json', start) + 1);
  expect(refresh).toEqual(['file:workflow.frozen.yaml', 'append:events.jsonl', 'json:status.json']);
  expect(eventNames(directory)).toContain('workflow.refreshed');
});

test('a failed fold restores the previous freeze and keeps the appended workflow.refreshed event', async () => {
  const { workspace, sessionId, directory } = setup();
  const runner = await stopAfterFirstStage(workspace, sessionId);
  const freezeFile = path.join(directory, 'workflow.frozen.yaml');
  const before = readFileSync(freezeFile, 'utf8');
  const eventsBefore = eventNames(directory).length;
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), EDITED, 'utf8');
  writes.length = 0;
  failure.armed = true;
  await expect(executeNamedWorkflow(workspace, { sessionId, refreshWorkflow: true }, runner)).rejects.toThrow('fold failed');
  failure.armed = false;
  failure.foldFails = false;
  expect(writes.slice(writes.indexOf('file:workflow.frozen.yaml'), writes.indexOf('file:workflow.frozen.yaml') + 4)).toEqual(['file:workflow.frozen.yaml', 'append:events.jsonl', 'json:status.json', 'file:workflow.frozen.yaml']);
  expect(readFileSync(freezeFile, 'utf8')).toBe(before);
  const names = eventNames(directory);
  expect(names).toHaveLength(eventsBefore + 1);
  expect(names.at(-1)).toBe('workflow.refreshed');
});
