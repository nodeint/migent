import type { PluginCallContext, PluginEventProposal, PluginHandler, PluginHookInput, PluginSessionSnapshot } from '@nodeint/migent-contracts';
import { metricsPlugin } from '@nodeint/migent-plugins';
import { expect, test } from 'vitest';

function handler(): PluginHandler {
  let found: PluginHandler | undefined;
  void metricsPlugin.activate({}, {
    config: { options: {}, core: () => undefined },
    log: { info: () => undefined, warn: () => undefined },
    operations: { intercept: () => undefined },
    events: { on: (_kind, fn) => { found = fn; } },
  });
  if (found === undefined) throw new Error('no handler registered');
  return found;
}

const snapshot = (over: Partial<PluginSessionSnapshot>): PluginSessionSnapshot => ({
  basis_seq: 1, status: { status: 'completed', workflow_id: 'w' }, corrupt: false, executions: [], events: [],
  workflow: null, turns: [], execution_clients: {}, exit_anomalies: [], ...over,
});

async function run(snap: PluginSessionSnapshot): Promise<readonly PluginEventProposal[]> {
  const call = {
    session: { snapshot: () => Promise.resolve(snap), resumeFacts: () => Promise.reject(new Error('unused')) },
    artifacts: { propose: (name: string, content: string): PluginEventProposal => ({ kind: 'artifact', name, content }) },
  } as unknown as PluginCallContext;
  const input = { hook: 'session.completed', session: { id: 's1' } } as unknown as PluginHookInput;
  return handler()(input, call);
}

test.each([
  ['corrupt', { corrupt: true, status: {} }],
  ['agent', { status: { status: 'completed', workflow_id: 'agent' } }],
  ['not completed', { status: { status: 'active', workflow_id: 'w' } }],
])('%s snapshot proposes nothing', async (_name, over) => {
  expect(await run(snapshot(over as Partial<PluginSessionSnapshot>))).toEqual([{ kind: 'none' }]);
});

test('a completed snapshot proposes one metrics.json artifact', async () => {
  const proposals = await run(snapshot({}));
  expect(proposals).toHaveLength(1);
  const [proposal] = proposals;
  expect(proposal).toMatchObject({ kind: 'artifact', name: 'metrics.json' });
  const { content } = proposal as { content: string };
  expect(JSON.parse(content)).toMatchObject({ session_id: 's1', status: 'completed' });
  expect(content.endsWith('\n')).toBe(false);
});
