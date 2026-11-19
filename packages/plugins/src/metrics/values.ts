/** Seconds are rounded to one decimal place. */
const TENTH_SCALE = 10;
const MS_PER_SECOND = 1000;

const USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cost_usd',
] as const;

export type UsageField = (typeof USAGE_FIELDS)[number];
export type Usage = Record<UsageField, number | null>;

export interface UsageTotals {
  sums: Record<UsageField, number>;
  seen: Record<UsageField, boolean>;
  missing: Record<UsageField, number>;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return value as string[];
}

export function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function elapsedMs(start: string | null, end: string | null): number | null {
  const started = parseTime(start);
  const finished = parseTime(end);
  if (started === null || finished === null) return null;
  return finished - started;
}

export function roundSeconds(milliseconds: number): number {
  return Math.round((milliseconds / MS_PER_SECOND) * TENTH_SCALE) / TENTH_SCALE;
}

export function wallSeconds(start: string | null, end: string | null): number | null {
  const elapsed = elapsedMs(start, end);
  return elapsed === null ? null : roundSeconds(elapsed);
}

/** The `details` object of an event as stored. */
export function detailsOf(
  event: { readonly raw: Readonly<Record<string, unknown>> } | undefined,
): Record<string, unknown> {
  if (event === undefined) return {};
  return isRecord(event.raw.details) ? event.raw.details : {};
}

function uniformFields<T>(value: T): Record<UsageField, T> {
  return Object.fromEntries(USAGE_FIELDS.map((field) => [field, value])) as Record<UsageField, T>;
}

export function newUsageTotals(): UsageTotals {
  return { sums: uniformFields(0), seen: uniformFields(false), missing: uniformFields(0) };
}

/** A copy of `totals` with one usage record folded in. `missing` counts the fields the record lacks. */
export function addUsageRecord(
  totals: UsageTotals,
  usage: Readonly<Record<string, number | null>>,
  missing: Record<UsageField, number>,
): UsageTotals {
  const next: UsageTotals = { sums: { ...totals.sums }, seen: { ...totals.seen }, missing: { ...totals.missing } };
  for (const field of USAGE_FIELDS) {
    next.missing[field] += missing[field];
    const value = usage[field] ?? null;
    if (value !== null) {
      next.sums[field] += value;
      next.seen[field] = true;
    }
  }
  return next;
}

/** A copy of `totals` with one turn folded in. A null field counts as one missing capture. */
export function addTurn(totals: UsageTotals, usage: Readonly<Record<string, number | null>>): UsageTotals {
  const missing = uniformFields(0);
  for (const field of USAGE_FIELDS) {
    if ((usage[field] ?? null) === null) missing[field] = 1;
  }
  return addUsageRecord(totals, usage, missing);
}

export function usageObject(totals: UsageTotals): Usage {
  return Object.fromEntries(
    USAGE_FIELDS.map((field) => [field, totals.seen[field] ? totals.sums[field] : null]),
  ) as Usage;
}

export function missingObject(totals: UsageTotals): Record<UsageField, number> {
  return Object.fromEntries(USAGE_FIELDS.map((field) => [field, totals.missing[field]])) as Record<UsageField, number>;
}
