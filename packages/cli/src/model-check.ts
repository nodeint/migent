import { createProviderResolver, loadWorkspaceConfig, type ModelEffortCheck, type Provider } from "@nodeint/migent-kernel";
import { checkModelEfforts } from "./effort-check.js";
import { knownModel, loadCatalog, type RunCommand, type Which } from "./provider.js";

/**
 * A name missing from the catalog is a hard error only for these provider CLIs, keyed by command.
 * Each prints every model it can run:
 * - opencode: `opencode models` lists every provider/model pair it can route to.
 * - grok: `grok models` prints the full "Available models" list.
 * - agy: `agy models` prints the full model list.
 * The others are warning-only because a missing name does not prove the model is unusable:
 * - claude: the catalog is the subscription's picker. It lists aliases (`sonnet`, `opus`) and their
 *   resolved ids, but omits older or pinned full ids that `--model` still accepts.
 * - codex: the catalog drops entries whose visibility is not "list" (hidden models still run) and
 *   depends on the signed-in account.
 * An unknown provider command defaults to warning-only.
 */
const RELIABLE_CATALOGS: ReadonlySet<string> = new Set(["opencode", "grok", "agy"]);

/** opencode accepts `provider/model#variant`; the catalog lists only `provider/model`. */
function catalogName(provider: Provider, model: string): string {
  const hash = model.indexOf("#");
  return provider.command === "opencode" && hash > 0 ? model.slice(0, hash) : model;
}

/** Shares one command run per argv so each provider catalog is fetched once per doctor run. */
function cached(runCommand: RunCommand): RunCommand {
  const commands = new Map<string, Promise<string>>();
  return (argv, input) => {
    const key = JSON.stringify([argv, input]);
    let pending = commands.get(key);
    if (pending === undefined) {
      pending = Promise.resolve().then(() => runCommand(argv, input));
      commands.set(key, pending);
    }
    return pending;
  };
}

/** Checks model availability, then efforts (skipped for unknown models), and merges both per key. */
export async function checkModels(
  workspace: string,
  providers: Record<string, Provider>,
  which: Which,
  runCommand: RunCommand,
  only?: ReadonlySet<string>,
): Promise<Record<string, ModelEffortCheck>> {
  const run = cached(runCommand);
  const unreadable = new Set<string>();
  const missed = new Set<string>();
  const availability = await checkModelAvailability(workspace, providers, which, run, only, unreadable, missed);
  // One root cause, one message: skip the effort check for any model the catalog does not list.
  const skip = new Set([...missed, ...Object.keys(availability).filter((key) => availability[key]?.problem)]);
  const efforts = await checkModelEfforts(workspace, providers, which, run, only, skip);
  const merged: Record<string, ModelEffortCheck> = {};
  for (const key of new Set([...Object.keys(availability), ...Object.keys(efforts)])) {
    const problem = [availability[key]?.problem, efforts[key]?.problem].filter((item) => item !== undefined);
    // A catalog that cannot be read yields one root cause: keep the model warning, drop the effort one.
    const effortWarning = unreadable.has(key) ? undefined : efforts[key]?.warning;
    const warning = [availability[key]?.warning, effortWarning].filter((item) => item !== undefined);
    const check: ModelEffortCheck = {};
    if (problem.length > 0) check.problem = problem.join("\n");
    if (warning.length > 0) check.warning = warning.join("\n");
    if (check.problem !== undefined || check.warning !== undefined) merged[key] = check;
  }
  return merged;
}

export async function checkModelAvailability(
  workspace: string,
  providers: Record<string, Provider>,
  which: Which,
  runCommand: RunCommand,
  only?: ReadonlySet<string>,
  /** Receives the keys whose provider catalog could not be read. */
  unreadable: Set<string> = new Set(),
  /** Receives the keys the catalog was read for but does not list, whatever the severity. */
  missed: Set<string> = new Set(),
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
  const run = cached(runCommand);
  const resolveProvider = createProviderResolver(providers);
  const results = await Promise.all(definitions.map(async ([alias, model, modelField]) => {
    if (only !== undefined && !only.has(alias)) return null;
    // Unmapped aliases (empty definitions) are reported by the structural check.
    if (!isRecord(model) || Object.keys(model).length === 0) return null;
    if (typeof model.provider !== "string" || !model.provider.trim() || typeof model.model !== "string" || !model.model.trim()) return null;
    if (model.client != null && (typeof model.client !== "string" || !model.client.trim())) return null;
    const field = `${modelField}.model`;
    const name = model.model.trim();
    const value = JSON.stringify(model.model);
    let provider: Provider;
    try {
      provider = resolveProvider(model.provider.trim(), typeof model.client === "string" ? model.client.trim() : undefined) as Provider;
    } catch { return null; } // The structural check explains an unsupported provider or client.
    if (provider.requiresClient) return null;
    const lookup = catalogName(provider, name);
    const check: ModelEffortCheck = {};
    try {
      const catalog = await loadCatalog(provider, which, run);
      try { knownModel(lookup, catalog); return null; } catch (error) {
        missed.add(alias);
        if (RELIABLE_CATALOGS.has(provider.command)) {
          const near = closest(lookup, catalog.ids);
          const hint = near.length > 0 ? `\nDid you mean: ${near.join(", ")}` : "";
          check.problem = `Invalid ${field}: ${value}\n${error instanceof Error ? error.message : String(error)}${hint}`;
        } else {
          check.warning = `Could not validate ${field}: ${value}\n${provider.command} does not list ${name}; its model list may be incomplete.`;
        }
      }
    } catch (error) {
      unreadable.add(alias);
      check.warning = `Could not validate ${field}: ${value}\n${error instanceof Error ? error.message : String(error)}`;
    }
    return [alias, check] as const;
  }));
  return Object.fromEntries(results.filter((entry) => entry !== null));
}

/** Up to five catalog names that share a prefix with, or sit a few edits from, the typo. */
export function closest(name: string, ids: readonly string[]): string[] {
  const target = name.toLowerCase();
  const limit = Math.max(2, Math.ceil(target.length / 4));
  return ids
    .map((id) => {
      const lower = id.toLowerCase();
      const prefix = lower.startsWith(target) || target.startsWith(lower);
      return { id, score: prefix ? 0 : distance(target, lower) };
    })
    .filter((entry) => entry.score <= limit)
    .sort((left, right) => left.score - right.score || left.id.localeCompare(right.id))
    .slice(0, 5)
    .map((entry) => entry.id);
}

function distance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
