import { createProviderResolver, listAgentDefinitions, loadWorkspaceConfig, type AgentDefinitionEntry, type Provider } from "@nodeint/migent-kernel";
import type { ModelEffortCheck } from "./check.js";
import { cached, loadCatalog, loadOptionValues, type RunCommand, type Which } from "./catalog.js";

/** Catalog lookup is asynchronous and needs the machine, so it stays out of the static checks. */
export async function checkModelEfforts(
  workspace: string,
  providers: Record<string, Provider>,
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
  const resolveProvider = createProviderResolver(providers);
  const results = await Promise.all(definitions.map(async ({ key: alias, value: model, field: modelField }) => {
    if (only !== undefined && !only.has(alias)) return null;
    if (skip?.has(alias)) return null;
    if (!isRecord(model) || !Object.hasOwn(model, "effort")) return null;
    if (typeof model.provider !== "string" || !model.provider.trim() || typeof model.model !== "string" || !model.model.trim()) return null;
    if (clientUnusable(model)) return null;
    const field = `${modelField}.effort`;
    const value = JSON.stringify(model.effort);
    const invalidType = typeof model.effort !== "string" || model.effort.trim() === "";
    let values: readonly string[] | null = null;
    let warning: string | undefined;
    try {
      const provider = resolveProvider(model.provider.trim(), clientType(model)) as Provider;
      if (provider.requiresClient) return null; // The structural check explains the missing client.
      if (provider.effortOption === undefined) values = [];
      else {
        const catalog = await loadCatalog(provider, which, run);
        values = await loadOptionValues(provider, provider.effortOption, model.model.trim(), catalog, which, run);
        if (values === null) throw new Error(`The selected CLI does not list effort values for ${model.model}.`);
      }
    } catch (error) {
      warning = `Could not validate ${field}: ${value}\n${error instanceof Error ? error.message : String(error)}`;
    }
    const check: ModelEffortCheck = {};
    if (warning) check.warning = warning;
    if (invalidType || (values !== null && !values.includes((model.effort as string).trim()))) {
      const valid = values === null ? "unavailable (could not verify)" : values.length === 0 ? "none (omit effort)" : values.join(", ");
      check.problem = `Invalid ${field}: ${value}\nValid values: ${valid}`;
    }
    return [alias, check] as const;
  }));
  return Object.fromEntries(results.filter((entry) => entry !== null));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The CLI client id of an agent definition (`client.type`), undefined when absent or not a usable string. */
function clientType(definition: Record<string, unknown>): string | undefined {
  const client = definition.client;
  return isRecord(client) && typeof client.type === "string" && client.type.trim() !== "" ? client.type.trim() : undefined;
}

/** True when `client` is present but is not a mapping with a usable `type`: the structural check explains it. */
function clientUnusable(definition: Record<string, unknown>): boolean {
  const client = definition.client;
  if (client == null) return false;
  if (!isRecord(client)) return true;
  return client.type != null && (typeof client.type !== "string" || client.type.trim() === "");
}
