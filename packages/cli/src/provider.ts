import { spawnSync } from "node:child_process";
import { ModelCatalog, defaultAdapters } from "@migent/adapters";
import type { AgentAdapter, ProviderOption } from "@migent/kernel";

export interface CatalogAdapter extends AgentAdapter {
  modelCatalogCommand(): string[];
  parseModelCatalog(stdout: string): ModelCatalog;
  optionValuesCommand(name: string, model: string): string[] | null;
  parseOptionValues(name: string, text: string, model?: string): readonly string[];
  providerOptions(): readonly ProviderOption[];
}

export type Which = (command: string) => string | null;
export type RunCommand = (argv: string[]) => string | Promise<string>;

export class ProviderCommandFailed extends Error {}

export function adapterMap(): Record<string, AgentAdapter> {
  return defaultAdapters();
}

export function asCatalog(adapter: AgentAdapter): CatalogAdapter {
  const candidate = adapter as Partial<CatalogAdapter>;
  if (typeof candidate.modelCatalogCommand !== "function" || typeof candidate.parseModelCatalog !== "function") {
    throw new ProviderCommandFailed(`${adapter.command} does not list models.`);
  }
  return candidate as CatalogAdapter;
}

export function requireAdapter(adapters: Record<string, AgentAdapter>, provider: string): AgentAdapter {
  const adapter = adapters[provider];
  if (adapter === undefined) {
    const supported = Object.keys(adapters).sort().join(", ");
    throw new ProviderCommandFailed(`Unknown provider: ${provider}. Supported: ${supported}.`);
  }
  return adapter;
}

export function detected(
  adapters: Record<string, AgentAdapter>,
  which: Which,
): Array<[string, string | null, AgentAdapter]> {
  const rows = Object.entries(adapters).map(
    ([name, adapter]) => [name, which(adapter.command), adapter] as [string, string | null, AgentAdapter],
  );
  rows.sort((left, right) => {
    const leftMissing = left[1] === null ? 1 : 0;
    const rightMissing = right[1] === null ? 1 : 0;
    if (leftMissing !== rightMissing) return leftMissing - rightMissing;
    if (left[0] < right[0]) return -1;
    if (left[0] > right[0]) return 1;
    return 0;
  });
  return rows;
}

export async function loadCatalog(
  adapter: AgentAdapter,
  which: Which,
  runCommand: RunCommand,
): Promise<ModelCatalog> {
  if (which(adapter.command) === null) {
    throw new ProviderCommandFailed(
      `${adapter.command} is not on PATH, so its models could not be listed.`,
    );
  }
  const catalogAdapter = asCatalog(adapter);
  let stdout: string;
  try {
    stdout = await runCommand(catalogAdapter.modelCatalogCommand());
  } catch (error) {
    if (error instanceof ProviderCommandFailed) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new ProviderCommandFailed(`Could not list ${adapter.command} models: ${reason}`);
  }
  const catalog = catalogAdapter.parseModelCatalog(stdout);
  if (catalog.ids.length === 0) throw new ProviderCommandFailed(`${adapter.command} returned no models.`);
  return catalog;
}

export function knownModel(model: string, catalog: ModelCatalog): string {
  const value = model.trim();
  if (!catalog.ids.includes(value)) throw new ProviderCommandFailed(`Unknown model: ${value}.`);
  return value;
}

export function parseOptions(pairs: readonly string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const pair of pairs) {
    if (!pair.includes("=")) throw new ProviderCommandFailed(`Option must be KEY=VALUE: ${pair}.`);
    const index = pair.indexOf("=");
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (name === "" || value === "") throw new ProviderCommandFailed(`Option must be KEY=VALUE: ${pair}.`);
    parsed[name] = value;
  }
  return parsed;
}

export async function loadOptionValues(
  adapter: AgentAdapter,
  name: string,
  model: string,
  catalog: ModelCatalog,
  which: Which,
  runCommand: RunCommand,
): Promise<readonly string[] | null> {
  const found = catalog.valuesFor(model, name);
  if (found !== null) return found;
  const catalogAdapter = asCatalog(adapter);
  const argv = catalogAdapter.optionValuesCommand(name, model);
  if (argv === null) return null;
  if (which(adapter.command) === null) {
    throw new ProviderCommandFailed(
      `${adapter.command} is not on PATH, so its ${name} values could not be listed.`,
    );
  }
  let text: string;
  try {
    text = await runCommand(argv);
  } catch (error) {
    if (error instanceof ProviderCommandFailed) text = error.message;
    else {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProviderCommandFailed(`Could not list ${adapter.command} ${name} values for ${model}: ${reason}`);
    }
  }
  return catalogAdapter.parseOptionValues(name, text, model);
}

export async function acceptedOptions(
  adapter: AgentAdapter,
  model: string,
  catalog: ModelCatalog,
  which: Which,
  runCommand: RunCommand,
  options: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  if (Object.keys(options).length === 0) return {};
  adapter.validateOptions(options);
  const stored: Record<string, string> = {};
  for (const [name, value] of Object.entries(options)) {
    const values = await loadOptionValues(adapter, name, model, catalog, which, runCommand);
    if (values === null) {
      stored[name] = value;
      continue;
    }
    if (!values.includes(value)) {
      if (values.length === 0) throw new ProviderCommandFailed(`${model} does not accept ${name}.`);
      throw new ProviderCommandFailed(`${name} must be one of: ${values.join(", ")}.`);
    }
    stored[name] = value;
  }
  return stored;
}

export function runProviderCommand(argv: string[]): string {
  const [command, ...args] = argv;
  if (command === undefined) throw new ProviderCommandFailed("Provider command is empty.");
  const completed = spawnSync(command, args, { encoding: "utf8", timeout: 60_000 });
  if (completed.error) {
    throw new Error(completed.error.message);
  }
  if (completed.status !== 0) {
    const detail = (completed.stderr || completed.stdout || "").trim();
    throw new ProviderCommandFailed(detail || `${command} exited ${completed.status}.`);
  }
  return completed.stdout ?? "";
}
