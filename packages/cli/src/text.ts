export function text(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const stripped = value.trim();
  return stripped === '' ? null : stripped;
}

export function optionalText(value: unknown): string | null {
  return text(typeof value === 'string' ? value : null);
}

/** Keep leading and trailing breaks so a one-line task check sees them. */
export function rawText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
