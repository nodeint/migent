import { isRecord } from '@nodeint/migent-workflow';

import type { ParsedEvent } from './session-events.js';

export function detailsOf(event: ParsedEvent | undefined): Record<string, unknown> {
  if (event === undefined) return {};
  return isRecord(event.raw.details) ? event.raw.details : {};
}

export function coerceNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
