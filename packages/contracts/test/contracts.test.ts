import { describe, expect, test } from "vitest";
import {
  AnyJsonObject,
  CLI_CONTRACTS,
  KNOWN_SHAPES,
  LegacyLifecycleEvent,
  LifecycleEventV2,
  SealedMetrics,
  SealedMetricsCurrent,
  SealedMetricsHistorical,
  SessionFollowRecord,
  isValid,
  validationIssues,
} from "../src/index.ts";

describe("registry", () => {
  test("keys and $ids are unique and every contract has a title", () => {
    const keys = CLI_CONTRACTS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    const ids = [...CLI_CONTRACTS.map((entry) => entry.schema), ...KNOWN_SHAPES].map((schema) => schema.$id);
    expect(ids.every((value) => typeof value === "string")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("passthrough contracts are exactly any JSON object", () => {
    for (const entry of CLI_CONTRACTS.filter((item) => item.class === "passthrough")) {
      expect(entry.schema).toMatchObject({ type: "object", patternProperties: { "^.*$": {} } });
      expect((entry.schema as { properties?: unknown }).properties).toBeUndefined();
    }
    expect(isValid(SealedMetrics, { session_id: 42, totals: "opaque" })).toBe(true);
    expect(isValid(SessionFollowRecord, [])).toBe(false);
    expect(isValid(AnyJsonObject, {})).toBe(true);
  });
});

describe("known shapes are opt-in descriptions", () => {
  test("lifecycle event v2 and legacy", () => {
    const v2 = { v: 2, seq: 1, event: "session.created", timestamp: "2026-10-20T00:00:01.000+00:00", data: {} };
    expect(isValid(LifecycleEventV2, v2)).toBe(true);
    expect(isValid(LifecycleEventV2, { event: "x" })).toBe(false);
    expect(isValid(LegacyLifecycleEvent, { event: "session.created" })).toBe(true);
    expect(isValid(LegacyLifecycleEvent, { v: 1, event: "x", extra: 1 })).toBe(true);
    expect(isValid(LegacyLifecycleEvent, { v: 1 })).toBe(false);
  });

  test("metrics: historical fields are optional, current producer is strict", () => {
    expect(isValid(SealedMetricsHistorical, {})).toBe(true);
    expect(isValid(SealedMetricsHistorical, { totals: { usage: {} }, future: true })).toBe(false);
    expect(isValid(SealedMetricsHistorical, { totals: { turns: 3 }, extra: true })).toBe(true);
    expect(validationIssues(SealedMetricsHistorical, { session_id: 7 })).not.toEqual([]);
    expect(isValid(SealedMetricsCurrent, { session_id: "s" })).toBe(false);
  });
});
