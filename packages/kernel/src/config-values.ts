import { isRecord, optionValueText } from '@nodeint/migent-workflow';

import { QUOTE_PAIR_LENGTH } from './constants.js';
import { ConfigurationError } from './errors.js';

export function roleOptionMap(role: Record<string, unknown>): Record<string, string> {
  const {options} = role;
  if ((options === null || options === undefined)) return {};
  if (!isRecord(options)) throw new ConfigurationError('Missing or invalid roles.<role>.options.');
  return stringMap(options);
}

export function optionsDict(body: unknown, key: string): Record<string, string> {
  if (!isRecord(body)) return {};
  const {client} = body;
  if ((client === null || client === undefined)) return {};
  if (!isRecord(client)) throw new ConfigurationError(`Missing or invalid agents.${key}.client.`);
  const {options} = client;
  if ((options === null || options === undefined)) return {};
  if (!isRecord(options)) throw new ConfigurationError(`Missing or invalid agents.${key}.client.options.`);
  return stringMap(options);
}

export function stringMap(options: Record<string, unknown>): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(options)) {
    const text = optionValueText(value);
    if (text !== null) parsed[key] = text;
  }
  return parsed;
}

export function mappingOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigurationError(`Missing or invalid ${field}.`);
  }
  return value.trim();
}

export function scalarText(value: string): string {
  if (value.length >= QUOTE_PAIR_LENGTH && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

export function sortedKeys(record: Record<string, string>): string[] {
  return Object.keys(record).sort(compareString);
}

export function compareString(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function recordEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}
