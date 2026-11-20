import type { Plugin, PluginRegistry, PluginResponseContractInput } from '@nodeint/migent-contracts';
import { ConfigurationError } from '@nodeint/migent-kernel';
import type { PluginResponseResult, PluginResponseResults } from '@nodeint/migent-session';

type Level = 'stage' | 'workflow';
type Mapping = Record<string, unknown>;

const isMapping = (value: unknown): value is Mapping => typeof value === 'object' && value !== null && !Array.isArray(value);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A detached, deeply frozen copy, so a plugin can neither mutate the freeze input nor keep a handle to it. */
const detached = <T>(value: T): T => deepFreeze(JSON.parse(JSON.stringify(value)) as T);

const claimedKeys = (plugin: Plugin | undefined, level: Level): string[] =>
  Object.keys(plugin?.manifest.extensions?.fields[level]?.properties ?? {});

function ownValues(plugin: Plugin, level: Level, body: Mapping): Mapping {
  const keys = claimedKeys(plugin, level).filter((key) => Object.hasOwn(body, key));
  return Object.fromEntries(keys.map((key) => [key, body[key]]));
}

/** The mapping without any plugin key: every key some registered plugin claims on that level is dropped. */
function coreOnly(registry: PluginRegistry, level: Level, body: Mapping): Mapping {
  const claimed = new Set(registry.ids().flatMap((id) => claimedKeys(registry.get(id), level)));
  return Object.fromEntries(Object.entries(body).filter(([key]) => !claimed.has(key)));
}

function invalid(id: string, stageId: string, reason: string): ConfigurationError {
  return new ConfigurationError(`Plugin "${id}" response contract for stage "${stageId}" is invalid: ${reason}`, {
    code: 'plugin-response-contract-invalid',
    path: ['plugins', id, 'stages', stageId],
  });
}

function evaluate(plugin: Plugin, input: PluginResponseContractInput): PluginResponseResult | null {
  const { id } = plugin.manifest;
  const stageId = input.stage.id;
  let result: unknown;
  try {
    result = plugin.responseContract?.(input);
  } catch (error) {
    throw invalid(id, stageId, `responseContract threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result === null) return null;
  if (!isMapping(result) || typeof result.required !== 'boolean') throw invalid(id, stageId, '`required` must be a boolean.');
  if (typeof result.instructions !== 'string' || result.instructions.trim() === '') {
    throw invalid(id, stageId, '`instructions` must be non-blank text.');
  }
  return { required: result.required, instructions: result.instructions };
}

/** The enabled plugins of the merged config that have a `responseContract`, in chain order. */
function chain(registry: PluginRegistry, config: Mapping): Plugin[] {
  const entries = isMapping(config.plugins) ? Object.entries(config.plugins) : [];
  return entries.flatMap(([id, entry]) => {
    const plugin = registry.get(id);
    const disabled = isMapping(entry) && entry.enabled === false;
    return plugin?.responseContract === undefined || disabled ? [] : [plugin];
  });
}

interface StageSite {
  readonly registry: PluginRegistry;
  readonly config: Mapping;
  readonly workflow: Mapping;
  /** The core workflow fields, shared by every stage. */
  readonly core: Mapping;
}

function stageInput(site: StageSite, plugin: Plugin, stage: Mapping & { id: string }): PluginResponseContractInput {
  const { registry, config, workflow, core } = site;
  const entry = isMapping(config.plugins) ? config.plugins[plugin.manifest.id] : undefined;
  return detached({
    options: isMapping(entry) ? entry : {},
    stage: { ...coreOnly(registry, 'stage', stage), id: stage.id },
    workflow: core,
    extensions: { stage: ownValues(plugin, 'stage', stage), workflow: ownValues(plugin, 'workflow', workflow) },
  });
}

/**
 * Evaluates `responseContract` of every enabled plugin for each stage of the workflow mapping (plugin API 1.2).
 * Returns the active results by stage id and plugin id. Throws a `ConfigurationError` for a throw or an invalid
 * result, so session creation stops with exit 2.
 */
export function evaluateResponseContracts(
  registry: PluginRegistry,
  config: Mapping,
  workflow: Mapping,
): PluginResponseResults {
  const plugins = chain(registry, config);
  const core = coreOnly(registry, 'workflow', workflow);
  delete core.stages;
  const stages = (Array.isArray(workflow.stages) ? workflow.stages : []).filter(isMapping);
  const site: StageSite = { registry, config, workflow, core };
  const results: Record<string, Record<string, PluginResponseResult>> = {};
  for (const stage of stages) {
    const { id } = stage;
    if (typeof id !== 'string') continue;
    for (const plugin of plugins) {
      const result = evaluate(plugin, stageInput(site, plugin, { ...stage, id }));
      if (result !== null) (results[id] ??= {})[plugin.manifest.id] = result;
    }
  }
  return results;
}
