export function text(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const stripped = value.trim();
  return stripped === "" ? null : stripped;
}

export function optionalText(value: unknown): string | null {
  return text(typeof value === "string" ? value : null);
}
