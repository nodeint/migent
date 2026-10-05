export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

export function pyRepr(text: string): string {
  if (!text.includes("'")) return `'${text}'`;
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
