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
export async function checkModelEfforts(
  workspace: string,
  clients: ClientRegistry,
  which: Which,
  runCommand: RunCommand,
  only?: ReadonlySet<string>,
  /** Keys whose model is already reported unknown: one root cause, one message. */
  skip?: ReadonlySet<string>,
  /** Inline stage agents, checked like named ones. */
  extra: readonly AgentDefinitionEntry[] = [],
): Promise<Record<string, ModelEffortCheck>> {
  let config: Record<string, unknown>;
  try { config = loadWorkspaceConfig(workspace); } catch { return {}; }
  const definitions = [...listAgentDefinitions(config), ...extra];
  const run = cached(runCommand);
  const results = await Promise.all(definitions.map(async ({ key: alias, value: model, field: modelField }) => {
    if (only !== undefined && !only.has(alias)) return null;
    if (skip?.has(alias)) return null;
    if (!isRecord(model) || !Object.hasOwn(model, 'effort')) return null;
    if (typeof model.model !== 'string' || !model.model.trim()) return null;
    if (clientUnusable(model)) return null;
    const type = agentClientType(model, clients);
    if (type === undefined) return null; // The structural check explains the missing client.
    const field = `${modelField}.effort`;
    const value = JSON.stringify(model.effort);
    const invalidType = typeof model.effort !== 'string' || model.effort.trim() === '';
    let values: readonly string[] | null = null;
    let warning: string | undefined;
    try {
      const client: CliClient = clients.get(type);
      const source = clientCatalogSource(client as unknown as ClientCatalogInput);
      if (client.effortOption === undefined) values = [];
      else {
        const catalog = await loadCatalog(source, which, run);
        values = await loadOptionValues(source, client.effortOption, model.model.trim(), catalog, which, run);
        if (values === null) throw new Error(`The selected CLI does not list effort values for ${model.model}.`);
      }
    } catch (error) {
      warning = `Could not validate ${field}: ${value}\n${error instanceof Error ? error.message : String(error)}`;
    }
    const check: ModelEffortCheck = {};
    if (warning) check.warning = warning;
    if (invalidType || (values !== null && !values.includes((model.effort as string).trim()))) {
      let valid: string;
      if (values === null) valid = 'unavailable (could not verify)';
      else valid = values.length === 0 ? 'none (omit effort)' : values.join(', ');
      check.problem = `Invalid ${field}: ${value}\nValid values: ${valid}`;
    }
    return [alias, check] as const;
  }));
  return Object.fromEntries(results.filter((entry) => entry !== null));
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
