import { readFileSync, statSync } from 'node:fs';

import { isRecord, parseYamlDocument } from '@nodeint/migent-workflow';

import { corrupt } from './freeze-corrupt.js';

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The freeze file as a mapping; null when it is missing. */
export function readFreezeMapping(filePath: string): Record<string, unknown> | null {
  let text: string;
  try {
    if (!statSync(filePath).isFile()) return null;
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw corrupt(filePath, errorText(error));
  }
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(text);
  } catch (error) {
    throw corrupt(filePath, errorText(error));
  }
  if (!isRecord(parsed)) throw corrupt(filePath, 'expected a mapping');
  return parsed;
}
