import type { CliModelCatalog, CommandSpec, Provider, ProviderOption } from "@nodeint/migent-kernel";

export type Which = (command: string) => string | null;
export type RunCommand = (argv: string[], input?: string) => string | Promise<string>;

/** A provider command could not run or answered unusably. */
export class ProviderCommandFailed extends Error {}

/**
 * The help-derived option facts the discovery helpers expose. The adapters
 * package owns the same shape as `HeadlessOption`; doctor keeps a structural
 * copy so it does not depend on the adapters package.
 */
export interface HeadlessOptionFact {
  name: string;
  flags: string[];
  description: string;
  argument: string | null;
  valueMode: "required" | "optional" | "none" | "unknown";
  type: "string" | "number" | "boolean" | "array" | "unknown";
  choices: string[] | null;
  defaultValue: string | null;
}

/**
 * Everything catalog and help discovery needs, read from either a provider or
 * a CLI client. Identity is the source's own command; no provider name lookup.
 */
export interface CatalogSource {
  readonly command: string;
  modelCatalogCommand(): string[];
  /** Written to the catalog command's stdin when the CLI reads its request there. */
  modelCatalogInput?(): string | undefined;
  parseModelCatalog(stdout: string): CliModelCatalog;
  optionValuesCommand(name: string, model: string): string[] | null;
  parseOptionValues(name: string, text: string, model: string): readonly string[];
  optionsCommand(): CommandSpec;
  parseOptions(help: string): readonly HeadlessOptionFact[];
  providerOptions(): readonly ProviderOption[];
}

/** The client surface a catalog source reads. Structural, so adapters need not import doctor. */
export interface ClientCatalogInput {
  readonly id: string;
  readonly command: string;
  modelsCommand(): CommandSpec;
  parseModels(stdout: string): CliModelCatalog;
  optionValuesCommand(name: string, model: string): CommandSpec | null;
  parseOptionValues(name: string, text: string, model: string): readonly string[];
  optionsCommand(): CommandSpec;
  parseOptions(help: string): readonly HeadlessOptionFact[];
  options(): readonly ProviderOption[];
}

/** A client-keyed source: its own catalog argv, stdin, parsers, and help command. */
export function clientCatalogSource(client: ClientCatalogInput): CatalogSource {
  return {
    command: client.command,
    modelCatalogCommand: () => client.modelsCommand().argv,
    modelCatalogInput: () => client.modelsCommand().stdin ?? undefined,
    parseModelCatalog: (stdout) => client.parseModels(stdout),
    optionValuesCommand: (name, model) => client.optionValuesCommand(name, model)?.argv ?? null,
    parseOptionValues: (name, text, model) => client.parseOptionValues(name, text, model),
    optionsCommand: () => client.optionsCommand(),
    parseOptions: (help) => client.parseOptions(help),
    providerOptions: () => client.options(),
  };
}

export type CatalogProvider = Provider & CatalogSource;

/** Widen a provider or client-keyed source; both already carry the catalog surface. */
export function asCatalog(source: Provider | CatalogSource): CatalogSource {
  const candidate = source as Partial<CatalogSource>;
  if (typeof candidate.modelCatalogCommand !== "function" || typeof candidate.parseModelCatalog !== "function") {
    throw new ProviderCommandFailed(`${source.command} does not list models.`);
  }
  return candidate as CatalogSource;
}

export async function loadCatalog(
  source: Provider | CatalogSource,
  which: Which,
  runCommand: RunCommand,
): Promise<CliModelCatalog> {
  if (which(source.command) === null) {
    throw new ProviderCommandFailed(
      `${source.command} is not on PATH, so its models could not be listed.`,
    );
  }
  const catalogSource = asCatalog(source);
  let stdout: string;
  try {
    stdout = await runCommand(catalogSource.modelCatalogCommand(), catalogSource.modelCatalogInput?.());
  } catch (error) {
    if (error instanceof ProviderCommandFailed) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new ProviderCommandFailed(`Could not list ${source.command} models: ${reason}`);
  }
  const catalog = catalogSource.parseModelCatalog(stdout);
  if (catalog.ids.length === 0) throw new ProviderCommandFailed(`${source.command} returned no models.`);
  return catalog;
}

export function knownModel(model: string, catalog: CliModelCatalog): string {
  const value = model.trim();
  if (!catalog.ids.includes(value)) throw new ProviderCommandFailed(`Unknown model: ${value}.`);
  return value;
}

export async function loadOptionValues(
  source: Provider | CatalogSource,
  name: string,
  model: string,
  catalog: CliModelCatalog,
  which: Which,
  runCommand: RunCommand,
): Promise<readonly string[] | null> {
  const found = catalog.valuesFor(model, name);
  if (found !== null) return found;
  const catalogSource = asCatalog(source);
  const argv = catalogSource.optionValuesCommand(name, model);
  if (argv === null) return null;
  if (which(source.command) === null) {
    throw new ProviderCommandFailed(
      `${source.command} is not on PATH, so its ${name} values could not be listed.`,
    );
  }
  let text: string;
  try {
    text = await runCommand(argv);
  } catch (error) {
    if (error instanceof ProviderCommandFailed) text = error.message;
    else {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProviderCommandFailed(`Could not list ${source.command} ${name} values for ${model}: ${reason}`);
    }
  }
  return catalogSource.parseOptionValues(name, text, model);
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
