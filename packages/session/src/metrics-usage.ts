import type { TurnUsage } from "@nodeint/migent-kernel";
import { coerceNumber } from "./metrics-values.js";

export const USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cost_usd",
] as const;

export type UsageField = (typeof USAGE_FIELDS)[number];

export interface UsageTotals {
  sums: Record<UsageField, number>;
  seen: Record<UsageField, boolean>;
  missing: Record<UsageField, number>;
}

export function addTurn(totals: UsageTotals, usage: TurnUsage): void {
  for (const field of USAGE_FIELDS) {
    const value = usage[field];
    if (value === null) totals.missing[field] += 1;
    else {
      totals.sums[field] += value;
      totals.seen[field] = true;
    }
  }
}

export function addUsageRecord(totals: UsageTotals, usage: TurnUsage, missing: Record<UsageField, number>): void {
  for (const field of USAGE_FIELDS) {
    totals.missing[field] += missing[field];
    if (usage[field] !== null) {
      totals.sums[field] += usage[field];
      totals.seen[field] = true;
    }
  }
}

export function newUsageTotals(): UsageTotals {
  const sums = {} as Record<UsageField, number>;
  const seen = {} as Record<UsageField, boolean>;
  const missing = {} as Record<UsageField, number>;
  for (const field of USAGE_FIELDS) {
    sums[field] = 0;
    seen[field] = false;
    missing[field] = 0;
  }
  return { sums, seen, missing };
}

export function usageObject(totals: UsageTotals): TurnUsage {
  return {
    input_tokens: totals.seen.input_tokens ? totals.sums.input_tokens : null,
    output_tokens: totals.seen.output_tokens ? totals.sums.output_tokens : null,
    reasoning_tokens: totals.seen.reasoning_tokens ? totals.sums.reasoning_tokens : null,
    cache_read_tokens: totals.seen.cache_read_tokens ? totals.sums.cache_read_tokens : null,
    cache_write_tokens: totals.seen.cache_write_tokens ? totals.sums.cache_write_tokens : null,
    cost_usd: totals.seen.cost_usd ? totals.sums.cost_usd : null,
  };
}

export function missingObject(totals: UsageTotals): Record<UsageField, number> {
  return {
    input_tokens: totals.missing.input_tokens,
    output_tokens: totals.missing.output_tokens,
    reasoning_tokens: totals.missing.reasoning_tokens,
    cache_read_tokens: totals.missing.cache_read_tokens,
    cache_write_tokens: totals.missing.cache_write_tokens,
    cost_usd: totals.missing.cost_usd,
  };
}

export function blankUsage(): TurnUsage {
  return {
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_usd: null,
  };
}

export function coerceUsage(value: TurnUsage): TurnUsage {
  return {
    input_tokens: coerceNumber(value?.input_tokens),
    output_tokens: coerceNumber(value?.output_tokens),
    reasoning_tokens: coerceNumber(value?.reasoning_tokens),
    cache_read_tokens: coerceNumber(value?.cache_read_tokens),
    cache_write_tokens: coerceNumber(value?.cache_write_tokens),
    cost_usd: coerceNumber(value?.cost_usd),
  };
}
