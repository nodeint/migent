import { describe, expect, test } from 'vitest';

import {
  ConfigurationError,
  effectiveOnExpired,
  evaluateResume,
  mergeConfigLayers,
  parseDuration,
  selectResumePolicy,
  validateResumePolicies,
} from '../src/index.ts';

const policies = {
  claude: { match: { client: 'claude', model: 'claude-*' }, cache_ttl: '5m', margin: '30s', on_expired: 'ask' },
  codex: { match: { client: 'codex' }, cache_ttl: '1h' },
  default: { cache_ttl: '10m', on_expired: 'fresh' },
};

const messages = (config: Record<string, unknown>) => validateResumePolicies(config).map((error) => error.message);

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

describe('validateResumePolicies', () => {
  test('accepts a valid set and an absent one', () => {
    expect(validateResumePolicies({ resume_policies: policies })).toEqual([]);
    expect(validateResumePolicies({})).toEqual([]);
  });
  test('reports each kind of problem', () => {
    expect(messages({ resume_policies: { a: { margin: '5s' } } })).toEqual(['resume_policies.a.cache_ttl is required.']);
    expect(messages({ resume_policies: { a: { cache_ttl: '5 minutes' } } })[0]).toMatch(/cache_ttl must be a positive duration/);
    expect(messages({ resume_policies: { a: { cache_ttl: '5m', margin: '5m' } } })).toEqual([
      'resume_policies.a.margin must be shorter than `cache_ttl`.',
    ]);
    expect(messages({ resume_policies: { a: { cache_ttl: '5m', match: {} } } })[0]).toMatch(/match must set/);
    expect(messages({ resume_policies: { default: { cache_ttl: '5m', match: { client: 'x' } } } })[0]).toMatch(/not allowed on the `default`/);
    expect(messages({ resume_policies: { a: { cache_ttl: '5m', extra: 1 } } })).toEqual(['resume_policies.a.extra is not used by Migent.']);
    expect(messages({ resume_policies: { a: { cache_ttl: '5m', on_expired: 'never' } } })[0]).toMatch(/on_expired must be one of/);
    expect(messages({ resume_policies: { a: { cache_ttl: '5m', min_context_tokens: -1 } } })[0]).toMatch(/min_context_tokens/);
    expect(messages({ resume_policies: [] })).toEqual(['resume_policies must be a mapping.']);
  });
});

describe('selectResumePolicy', () => {
  test('an explicit name wins over a match', () => {
    expect(selectResumePolicy(policies, { agentPolicy: 'codex', client: 'claude', model: 'claude-x' })?.name).toBe('codex');
  });
  test('a single glob match', () => {
    const picked = selectResumePolicy(policies, { client: 'claude', model: 'claude-sonnet' });
    expect(picked).toMatchObject({ name: 'claude', cacheTtlSec: 300, marginSec: 30, onExpired: 'ask' });
    expect(selectResumePolicy(policies, { client: 'codex', model: 'any' })?.name).toBe('codex');
  });
  test('falls back to default, then to null', () => {
    expect(selectResumePolicy(policies, { client: 'other', model: 'm' })?.name).toBe('default');
    expect(selectResumePolicy({ claude: policies.claude }, { client: 'other', model: 'm' })).toBeNull();
    expect(selectResumePolicy(undefined, { client: 'claude', model: 'm' })).toBeNull();
  });
  test('a named default is allowed', () => {
    expect(selectResumePolicy(policies, { agentPolicy: 'default', client: 'claude', model: 'claude-x' })?.name).toBe('default');
  });
  test('an explicit unknown name is an error even when there is no policy map (R6)', () => {
    expect(() => selectResumePolicy(undefined, { agentPolicy: 'typo', client: 'fake', model: 'm1' })).toThrow(/Unknown resume policy: typo/);
    expect(() => selectResumePolicy(null, { agentPolicy: 'typo', client: 'fake', model: 'm1' })).toThrow(/typo/);
    expect(() => selectResumePolicy({}, { agentPolicy: 'typo', client: 'fake', model: 'm1' })).toThrow(/typo/);
    // An agent that names nothing keeps today's behavior: no map, no gate.
    expect(selectResumePolicy(undefined, { client: 'fake', model: 'm1' })).toBeNull();
    expect(selectResumePolicy({}, { client: 'fake', model: 'm1' })).toBeNull();
  });

  test('several matches and an unknown name are errors', () => {
    const both = { a: { match: { client: 'claude' }, cache_ttl: '5m' }, b: { match: { model: 'claude-*' }, cache_ttl: '1h' } };
    expect(() => selectResumePolicy(both, { client: 'claude', model: 'claude-x' })).toThrow(/Several resume policies match/);
    expect(() => selectResumePolicy(policies, { agentPolicy: 'nope', client: 'claude', model: 'm' })).toThrow(ConfigurationError);
  });
});

describe('config merge', () => {
  test('a local layer overrides one key of a policy', () => {
    const { config } = mergeConfigLayers({ resume_policies: { claude: policies.claude } }, { resume_policies: { claude: { on_expired: 'fresh' } } });
    expect(config.resume_policies).toEqual({ claude: { ...policies.claude, on_expired: 'fresh' } });
  });
});

describe('evaluateResume', () => {
  const policy = selectResumePolicy({ p: { cache_ttl: '5m', margin: '30s', min_context_tokens: 1000 } }, { agentPolicy: 'p', client: 'c', model: 'm' })!;
  const at = (seconds: number, contextTokens: number | null = 5000, completedAt: string | null = '2026-01-01T00:00:00Z') => evaluateResume(policy, {
    completedAt,
    now: new Date(Date.parse('2026-01-01T00:00:00Z') + seconds * 1000),
    contextTokens,
  });
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
  test('no completed_at is not expired; negative idle is clamped', () => {
    expect(at(1000, 5000, null)).toMatchObject({ expired: false, estimate: { idleSec: null } });
    expect(at(-100).estimate.idleSec).toBe(0);
    expect(at(-100).expired).toBe(false);
  });
});

describe('effectiveOnExpired', () => {
  const policy = selectResumePolicy(policies, { agentPolicy: 'claude', client: 'c', model: 'm' });
  test('human, then stage, then policy, then ask', () => {
    expect(effectiveOnExpired({ decision: 'resume', stageOnExpired: 'fresh', policy })).toEqual({ action: 'resume', origin: 'human' });
    expect(effectiveOnExpired({ stageOnExpired: 'fresh', policy })).toEqual({ action: 'fresh', origin: 'stage' });
    expect(effectiveOnExpired({ policy })).toEqual({ action: 'ask', origin: 'policy' });
    expect(effectiveOnExpired({ policy: selectResumePolicy(policies, { agentPolicy: 'codex', client: 'c', model: 'm' }) })).toEqual({ action: 'ask', origin: 'default' });
    expect(effectiveOnExpired({})).toEqual({ action: 'ask', origin: 'default' });
  });
  test('a policy action applies when nothing overrides it', () => {
    expect(effectiveOnExpired({ policy: selectResumePolicy(policies, { agentPolicy: 'default', client: 'c', model: 'm' }) })).toEqual({ action: 'fresh', origin: 'policy' });
  });
});
