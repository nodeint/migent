import { isRecord } from "@nodeint/migent-workflow";



export function differingKeys(left: Record<string, unknown>, right: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const different: string[] = [];
  for (const key of [...keys].sort()) {
    if (canonical(left[key]) !== canonical(right[key])) different.push(key);
  }
  return different;
}

export function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key]);
  return sorted;
}

export function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function later(current: string | null, next: string | null): string | null {
  if (!next) return current;
  if (!current) return next;
  const left = Date.parse(current);
  const right = Date.parse(next);
  if (Number.isNaN(left) || Number.isNaN(right)) return current >= next ? current : next;
  return left >= right ? current : next;
}

export function textOr(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Session ids are strings; a hand-edited manifest may hold an unquoted integer. */
export function identityText(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return textOr(value);
}

export function asInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return 0;
}
