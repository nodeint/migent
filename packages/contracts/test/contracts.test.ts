import { describe, expect, test } from 'vitest';

import {
  AnyJsonObject,
  CLI_CONTRACTS,
  ConfigLayer,
  isValid,
  LegacyLifecycleEvent,
  LifecycleEventV2,
  SealedMetrics,
  SealedMetricsCurrent,
  SealedMetricsHistorical,
  SessionFollowRecord,
  validationIssues,
  WorkflowSession,
} from '../src/index.ts';

describe('registry', () => {
  test('passthrough contracts are exactly any JSON object', () => {
    for (const entry of CLI_CONTRACTS.filter((item) => item.class === 'passthrough')) {
      expect(entry.schema).toMatchObject({ type: 'object', patternProperties: { '^.*$': {} } });
      expect((entry.schema as { properties?: unknown }).properties).toBeUndefined();
    }
    expect(isValid(SealedMetrics, { session_id: 42, totals: 'opaque' })).toBe(true);
    expect(isValid(SessionFollowRecord, [])).toBe(false);
    expect(isValid(AnyJsonObject, {})).toBe(true);
  });
});

describe('known shapes are opt-in descriptions', () => {
  test('lifecycle event v2 and legacy', () => {
    const v2 = { v: 2, seq: 1, event: 'session.created', timestamp: '2026-10-20T00:00:01.000+00:00', data: {} };
    expect(isValid(LifecycleEventV2, v2)).toBe(true);
    expect(isValid(LifecycleEventV2, { event: 'x' })).toBe(false);
    expect(isValid(LegacyLifecycleEvent, { event: 'session.created' })).toBe(true);
    expect(isValid(LegacyLifecycleEvent, { v: 1, event: 'x', extra: 1 })).toBe(true);
    expect(isValid(LegacyLifecycleEvent, { v: 1 })).toBe(false);
  });

  test('metrics: historical fields are optional, current producer is strict', () => {
    expect(isValid(SealedMetricsHistorical, {})).toBe(true);
    expect(isValid(SealedMetricsHistorical, { totals: { usage: {} }, future: true })).toBe(false);
    expect(isValid(SealedMetricsHistorical, { totals: { turns: 3 }, extra: true })).toBe(true);
    expect(validationIssues(SealedMetricsHistorical, { session_id: 7 })).not.toEqual([]);
    expect(isValid(SealedMetricsCurrent, { session_id: 's' })).toBe(false);
  });
});

describe('prompt cache ttl contracts', () => {
  test('the core config no longer owns resume policies', () => {
    expect(Object.keys(ConfigLayer.properties)).not.toContain('resume_policies');
    expect(isValid(ConfigLayer, { plugins: { prompt_cache_ttl: { policies: { default: { cache_ttl: '1h' } } } } })).toBe(true);
  });

  test('workflow session accepts resume_from only', () => {
    expect(isValid(WorkflowSession, { resume_from: 'plan' })).toBe(true);
    expect(isValid(WorkflowSession, { on_expired: 'fresh' })).toBe(false);
    expect(isValid(WorkflowSession, { other: 1 })).toBe(false);
  });
});
