import { createProviderResolver, loadWorkspaceConfig, type ModelEffortCheck, type Provider } from "@nodeint/migent-kernel";
import { loadCatalog, loadOptionValues, type RunCommand, type Which } from "./provider.js";

/** Catalog lookup belongs at the CLI boundary; kernel diagnostics remain synchronous. */
export async function checkModelEfforts(
  workspace: string,
  providers: Record<string, Provider>,
  which: Which,
  runCommand: RunCommand,
): Promise<Record<string, ModelEffortCheck>> {
  let config: Record<string, unknown>;
  try { config = loadWorkspaceConfig(workspace); } catch { return {}; }
  const definitions: Array<[string, unknown, string]> = isRecord(config.models)
    ? Object.entries(config.models).map(([alias, model]) => [alias, model, `models.${alias}`]) : [];
  if (isRecord(config.roles)) {
    for (const [name, role] of Object.entries(config.roles)) {
      if (isRecord(role) && isRecord(role.default_model)) {
        const field = `roles.${name}.default_model`;
        definitions.push([field, role.default_model, field]);
      }
    }
  }
  const commands = new Map<string, Promise<string>>();
  const run: RunCommand = (argv, input) => {
    const key = JSON.stringify([argv, input]);
    let pending = commands.get(key);
    if (pending === undefined) {
      pending = Promise.resolve().then(() => runCommand(argv, input));
      commands.set(key, pending);
    }
    return pending;
  };
  const resolveProvider = createProviderResolver(providers);
  const results = await Promise.all(definitions.map(async ([alias, model, modelField]) => {
    if (!isRecord(model) || !Object.hasOwn(model, "effort")) return null;
    if (typeof model.provider !== "string" || !model.provider.trim() || typeof model.model !== "string" || !model.model.trim()) return null;
    if (model.client != null && (typeof model.client !== "string" || !model.client.trim())) return null;
    const field = `${modelField}.effort`;
    const value = JSON.stringify(model.effort);
    const invalidType = typeof model.effort !== "string" || model.effort.trim() === "";
    let values: readonly string[] | null = null;
    let warning: string | undefined;
    try {
      const provider = resolveProvider(model.provider.trim(), typeof model.client === "string" ? model.client.trim() : undefined) as Provider;
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
