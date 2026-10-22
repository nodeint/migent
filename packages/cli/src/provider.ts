import { ModelCatalog, defaultProviders } from "@nodeint/migent-adapters";
import { spawnProviderSync, type Provider, type ProviderOption } from "@nodeint/migent-kernel";

export interface CatalogProvider extends Provider {
  modelCatalogCommand(): string[];
  /** Written to the catalog command's stdin when the CLI reads its request there. */
  modelCatalogInput?(): string;
  parseModelCatalog(stdout: string): ModelCatalog;
  optionValuesCommand(name: string, model: string): string[] | null;
  parseOptionValues(name: string, text: string, model?: string): readonly string[];
  providerOptions(): readonly ProviderOption[];
}

export type Which = (command: string) => string | null;
export type RunCommand = (argv: string[], input?: string) => string | Promise<string>;

export class ProviderCommandFailed extends Error {}

export function providerMap(): Record<string, Provider> {
  return defaultProviders();
}

export function asCatalog(provider: Provider): CatalogProvider {
  const candidate = provider as Partial<CatalogProvider>;
  if (typeof candidate.modelCatalogCommand !== "function" || typeof candidate.parseModelCatalog !== "function") {
    throw new ProviderCommandFailed(`${provider.command} does not list models.`);
  }
  return candidate as CatalogProvider;
}

export function requireProvider(providers: Record<string, Provider>, provider: string): Provider {
  const impl = providers[provider];
  if (impl === undefined) {
    const supported = Object.keys(providers).sort().join(", ");
    throw new ProviderCommandFailed(`Unknown provider: ${provider}. Supported: ${supported}.`);
  }
  return impl;
}

export function detected(
  providers: Record<string, Provider>,
  which: Which,
): Array<[string, string | null, Provider]> {
  const rows = Object.entries(providers).filter(([, provider]) => provider.requiresClient !== true).map(
    ([name, provider]) => [name, which(provider.command), provider] as [string, string | null, Provider],
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
  provider: Provider,
  which: Which,
  runCommand: RunCommand,
): Promise<ModelCatalog> {
  if (which(provider.command) === null) {
    throw new ProviderCommandFailed(
      `${provider.command} is not on PATH, so its models could not be listed.`,
    );
  }
  const catalogProvider = asCatalog(provider);
  let stdout: string;
  try {
    stdout = await runCommand(catalogProvider.modelCatalogCommand(), catalogProvider.modelCatalogInput?.());
  } catch (error) {
    if (error instanceof ProviderCommandFailed) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new ProviderCommandFailed(`Could not list ${provider.command} models: ${reason}`);
  }
  const catalog = catalogProvider.parseModelCatalog(stdout);
  if (catalog.ids.length === 0) throw new ProviderCommandFailed(`${provider.command} returned no models.`);
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
  provider: Provider,
  name: string,
  model: string,
  catalog: ModelCatalog,
  which: Which,
  runCommand: RunCommand,
): Promise<readonly string[] | null> {
  const found = catalog.valuesFor(model, name);
  if (found !== null) return found;
  const catalogProvider = asCatalog(provider);
  const argv = catalogProvider.optionValuesCommand(name, model);
  if (argv === null) return null;
  if (which(provider.command) === null) {
    throw new ProviderCommandFailed(
      `${provider.command} is not on PATH, so its ${name} values could not be listed.`,
    );
  }
  let text: string;
  try {
    text = await runCommand(argv);
  } catch (error) {
    if (error instanceof ProviderCommandFailed) text = error.message;
    else {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProviderCommandFailed(`Could not list ${provider.command} ${name} values for ${model}: ${reason}`);
    }
  }
  return catalogProvider.parseOptionValues(name, text, model);
}

export async function acceptedOptions(
  provider: Provider,
  model: string,
  catalog: ModelCatalog,
  which: Which,
  runCommand: RunCommand,
  options: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  if (Object.keys(options).length === 0) return {};
  provider.validateOptions(options);
  const stored: Record<string, string> = {};
  for (const [name, value] of Object.entries(options)) {
    const values = await loadOptionValues(provider, name, model, catalog, which, runCommand);
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

export function runProviderCommand(argv: string[], input?: string): string {
  const [command, ...args] = argv;
  if (command === undefined) throw new ProviderCommandFailed("Provider command is empty.");
  const completed = spawnProviderSync(command, args, {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    ...(input === undefined ? {} : { input }),
  });
  if (completed.error) {
    throw new Error(completed.error.message);
  }
  if (completed.status !== 0) {
    const detail = (completed.stderr || completed.stdout || "").trim();
    throw new ProviderCommandFailed(detail || `${command} exited ${completed.status}.`);
  }
  return completed.stdout ?? "";
}
