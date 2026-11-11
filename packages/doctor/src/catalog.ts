import type { ClientOption, CliModelCatalog, CommandSpec } from '@nodeint/migent-kernel';

export type Which = (command: string) => string | null;
export type RunCommand = (argv: string[], input?: string) => string | Promise<string>;

/** A client command could not run or answered unusably. */
export class ClientCommandFailed extends Error {}

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
  valueMode: 'required' | 'optional' | 'none' | 'unknown';
  type: 'string' | 'number' | 'boolean' | 'array' | 'unknown';
  choices: string[] | null;
  defaultValue: string | null;
}

/** Everything catalog and help discovery needs, read from one CLI client. */
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
  clientOptions(): readonly ClientOption[];
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
  options(): readonly ClientOption[];
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
    clientOptions: () => client.options(),
  };
}

/** Widen a client into the catalog surface, refusing one that lists no models. */
export function asCatalog(source: CatalogSource): CatalogSource {
  const candidate = source as Partial<CatalogSource>;
  if (typeof candidate.modelCatalogCommand !== 'function' || typeof candidate.parseModelCatalog !== 'function') {
    throw new ClientCommandFailed(`${source.command} does not list models.`);
  }
  return candidate as CatalogSource;
}

function requireOnPath(source: CatalogSource, which: Which): CatalogSource {
  if (which(source.command) === null) {
    throw new ClientCommandFailed(
      `${source.command} is not on PATH, so its models could not be listed.`,
    );
  }
  return asCatalog(source);
}

function runFailure(source: CatalogSource, error: unknown): ClientCommandFailed {
  if (error instanceof ClientCommandFailed) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new ClientCommandFailed(`Could not list ${source.command} models: ${reason}`);
}

function parseCatalog(source: CatalogSource, stdout: string): CliModelCatalog {
  const catalog = source.parseModelCatalog(stdout);
  if (catalog.ids.length === 0) throw new ClientCommandFailed(`${source.command} returned no models.`);
  return catalog;
}

export async function loadCatalog(
  source: CatalogSource,
  which: Which,
  runCommand: RunCommand,
): Promise<CliModelCatalog> {
  const catalogSource = requireOnPath(source, which);
  let stdout: string;
  try {
    stdout = await runCommand(catalogSource.modelCatalogCommand(), catalogSource.modelCatalogInput?.());
  } catch (error) {
    throw runFailure(source, error);
  }
  return parseCatalog(catalogSource, stdout);
}

/** Same steps and messages as `loadCatalog`, for callers that cannot await (config resolution). */
export function loadCatalogSync(
  source: CatalogSource,
  which: Which,
  runCommand: (argv: string[], input?: string) => string,
): CliModelCatalog {
  const catalogSource = requireOnPath(source, which);
  let stdout: string;
  try {
    stdout = runCommand(catalogSource.modelCatalogCommand(), catalogSource.modelCatalogInput?.());
  } catch (error) {
    throw runFailure(source, error);
  }
  return parseCatalog(catalogSource, stdout);
}

/** One client's catalog outcome: its model ids, not on PATH, or a failure. */
export type CatalogOutcome =
  | { status: 'loaded'; ids: readonly string[] }
  | { status: 'skipped' }
  | { status: 'failed'; reason: string };

/** The same lookup name `model-check` uses: opencode's `#variant` suffix is not in its catalog. */
export function catalogLookupName(command: string, model: string): string {
  const hash = model.indexOf('#');
  return command === 'opencode' && hash > 0 ? model.slice(0, hash) : model;
}

/** Pure lookup policy: which clients list `model`, given every client's catalog outcome. */
export function clientsListingModel(
  model: string,
  clients: readonly { id: string; command: string; outcome: CatalogOutcome }[],
): {
  matches: string[];
  searched: string[];
  skipped: string[];
  failed: { client: string; reason: string }[];
} {
  const result = { matches: [] as string[], searched: [] as string[], skipped: [] as string[], failed: [] as { client: string; reason: string }[] };
  const name = model.trim();
  for (const { id, command, outcome } of clients) {
    if (outcome.status === 'skipped') result.skipped.push(id);
    else if (outcome.status === 'failed') result.failed.push({ client: id, reason: outcome.reason });
    else {
      result.searched.push(id);
      if (outcome.ids.includes(catalogLookupName(command, name))) result.matches.push(id);
    }
  }
  return result;
}

export function knownModel(model: string, catalog: CliModelCatalog): string {
  const value = model.trim();
  if (!catalog.ids.includes(value)) throw new ClientCommandFailed(`Unknown model: ${value}.`);
  return value;
}

export async function loadOptionValues(
  source: CatalogSource,
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
    throw new ClientCommandFailed(
      `${source.command} is not on PATH, so its ${name} values could not be listed.`,
    );
  }
  let text: string;
  try {
    text = await runCommand(argv);
  } catch (error) {
    if (error instanceof ClientCommandFailed) text = error.message;
    else {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ClientCommandFailed(`Could not list ${source.command} ${name} values for ${model}: ${reason}`);
    }
  }
  return catalogSource.parseOptionValues(name, text, model);
}

/** Shares one command run per argv so each client catalog is fetched once per doctor run. */
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
