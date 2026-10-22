export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonObject(line: string): Record<string, unknown> | null {
  const text = line.trim();
  if (!text) return null;
  try {
    const payload: unknown = JSON.parse(text);
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function compact(value: string, limit = 160): string {
  const text = value.split(/\s+/).filter((part) => part !== "").join(" ");
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function picked(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) out[key] = source[key];
  }
  return out;
}
