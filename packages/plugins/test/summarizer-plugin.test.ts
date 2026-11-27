import type {
  PluginCallContext, PluginHandler, PluginHookInput, PluginSessionArtifacts, PluginSessionSnapshot,
} from '@nodeint/migent-contracts';
import { expect, test } from 'vitest';

import { buildPrompt, renderSummary, summarizerPlugin, summaryHeader } from '../src/index.ts';

const ARTIFACTS: PluginSessionArtifacts = { basis_seq: 9, entries: [] };

function snapshotOf(over: Record<string, unknown> = {}): PluginSessionSnapshot {
  const snapshot: unknown = {
    basis_seq: 9,
    corrupt: false,
    status: { session_id: 's1', workflow_id: 'wf', status: 'question' },
    executions: [{ id: 'e1', order: 1, stageId: 'one', attempt: 1, status: 'completed', outcomeStatus: 'question' }],
    events: [{ seq: 9, event: 'x.y', timestamp: '2026-01-02T03:04:05Z', stageId: null, summary: null }],
    ...over,
  };
  return snapshot as PluginSessionSnapshot;
}

type Handlers = Map<string, PluginHandler>;

async function activated(options: Record<string, unknown>): Promise<Handlers> {
  const handlers: Handlers = new Map();
  const migent = { events: { on: (kind: string, handler: PluginHandler) => handlers.set(kind, handler) } };
  await summarizerPlugin.activate(options, migent as never);
  return handlers;
}

function callOf(snapshot: PluginSessionSnapshot, reply: { text: string | null; error: string | null }) {
  const prompts: string[] = [];
  const call = {
    session: { snapshot: async () => snapshot, artifacts: async () => ARTIFACTS },
    agents: { invoke: async (prompt: string) => { prompts.push(prompt); return reply; } },
    artifacts: { propose: (name: string, content: string) => ({ kind: 'artifact', name, content }) },
  };
  return { call: call as unknown as PluginCallContext, prompts };
}

const INPUT = { hook: 'session.stopped', session: { id: 's1' } } as unknown as PluginHookInput;
const OK = { text: '## Done\nx\n## Current state\ny\n## Needs attention\nz', error: null };

test('default triggers register session.completed and session.stopped only', async () => {
  expect([...(await activated({})).keys()].sort()).toEqual(['session.completed', 'session.stopped']);
});

test('execution adds execution.finished, [] registers nothing, [completed] only completion', async () => {
  expect([...(await activated({ triggers: ['execution'] })).keys()]).toEqual(['execution.finished']);
  expect((await activated({ triggers: [] })).size).toBe(0);
  expect([...(await activated({ triggers: ['completed'] })).keys()]).toEqual(['session.completed']);
});

test('session.stopped writes only for a configured status', async () => {
  const handler = (await activated({ triggers: ['blocked'] })).get('session.stopped')!;
  const { call, prompts } = callOf(snapshotOf(), OK);
  expect(await handler(INPUT, call)).toEqual([{ kind: 'none' }]);
  expect(prompts).toHaveLength(0);
});

test('a session without executions yields none and makes no agent call', async () => {
  const handler = (await activated({})).get('session.completed')!;
  const { call, prompts } = callOf(snapshotOf({ executions: [] }), OK);
  expect(await handler(INPUT, call)).toEqual([{ kind: 'none' }]);
  expect(prompts).toHaveLength(0);
});

test('a summary has the header, the title line and one agent call', async () => {
  const handler = (await activated({})).get('session.stopped')!;
  const { call, prompts } = callOf(snapshotOf(), OK);
  const [proposal] = await handler(INPUT, call);
  expect(prompts).toHaveLength(1);
  expect(proposal).toMatchObject({ kind: 'artifact', name: 'summary.md' });
  const { content } = proposal as { content: string };
  expect(content.split('\n').slice(0, 2)).toEqual([
    summaryHeader(9), '# Session s1 · wf · question · 2026-01-02T03:04:05Z',
  ]);
  expect(content).toContain('## Needs attention');
});

test('an agent error, blank text and a corrupt snapshot throw', async () => {
  const handler = (await activated({})).get('session.stopped')!;
  await expect(handler(INPUT, callOf(snapshotOf(), { text: null, error: 'boom' }).call)).rejects.toThrow('boom');
  await expect(handler(INPUT, callOf(snapshotOf(), { text: '  \n', error: null }).call)).rejects.toThrow('no text');
  await expect(handler(INPUT, callOf(snapshotOf({ corrupt: true }), OK).call)).rejects.toThrow('corrupt');
});

test('renderSummary drops a title line the agent wrote', () => {
  const content = renderSummary('s1', snapshotOf(), '# My own title\n\n## Done\nx');
  expect(content).not.toContain('My own title');
  expect(content).toContain('## Done');
});

test('validate reports a duplicate trigger with its index', () => {
  const validate = summarizerPlugin.validate!;
  const input = (triggers: unknown) => ({ options: { triggers }, agents: [], stages: [] });
  expect(validate(input(['completed', 'question']))).toEqual([]);
  expect(validate(input([]))).toEqual([]);
  expect(validate({ options: {}, agents: [], stages: [] })).toEqual([]);
  expect(validate(input(['completed', 'question', 'completed']))).toMatchObject([
    { path: 'plugins.summarizer.triggers[2]' },
  ]);
});

test('the prompt lists questions of every waiting stage, including an older execution', () => {
  const snapshot = snapshotOf({
    status: {
      session_id: 's1', status: 'question',
      questions: [
        { question: 'Scope?', stage_id: 'a', execution_id: 'e1', options: [{ id: 'A', label: 'Small' }] },
        { question: 'Name?', stage_id: 'b', execution_id: 'e2', options: [] },
      ],
    },
    executions: [
      { id: 'e1', order: 1, stageId: 'a', status: 'completed', outcomeStatus: 'question' },
      { id: 'e2', order: 2, stageId: 'b', status: 'completed', outcomeStatus: 'question' },
      { id: 'e3', order: 3, stageId: 'c', status: 'completed', outcomeStatus: 'complete' },
    ],
  });
  const prompt = buildPrompt('s1', snapshot, ARTIFACTS);
  expect(prompt).toContain('Scope?');
  expect(prompt).toContain('Small');
  expect(prompt).toContain('Name?');
});

test('a completed execution with a blocked outcome keeps its blocker text', () => {
  const snapshot = snapshotOf({
    executions: [{ id: 'e1', order: 1, stageId: 'a', status: 'completed', outcomeStatus: 'blocked', blocker: 'No access' }],
  });
  const prompt = buildPrompt('s1', snapshot, ARTIFACTS);
  expect(prompt).toContain('## Blocked outcomes');
  expect(prompt).toContain('blocker: No access');
});

test('artifact content, shortened and skipped names reach the prompt; provider events do not', () => {
  const artifacts: PluginSessionArtifacts = {
    basis_seq: 9,
    entries: [
      { execution_id: 'e1', stage_id: 'one', path: 'prd.md', content: 'PRD BODY', truncated: false, skipped: null },
      { execution_id: 'e1', stage_id: 'one', path: 'big.md', content: 'part', truncated: true, skipped: null },
      { execution_id: 'e1', stage_id: 'one', path: 'img.bin', content: null, truncated: false, skipped: 'binary' },
    ],
  };
  const snapshot = snapshotOf({
    events: [
      { seq: 1, event: 'provider.turn', timestamp: 't', stageId: null, summary: null },
      { seq: 2, event: 'execution.finished', timestamp: 't', stageId: 'one', summary: null },
    ],
  });
  const prompt = buildPrompt('s1', snapshot, artifacts);
  expect(prompt).toContain('PRD BODY');
  expect(prompt).toContain('one/big.md: shortened');
  expect(prompt).toContain('one/img.bin: binary');
  expect(prompt).not.toContain('provider.turn');
  expect(prompt).toContain('execution.finished');
});

test.each([['blocked'], ['expired'], ['question']])('session.stopped writes for a configured %s status', async (status) => {
  const handler = (await activated({ triggers: [status] })).get('session.stopped')!;
  const { call, prompts } = callOf(snapshotOf({ status: { session_id: 's1', workflow_id: 'wf', status } }), OK);
  const [proposal] = await handler(INPUT, call);
  expect(prompts).toHaveLength(1);
  expect((proposal as { content: string }).content.split('\n')[1]).toContain(status);
});

test('session.stopped ignores a completed status even when every stop trigger is set', async () => {
  const handler = (await activated({ triggers: ['blocked', 'expired', 'question'] })).get('session.stopped')!;
  const { call, prompts } = callOf(snapshotOf({ status: { session_id: 's1', status: 'completed' } }), OK);
  expect(await handler(INPUT, call)).toEqual([{ kind: 'none' }]);
  expect(prompts).toHaveLength(0);
});

test('the execution handler summarizes whatever the status is', async () => {
  const handler = (await activated({ triggers: ['execution'] })).get('execution.finished')!;
  const { call, prompts } = callOf(snapshotOf({ status: { session_id: 's1', status: 'active' } }), OK);
  const [proposal] = await handler(INPUT, call);
  expect(prompts).toHaveLength(1);
  expect(proposal).toMatchObject({ kind: 'artifact', name: 'summary.md' });
});
