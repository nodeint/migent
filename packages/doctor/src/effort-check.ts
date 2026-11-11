import {
  type AgentDefinitionEntry,
  type CliClient,
  type ClientRegistry,
  listAgentDefinitions,
  loadWorkspaceConfig,
} from '@nodeint/migent-kernel';

import {
  cached,
  type ClientCatalogInput,
  clientCatalogSource,
  loadCatalog,
  loadOptionValues,
  type RunCommand,
  type Which,
} from './catalog.js';
import type { ModelEffortCheck } from './check.js';
import { agentClientType } from './client-type.js';

/** Catalog lookup is asynchronous and needs the machine, so it stays out of the static checks. */
export interface EffortCheckOptions {
  readonly which: Which;
  readonly runCommand: RunCommand;
  readonly only?: ReadonlySet<string>;
  /** Keys whose model is already reported unknown: one root cause, one message. */
  readonly skip?: ReadonlySet<string>;
  /** Inline stage agents, checked like named ones. */
  readonly extra?: readonly AgentDefinitionEntry[];
}

export async function checkModelEfforts(
  workspace: string,
  clients: ClientRegistry,
  options: EffortCheckOptions,
): Promise<Record<string, ModelEffortCheck>> {
  const { which, runCommand, only, skip, extra = [] } = options;
  let config: Record<string, unknown>;
  try { config = loadWorkspaceConfig(workspace); } catch { return {}; }
  const definitions = [...listAgentDefinitions(config), ...extra];
  const run = cached(runCommand);
  const results = await Promise.all(definitions.map(async (entry) => {
    if (!selected(entry.key, only, skip)) return null;
    const check = await checkEntry(entry, clients, { which, run });
    return check === null ? null : [entry.key, check] as const;
  }));
  return Object.fromEntries(results.filter((entry) => entry !== null));
}

function selected(
  alias: string,
  only: ReadonlySet<string> | undefined,
  skip: ReadonlySet<string> | undefined,
): boolean {
  if (only !== undefined && !only.has(alias)) return false;
  return !skip?.has(alias);
}

/** The definition's model and client type when its effort can be checked against a catalog. */
function checkableModel(
  model: unknown,
  clients: ClientRegistry,
): { model: Record<string, unknown> & { model: string }; type: string } | null {
  if (!isRecord(model) || !Object.hasOwn(model, 'effort')) return null;
  if (typeof model.model !== 'string' || !model.model.trim()) return null;
  if (clientUnusable(model)) return null;
  const type = agentClientType(model, clients);
  if (type === undefined) return null; // The structural check explains the missing client.
  return { model: model as Record<string, unknown> & { model: string }, type };
}

async function checkEntry(
  entry: AgentDefinitionEntry,
  clients: ClientRegistry,
  machine: { which: Which; run: RunCommand },
): Promise<ModelEffortCheck | null> {
  const checkable = checkableModel(entry.value, clients);
  if (checkable === null) return null;
  const { model, type } = checkable;
  const field = `${entry.field}.effort`;
  const value = JSON.stringify(model.effort);
  const invalidType = typeof model.effort !== 'string' || model.effort.trim() === '';
  let values: readonly string[] | null = null;
  let warning: string | undefined;
  try {
    values = await effortValues(clients.get(type), model.model, machine);
  } catch (error) {
    warning = `Could not validate ${field}: ${value}\n${error instanceof Error ? error.message : String(error)}`;
  }
  const check: ModelEffortCheck = {};
  if (warning) check.warning = warning;
  if (invalidType || (values !== null && !values.includes((model.effort as string).trim()))) {
    check.problem = `Invalid ${field}: ${value}\nValid values: ${validValuesText(values)}`;
  }
  return check;
}

/** The effort values the client's catalog lists for the model; `[]` when the client has no effort option. */
async function effortValues(
  client: CliClient,
  modelName: string,
  machine: { which: Which; run: RunCommand },
): Promise<readonly string[]> {
  const { which, run } = machine;
  const source = clientCatalogSource(client as unknown as ClientCatalogInput);
  if (client.effortOption === undefined) return [];
  const catalog = await loadCatalog(source, which, run);
  const values = await loadOptionValues(
    { source, name: client.effortOption, model: modelName.trim(), catalog },
    { which, runCommand: run },
  );
  if (values === null) throw new Error(`The selected CLI does not list effort values for ${modelName}.`);
  return values;
}

function validValuesText(values: readonly string[] | null): string {
  if (values === null) return 'unavailable (could not verify)';
  return values.length === 0 ? 'none (omit effort)' : values.join(', ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `client` is present but is not a mapping with a usable `type`: the structural check explains it. */
function clientUnusable(definition: Record<string, unknown>): boolean {
  const {client} = definition;
  if ((client === null || client === undefined)) return false;
  if (!isRecord(client)) return true;
  return (client.type !== null && client.type !== undefined) && (typeof client.type !== 'string' || client.type.trim() === '');
}
