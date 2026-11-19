import { describe, expect, test } from 'vitest';

import { chooseAction, evaluateExpiry, parseDuration, selectPolicy } from '../src/prompt-cache-ttl/policy.ts';
import { validatePolicies } from '../src/prompt-cache-ttl/validate.ts';

const policies = {
  claude: { match: { client: 'claude', model: 'claude-*' }, cache_ttl: '5m', margin: '30s', on_expired: 'ask' },
  codex: { match: { client: 'codex' }, cache_ttl: '1h' },
  default: { cache_ttl: '10m', on_expired: 'fresh' },
};

const messages = (policyMap: unknown) => (
  validatePolicies({ options: { policies: policyMap }, agents: [], stages: [] }).map((problem) => problem.message)
);
const PREFIX = 'plugins.prompt_cache_ttl.policies';

describe('parseDuration', () => {
  test('reads seconds, minutes and hours', () => {
    expect(parseDuration('30s')).toBe(30);
    expect(parseDuration('5m')).toBe(300);
    expect(parseDuration('1h')).toBe(3600);
  });
  test('rejects other forms', () => {
    for (const bad of ['5', 'm', '5 m', '1.5h', '-5m', '', 5, null]) expect(parseDuration(bad)).toBeNull();
  });
});

describe('validatePolicies', () => {
  test('accepts a valid set and an absent one', () => {
    expect(messages(policies)).toEqual([]);
    expect(messages(undefined)).toEqual([]);
  });
  test('reports each kind of problem', () => {
    expect(messages({ a: { margin: '5s' } })).toEqual([`${PREFIX}.a.cache_ttl is required.`]);
    expect(messages({ a: { cache_ttl: '5 minutes' } })[0]).toMatch(/cache_ttl must be a positive duration/);
    expect(messages({ a: { cache_ttl: '5m', margin: '5m' } })).toEqual([`${PREFIX}.a.margin must be shorter than \`cache_ttl\`.`]);
    expect(messages({ a: { cache_ttl: '5m', match: {} } })[0]).toMatch(/match must set/);
    expect(messages({ default: { cache_ttl: '5m', match: { client: 'x' } } })[0]).toMatch(/not allowed on the `default`/);
    expect(messages({ a: { cache_ttl: '5m', extra: 1 } })).toEqual([`${PREFIX}.a.extra is not used by Migent.`]);
    expect(messages({ a: { cache_ttl: '5m', on_expired: 'never' } })[0]).toMatch(/on_expired must be one of/);
    expect(messages({ a: { cache_ttl: '5m', min_context_tokens: -1 } })[0]).toMatch(/min_context_tokens/);
    expect(messages([])).toEqual([`${PREFIX} must be a mapping.`]);
  });
  test('an agent naming an unknown policy, or matching several, is a problem at the agent', () => {
    const agent = (extensions: Record<string, unknown>) => ({ path: 'agents.dev', client: 'claude', model: 'claude-x', extensions });
    const run = (map: unknown, extensions: Record<string, unknown>) => validatePolicies({
      options: { policies: map }, agents: [agent(extensions)], stages: [],
    });
    expect(run(undefined, { prompt_cache_ttl: { policy: 'typo' } })[0]?.message).toMatch(/Unknown resume policy: typo/);
    const both = { a: { match: { client: 'claude' }, cache_ttl: '5m' }, b: { match: { model: 'claude-*' }, cache_ttl: '1h' } };
    expect(run(both, {})[0]?.message).toMatch(/Several resume policies match/);
    expect(run(both, { prompt_cache_ttl: { policy: 'a' } })).toEqual([]);
  });
});

describe('selectPolicy', () => {
  test('an explicit name wins over a match', () => {
    expect(selectPolicy(policies, { agentPolicy: 'codex', client: 'claude', model: 'claude-x' })?.name).toBe('codex');
  });
  test('a single glob match', () => {
    expect(selectPolicy(policies, { client: 'claude', model: 'claude-sonnet' })).toMatchObject({ name: 'claude', cacheTtlSec: 300, marginSec: 30, onExpired: 'ask' });
    expect(selectPolicy(policies, { client: 'codex', model: 'any' })?.name).toBe('codex');
  });
  test('falls back to default, then to null', () => {
    expect(selectPolicy(policies, { client: 'other', model: 'm' })?.name).toBe('default');
    expect(selectPolicy({ claude: policies.claude }, { client: 'other', model: 'm' })).toBeNull();
    expect(selectPolicy(undefined, { client: 'claude', model: 'm' })).toBeNull();
  });
  test('an explicit unknown name is an error even when there is no policy map', () => {
    expect(() => selectPolicy(undefined, { agentPolicy: 'typo', client: 'fake', model: 'm1' })).toThrow(/Unknown resume policy: typo/);
    expect(() => selectPolicy({}, { agentPolicy: 'typo', client: 'fake', model: 'm1' })).toThrow(/typo/);
    expect(selectPolicy({}, { client: 'fake', model: 'm1' })).toBeNull();
  });
});

describe('evaluateExpiry', () => {
  const policy = selectPolicy({ p: { cache_ttl: '5m', margin: '30s', min_context_tokens: 1000 } }, { agentPolicy: 'p', client: 'c', model: 'm' })!;
  const at = (seconds: number, contextTokens: number | null = 5000, lastActivityAt: string | null = '2026-01-01T00:00:00Z') =>
    evaluateExpiry(policy, { lastActivityAt, completedAt: null, contextTokens }, new Date(Date.parse('2026-01-01T00:00:00Z') + seconds * 1000));
  test('the threshold is ttl minus margin', () => {
    expect(at(270).expired).toBe(true);
    expect(at(269).expired).toBe(false);
    expect(at(270).estimate).toMatchObject({ idleSec: 270, thresholdSec: 270 });
  });
  test('a small context is not guarded, an unknown one is', () => {
    expect(at(1000, 999).expired).toBe(false);
    expect(at(1000, 1000).expired).toBe(true);
    expect(at(1000, null).expired).toBe(true);
  });
  test('no activity time is not expired; negative idle is clamped', () => {
    expect(at(1000, 5000, null)).toMatchObject({ expired: false, estimate: { idleSec: null } });
    expect(at(-100).estimate.idleSec).toBe(0);
    expect(at(-100).expired).toBe(false);
  });
});

describe('chooseAction', () => {
  const policy = selectPolicy(policies, { agentPolicy: 'claude', client: 'c', model: 'm' })!;
  test('stage, then policy, then ask', () => {
    expect(chooseAction('fresh', policy)).toEqual({ action: 'fresh', origin: 'stage' });
    expect(chooseAction(null, policy)).toEqual({ action: 'ask', origin: 'policy' });
    expect(chooseAction(null, selectPolicy(policies, { agentPolicy: 'codex', client: 'c', model: 'm' })!)).toEqual({ action: 'ask', origin: 'default' });
  });
});

describe('model globs', () => {
  const byModel = (model: string, glob: string) => selectPolicy(
    { literal: { match: { model: glob }, cache_ttl: '5m' } },
    { client: 'c', model },
  )?.name ?? null;
  test('regex characters in a glob are literal', () => {
    expect(byModel('model.1', 'model.1')).toBe('literal');
    expect(byModel('modelX1', 'model.1')).toBeNull();
    expect(byModel('model[', 'model[')).toBe('literal');
    expect(byModel('a+b', 'a+b')).toBe('literal');
    expect(byModel('aab', 'a+b')).toBeNull();
  });
  test('wildcards still match', () => {
    expect(byModel('claude-opus', 'claude-*')).toBe('literal');
    expect(byModel('claude-1', 'claude-?')).toBe('literal');
  });
});
