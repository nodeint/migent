import type { ExtensionCatalog } from '@nodeint/migent-contracts';
import { isWellFormedSchema } from '@nodeint/migent-contracts';
import { ConfigurationError } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';

import { corrupt } from './freeze-corrupt.js';
import type { FrozenExtensionRecord } from './freeze-extensions.js';
import type { PluginResponseResult, PluginResponseResults } from './freeze-plugins.js';

/** One frozen response contract: what the plugin asked for in a stage, and the payload schema as plain data. */
export interface FrozenResponseContract {
  readonly required: boolean;
  readonly instructions: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

/** `response_contracts`: stage id, then plugin id. Empty for a freeze written without any. */
export type FrozenResponseContracts = Readonly<Record<string, Readonly<Record<string, FrozenResponseContract>>>>;

/** The freeze key that holds the contracts. */
const RESPONSE_CONTRACTS_KEY = 'response_contracts';

/** The plugin ids that own at least one active contract, in first-seen order. */
export function responseOwners(results: PluginResponseResults): string[] {
  return [...new Set(Object.values(results).flatMap((byPlugin) => Object.keys(byPlugin)))];
}

function payloadSchema(catalog: ExtensionCatalog, plugin: string): Record<string, unknown> {
  const schema = catalog.find((entry) => entry.plugin === plugin)?.fields.response?.properties[plugin];
  if (schema === undefined) {
    throw new ConfigurationError(`Plugin "${plugin}" has a response contract but the catalog has no response entry.`, {
      code: 'plugin-response-contract-invalid',
      path: ['plugins', plugin],
    });
  }
  // A JSON copy: the freeze stores the schema as written at this moment.
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

/** The freeze key for the active contracts, with each payload schema copied from the catalog. Empty when none. */
export function freezeResponseContracts(
  catalog: ExtensionCatalog,
  results: PluginResponseResults,
): Record<string, unknown> {
  const stages = Object.entries(results).filter(([, byPlugin]) => Object.keys(byPlugin).length > 0);
  if (stages.length === 0) return {};
  const contract = (plugin: string, result: PluginResponseResult): FrozenResponseContract => ({
    required: result.required,
    instructions: result.instructions,
    schema: payloadSchema(catalog, plugin),
  });
  const byStage = (byPlugin: Readonly<Record<string, PluginResponseResult>>): Record<string, FrozenResponseContract> =>
    Object.fromEntries(Object.entries(byPlugin).map(([plugin, result]) => [plugin, contract(plugin, result)]));
  const contracts = Object.fromEntries(stages.map(([stage, byPlugin]) => [stage, byStage(byPlugin)]));
  return { [RESPONSE_CONTRACTS_KEY]: contracts };
}

function readContract(where: string, raw: unknown, filePath: string): FrozenResponseContract {
  if (!isRecord(raw)) throw corrupt(filePath, `${where} must be a mapping`);
  const { required, instructions, schema } = raw;
  if (typeof required !== 'boolean') throw corrupt(filePath, `${where}.required must be a boolean`);
  if (typeof instructions !== 'string' || instructions.trim() === '') {
    throw corrupt(filePath, `${where}.instructions must be non-blank text`);
  }
  if (!isRecord(schema) || !isWellFormedSchema(schema)) {
    throw corrupt(filePath, `${where}.schema must be a well-formed JSON Schema`);
  }
  return { required, instructions, schema };
}

/**
 * The `response_contracts` of a freeze body. Each entry's plugin must have recorded its own `response` key in
 * `extensions`, and each stage must exist. A freeze without the key reads as having none.
 */
export function readFrozenResponseContracts(
  parsed: Record<string, unknown>,
  context: {
    readonly records: Readonly<Record<string, FrozenExtensionRecord>>;
    readonly stageIds: readonly string[];
    readonly filePath: string;
  },
): FrozenResponseContracts {
  const raw = parsed[RESPONSE_CONTRACTS_KEY];
  if (raw === undefined) return {};
  const { records, stageIds, filePath } = context;
  if (!isRecord(raw)) throw corrupt(filePath, `${RESPONSE_CONTRACTS_KEY} must be a mapping`);
  const contracts: Record<string, Record<string, FrozenResponseContract>> = {};
  for (const [stage, byPlugin] of Object.entries(raw)) {
    const where = `${RESPONSE_CONTRACTS_KEY}.${stage}`;
    if (!stageIds.includes(stage)) throw corrupt(filePath, `${where} names a stage the workflow does not have`);
    if (!isRecord(byPlugin)) throw corrupt(filePath, `${where} must be a mapping`);
    contracts[stage] = {};
    for (const [plugin, entry] of Object.entries(byPlugin)) {
      if (!records[plugin]?.keys.response.includes(plugin)) {
        throw corrupt(filePath, `${where}.${plugin} has no recorded response key in extensions.${plugin}.keys.response`);
      }
      contracts[stage][plugin] = readContract(`${where}.${plugin}`, entry, filePath);
    }
  }
  return contracts;
}
