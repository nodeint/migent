import type { PluginCallContext, PluginHookInput, PluginResponseContractInput, PluginSessionSnapshot } from '@nodeint/migent-contracts';
import { expect, test } from 'vitest';

import { buildRecommendations, nextPlugin, nextResponseContract } from '../src/index.ts';

const DOWNSTREAM = [{ workflow: 'implement', task: 'Build it' }, { workflow: 'ship', task: 'Release it' }];

const contractInput = (workflow: Record<string, unknown>): PluginResponseContractInput =>
  ({ options: {}, stage: { id: 'one' }, workflow, extensions: { stage: {}, workflow: {} } });

test('without downstream there is no contract', () => {
  expect(nextResponseContract(contractInput({ id: 'wf' }))).toBeNull();
  expect(nextResponseContract(contractInput({ id: 'wf', downstream: [] }))).toBeNull();
});

test('with downstream the payload is required and the instructions list ids, tasks and abstention', () => {
  const contract = nextResponseContract(contractInput({ downstream: DOWNSTREAM }));
  expect(contract?.required).toBe(true);
  expect(contract?.instructions).toContain('- `implement`: Build it');
  expect(contract?.instructions).toContain('- `ship`: Release it');
  expect(contract?.instructions).toContain('`null` to abstain');
});

interface Row {
  id: string; stageId: string; order: number; outcomeStatus: string; responseExtension?: unknown;
}
const row = (id: string, stageId: string, order: number, outcomeStatus: string, responseExtension?: unknown): Row => ({
  id, stageId, order, outcomeStatus, ...(responseExtension === undefined ? {} : { responseExtension }),
});
const pick = (workflow: string | null, reason = 'because') => ({ workflow, reason });

function snapshotOf(executions: Row[], downstream: unknown = DOWNSTREAM): PluginSessionSnapshot {
  const snapshot: unknown = { corrupt: false, executions, workflow: downstream === null ? { id: 'wf' } : { id: 'wf', downstream } };
  return snapshot as PluginSessionSnapshot;
}

test('the latest completed run of each stage is used, in execution order, values unchanged', () => {
  const document = buildRecommendations(snapshotOf([
    row('e1', 'design', 1, 'complete', pick('ship', ' padded reason ')),
    row('e2', 'review', 2, 'complete', pick('implement')),
    row('e3', 'design', 3, 'complete', pick(null, 'nothing fits')),
  ]));
  expect(document).toEqual({
    schema_version: 1,
    recommendations: [
      { stage_id: 'review', execution_id: 'e2', workflow: 'implement', reason: 'because' },
      { stage_id: 'design', execution_id: 'e3', workflow: null, reason: 'nothing fits' },
    ],
  });
});

test('a latest completion without a payload hides an older payload', () => {
  const document = buildRecommendations(snapshotOf([
    row('e1', 'design', 1, 'complete', pick('ship')),
    row('e2', 'design', 2, 'complete'),
  ]));
  expect(document.recommendations).toEqual([]);
});

test('skipped, failed, blocked and question rows are ignored for selection', () => {
  const document = buildRecommendations(snapshotOf([
    row('e1', 'design', 1, 'complete', pick('ship')),
    row('e2', 'design', 2, 'skipped', pick('implement')),
    row('e3', 'design', 3, 'failed', pick('implement')),
    row('e4', 'design', 4, 'blocked', pick('implement')),
    row('e5', 'design', 5, 'question', pick('implement')),
  ]));
  expect(document.recommendations.map((entry) => entry.execution_id)).toEqual(['e1']);
});

test('only an unknown non-null workflow carries a warning', () => {
  const document = buildRecommendations(snapshotOf([
    row('e1', 'a', 1, 'complete', pick('elsewhere')),
    row('e2', 'b', 2, 'complete', pick(null)),
    row('e3', 'c', 3, 'complete', pick('ship')),
  ]));
  expect(document.recommendations.map((entry) => entry.warning)).toEqual(['elsewhere is not in downstream', undefined, undefined]);
  expect(Object.hasOwn(document.recommendations[1]!, 'warning')).toBe(false);
});

type Handler = (input: PluginHookInput, call: PluginCallContext) => Promise<readonly Record<string, unknown>[]>;

async function propose(snapshot: PluginSessionSnapshot): Promise<readonly Record<string, unknown>[]> {
  let handler: Handler | null = null;
  const migent = { events: { on: (_kind: string, fn: Handler) => { handler = fn; } } };
  nextPlugin.activate({}, migent as never);
  const call = {
    session: { snapshot: () => Promise.resolve(snapshot) },
    artifacts: { propose: (name: string, content: string) => ({ kind: 'artifact', name, content }) },
  };
  return handler!({} as PluginHookInput, call as unknown as PluginCallContext);
}

const documentOf = (proposals: readonly Record<string, unknown>[]) =>
  JSON.parse(String(proposals[0]?.content)) as unknown;

test('no row ever carried a payload: nothing is proposed', async () => {
  expect(await propose(snapshotOf([row('e1', 'one', 1, 'complete')]))).toEqual([{ kind: 'none' }]);
});

test('payload rows are written as the document', async () => {
  const proposals = await propose(snapshotOf([row('e1', 'one', 1, 'complete', pick('ship'))]));
  expect(proposals[0]).toMatchObject({ kind: 'artifact', name: 'recommendations.json' });
  expect(documentOf(proposals)).toEqual({
    schema_version: 1,
    recommendations: [{ stage_id: 'one', execution_id: 'e1', workflow: 'ship', reason: 'because' }],
  });
});

test('payload rows that select nothing write an empty list', async () => {
  const proposals = await propose(snapshotOf([
    row('e1', 'one', 1, 'complete', pick('ship')), row('e2', 'one', 2, 'complete'),
  ]));
  expect(documentOf(proposals)).toEqual({ schema_version: 1, recommendations: [] });
});

test('payload rows with a frozen workflow that has no downstream write an empty list', async () => {
  const proposals = await propose(snapshotOf([row('e1', 'one', 1, 'complete', pick('ship'))], null));
  expect(documentOf(proposals)).toEqual({ schema_version: 1, recommendations: [] });
});
