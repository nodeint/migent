/** Pure agent body rewrites used by config edits. */
import { isRecord } from '@nodeint/migent-workflow';

import { ConfigurationError } from './errors.js';
import { ConfigEditError } from './yaml-patch.js';

export function withAgentClient(body: Readonly<Record<string, unknown>>, type: string): Record<string, unknown> {
  const client = isRecord(body.client) ? body.client : {};
  const { type: previousType, ...rest } = client;
  return { ...body, client: { type, ...rest } };
}

export function withAgentOptions(
  body: Readonly<Record<string, unknown>>,
  key: string,
  updates: unknown,
): Record<string, unknown> {
  if (!isRecord(updates)) throw new ConfigEditError('Options must be a mapping.');
  const client = optionRecord(body.client, `Missing or invalid agents.${key}.client.`);
  const options = withOptionUpdates(optionRecord(client.options, `Missing or invalid agents.${key}.client.options.`), updates);
  const nextClient = Object.keys(options).length > 0 ? { ...client, options } : omitKey(client, 'options');
  return Object.keys(nextClient).length > 0 ? { ...body, client: nextClient } : omitKey(body, 'client');
}

function omitKey(record: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

function optionRecord(value: unknown, field: string): Record<string, unknown> {
  if ((value === null || value === undefined)) return {};
  if (!isRecord(value)) throw new ConfigurationError(field);
  return value;
}

function withOptionUpdates(
  options: Readonly<Record<string, unknown>>,
  updates: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const next = { ...options };
  for (const [name, value] of Object.entries(updates)) {
    if (name.trim() === '') throw new ConfigEditError('Option name is required.');
    if (value === null) {
      delete next[name];
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') throw new ConfigEditError(`${name} is required.`);
    next[name] = value.trim();
  }
  return next;
}
