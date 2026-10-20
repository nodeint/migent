import { ConfigurationError } from "./errors.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** A missing schema_version is 0. This does not rewrite the document. */
export function documentVersion(document: Record<string, unknown>): number {
  if (!Object.hasOwn(document, "schema_version") || document.schema_version == null) return 0;
  const raw = document.schema_version;
  if (typeof raw === "boolean" || (typeof raw !== "number" && typeof raw !== "string")) {
    throw new ConfigurationError("schema_version must be a non-negative integer.");
  }
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!/^\d+$/.test(text)) {
      throw new ConfigurationError("schema_version must be a non-negative integer.");
    }
    return Number(text);
  }
  if (!Number.isInteger(raw) || raw < 0) {
    throw new ConfigurationError("schema_version must be a non-negative integer.");
  }
  return raw;
}

export function pyRepr(text: string): string {
  if (!text.includes("'")) return `'${text}'`;
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
