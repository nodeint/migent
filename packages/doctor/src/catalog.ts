import type { CliModelCatalog, Provider, ProviderOption } from "@nodeint/migent-kernel";

export type Which = (command: string) => string | null;
export type RunCommand = (argv: string[], input?: string) => string | Promise<string>;

/** A provider command could not run or answered unusably. */
export class ProviderCommandFailed extends Error {}

export interface CatalogProvider extends Provider {
  modelCatalogCommand(): string[];
  /** Written to the catalog command's stdin when the CLI reads its request there. */
  modelCatalogInput?(): string;
  parseModelCatalog(stdout: string): CliModelCatalog;
  optionValuesCommand(name: string, model: string): string[] | null;
  parseOptionValues(name: string, text: string, model?: string): readonly string[];
  providerOptions(): readonly ProviderOption[];
}

export function asCatalog(provider: Provider): CatalogProvider {
  const candidate = provider as Partial<CatalogProvider>;
  if (typeof candidate.modelCatalogCommand !== "function" || typeof candidate.parseModelCatalog !== "function") {
    throw new ProviderCommandFailed(`${provider.command} does not list models.`);
  }
  return candidate as CatalogProvider;
}

export async function loadCatalog(
  provider: Provider,
  which: Which,
  runCommand: RunCommand,
): Promise<CliModelCatalog> {
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

export function knownModel(model: string, catalog: CliModelCatalog): string {
  const value = model.trim();
  if (!catalog.ids.includes(value)) throw new ProviderCommandFailed(`Unknown model: ${value}.`);
  return value;
}

export async function loadOptionValues(
  provider: Provider,
  name: string,
  model: string,
  catalog: CliModelCatalog,
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

/** Shares one command run per argv so each provider catalog is fetched once per doctor run. */
export function cached(runCommand: RunCommand): RunCommand {
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
