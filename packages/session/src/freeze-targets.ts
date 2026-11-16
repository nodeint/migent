import { legacyClientOf, type StageTarget } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';
import { SCHEMA_V2 } from '@nodeint/migent-workflow';

import { corrupt } from './freeze-corrupt.js';

/** The `targets` mapping of a freeze: one client, model and option set per stage. */
export function readTargets(value: unknown, filePath: string, schemaVersion: unknown): Record<string, StageTarget> {
  if (!isRecord(value)) throw corrupt(filePath, 'targets must be a mapping');
  const legacy = typeof schemaVersion !== 'number' || schemaVersion < SCHEMA_V2;
  const targets: Record<string, StageTarget> = {};
  for (const [stageId, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.model !== 'string') {
      throw corrupt(filePath, `targets.${stageId} must name a client and model`);
    }
    const client = legacy ? legacyTargetClient(raw, filePath, stageId) : raw.client;
    if (typeof client !== 'string') {
      throw corrupt(filePath, `targets.${stageId} must name a client and model`);
    }
    if (raw.model.trim() === '') {
      throw corrupt(filePath, `targets.${stageId} must name a client and model`);
    }
    targets[stageId] = {
      client,
      model: raw.model,
      options: readOptionStrings(raw.options, filePath, stageId),
    };
  }
  return targets;
}

/** Freeze schema_version 1 named a provider and optionally the client that actually ran. */
function legacyTargetClient(
  raw: Record<string, unknown>,
  filePath: string,
  stageId: string,
): string | null {
  if ((raw.client !== null && raw.client !== undefined)) {
    if (typeof raw.client !== 'string' || raw.client.trim() === '') {
      throw corrupt(filePath, `targets.${stageId}.client must be a non-empty string`);
    }
    return raw.client;
  }
  if (typeof raw.provider !== 'string' || raw.provider.trim() === '') {
    throw corrupt(filePath, `targets.${stageId} must name a provider and model`);
  }
  return legacyClientOf(raw.provider) ?? '';
}

function readOptionStrings(value: unknown, filePath: string, stageId: string): Record<string, string> {
  if ((value === null || value === undefined)) return {};
  if (!isRecord(value)) throw corrupt(filePath, `targets.${stageId}.options must be a mapping`);
  const options: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw corrupt(filePath, `targets.${stageId}.options.${key} must be a string`);
    options[key] = item;
  }
  return options;
}
