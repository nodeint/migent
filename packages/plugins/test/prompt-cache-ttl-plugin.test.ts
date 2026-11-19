import { isValid, type PluginBeforeProposal, type PluginCallContext, type PluginResumeFacts } from '@nodeint/migent-contracts';
import { expect, test } from 'vitest';

import { promptCacheTtlPlugin } from '../src/prompt-cache-ttl/index.ts';

type Before = (request: Record<string, unknown>, call: PluginCallContext) => Promise<PluginBeforeProposal>;

/** The `before` interceptor the plugin registers for the given options; null when it registers none. */
function interceptorOf(options: Record<string, unknown>): Before | null {
  let before: Before | null = null;
  const intercept = (_target: string, hooks: { before: Before }): void => {
    before = hooks.before;
  };
  const migent = { operations: { intercept } };
  promptCacheTtlPlugin.activate(options, migent as never);
  return before;
}

const POLICIES = { policies: { fake: { match: { client: 'fake' }, cache_ttl: '1m', on_expired: 'ask' } } };
const REQUEST = { stage_id: 'review', source_execution_id: 'e1', client: 'fake', model: 'm1' };

function callOf(
  facts: PluginResumeFacts,
  extensions: { stage?: Record<string, unknown>; agent?: Record<string, unknown> } = {},
): PluginCallContext {
  return {
    config: { extensions: {
      agent: () => extensions.agent ?? null, stage: () => extensions.stage ?? null,
    } },
    session: { resumeFacts: () => Promise.resolve(facts) },
  } as unknown as PluginCallContext;
}

const longAgo = { completedAt: '2020-01-01T00:00:00Z', lastActivityAt: '2020-01-01T00:00:00Z', contextTokens: 5000 };
const justNow = () => {
  const now = new Date().toISOString();
  return { completedAt: now, lastActivityAt: now, contextTokens: 5000 };
};

test('no policies: the plugin registers no interceptor', () => {
  expect(interceptorOf({})).toBeNull();
  expect(interceptorOf({ policies: {} })).toBeNull();
});

test('a live cache resumes', async () => {
  const decide = interceptorOf(POLICIES)!;
  expect(await decide(REQUEST, callOf(justNow()))).toEqual({
    kind: 'short_circuit', output: { verdict: 'resume', expired: null },
  });
});

test('an expired cache takes the policy action and reports the facts', async () => {
  const decide = interceptorOf(POLICIES)!;
  const proposal = await decide(REQUEST, callOf(longAgo));
  expect(proposal).toMatchObject({
    kind: 'short_circuit',
    output: { verdict: 'ask', expired: { action: 'ask', origin: 'policy', policy: 'fake' } },
  });
});

test('a stage override wins over the policy action', async () => {
  const decide = interceptorOf(POLICIES)!;
  const proposal = await decide(REQUEST, callOf(longAgo, { stage: { prompt_cache_ttl: { on_expired: 'fresh' } } }));
  expect(proposal).toMatchObject({ output: { verdict: 'fresh', expired: { origin: 'stage' } } });
});

test('a client no policy matches resumes without reading the facts', async () => {
  const decide = interceptorOf(POLICIES)!;
  const call = callOf(longAgo);
  Object.assign(call.session, { resumeFacts: () => Promise.reject(new Error('read')) });
  expect(await decide({ ...REQUEST, client: 'other' }, call)).toEqual({
    kind: 'short_circuit', output: { verdict: 'resume', expired: null },
  });
});

test('the manifest schema describes the policy fields', () => {
  const check = (entry: unknown): boolean => isValid(promptCacheTtlPlugin.manifest.configSchema, entry);
  expect(check({ policies: { p: { cache_ttl: '5m', on_expired: 'ask' } } })).toBe(true);
  expect(check({ policies: [] })).toBe(false);
  expect(check({ policies: { p: { cache_ttl: '5m', on_expired: 'nope' } } })).toBe(false);
  expect(check({ policies: { p: { min_context_tokens: -1 } } })).toBe(false);
  expect(check({ policies: { p: {} } })).toBe(false);
  expect(check({ policies: { p: { cache_ttl: 5 } } })).toBe(false);
  expect(check({ policies: { p: { cache_ttl: 'invalid' } } })).toBe(false);
  expect(check({ policies: { p: { cache_ttl: '5m', margin: 30 } } })).toBe(false);
  expect(check({ policies: { p: { cache_ttl: '1h', margin: '30s' } } })).toBe(true);
});
