import { type CliClient, clientIds as registeredClientIds, createClient, type HeadlessOption } from '@nodeint/migent-adapters';
import {
  cached,
  type CatalogSource,
  clientCatalogSource,
  loadCatalog,
  loadOptionValues,
  type RunCommand,
  type Which,
} from '@nodeint/migent-doctor';
import { type CliModelCatalog,ConfigurationError, whichSync } from '@nodeint/migent-kernel';

import { loadHeadlessOptions, runClientCommand,runOptionsCommand } from '../client.js';
import { cliHooks } from '../hooks.js';

/** What one client's discovery returned. Discovery failures never throw. */
export type DiscoveryOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'skipped'; message: string }
  | { status: 'failed'; message: string };

export interface EffortRow {
  model: string;
  option: string;
  values: readonly string[];
}

/**
 * Machine-level facts for one invocation. Reads only what a type needs:
 * availability is a PATH lookup, catalogs and help run the client's own
 * command once each, and every failure becomes a per-client outcome.
 */
export interface DiscoveryContext {
  readonly clientIds: readonly string[];
  client(id: string): CliClient;
  pathOf(client: CliClient): string | null;
  catalog(client: CliClient): Promise<DiscoveryOutcome<CliModelCatalog>>;
  effort(client: CliClient, model: string): Promise<DiscoveryOutcome<readonly string[] | null>>;
  efforts(client: CliClient): Promise<DiscoveryOutcome<EffortRow[]>>;
  nativeOptions(client: CliClient): Promise<DiscoveryOutcome<readonly HeadlessOption[]>>;
  warn(message: string): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDiscoveryContext(
  options: {
    which?: Which;
    runCommand?: RunCommand;
    optionsRunner?: RunCommand;
    warn?: (message: string) => void;
  } = {},
): DiscoveryContext {
  const which = options.which ?? cliHooks.which ?? whichSync;
  const run = cached(options.runCommand ?? cliHooks.runCommand ?? runClientCommand);
  const optionsRun = options.optionsRunner ?? cliHooks.runCommand ?? runOptionsCommand;
  const warn = options.warn ?? ((message: string) => process.stderr.write(`warning: ${message}\n`));
  const ids = registeredClientIds();
  const clients = new Map<string, CliClient>();
  const sources = new Map<string, CatalogSource>();
  const catalogs = new Map<string, Promise<DiscoveryOutcome<CliModelCatalog>>>();
  const help = new Map<string, Promise<DiscoveryOutcome<readonly HeadlessOption[]>>>();

  const client = (id: string): CliClient => {
    const cachedClient = clients.get(id);
    if (cachedClient !== undefined) return cachedClient;
    if (!ids.includes(id)) {
      throw new ConfigurationError(`Unknown client: ${id}. Valid clients: ${ids.join(', ')}.`);
    }
    const created = createClient(id);
    clients.set(id, created);
    return created;
  };

  const source = (target: CliClient): CatalogSource => {
    let value = sources.get(target.id);
    if (value === undefined) {
      value = clientCatalogSource(target);
      sources.set(target.id, value);
    }
    return value;
  };

  const pathOf = (target: CliClient): string | null => which(target.command);

  const catalog = (target: CliClient): Promise<DiscoveryOutcome<CliModelCatalog>> =>
    onPathOnce(catalogs, { target, pathOf }, () => loadCatalog(source(target), which, run));

  const probe: EffortProbe = { catalog, source, which, run };
  const effort = (target: CliClient, model: string): Promise<DiscoveryOutcome<readonly string[] | null>> =>
    modelEffort(probe, target, model);
  const efforts = (target: CliClient): Promise<DiscoveryOutcome<EffortRow[]>> => clientEfforts(probe, target);

  const nativeOptions = (target: CliClient): Promise<DiscoveryOutcome<readonly HeadlessOption[]>> =>
    onPathOnce(help, { target, pathOf }, () => loadHeadlessOptions(source(target), optionsRun));

  return { clientIds: ids, client, pathOf, catalog, effort, efforts, nativeOptions, warn };
}

/** Runs `load` once per client, skipping a client whose command is not on PATH. */
function onPathOnce<T>(
  cache: Map<string, Promise<DiscoveryOutcome<T>>>,
  subject: { target: CliClient; pathOf: (client: CliClient) => string | null },
  load: () => Promise<T>,
): Promise<DiscoveryOutcome<T>> {
  const { target, pathOf } = subject;
  const existing = cache.get(target.id);
  if (existing !== undefined) return existing;
  const pending = (async (): Promise<DiscoveryOutcome<T>> => {
    if (pathOf(target) === null) {
      return { status: 'skipped', message: `${target.command} is not on PATH` };
    }
    try {
      return { status: 'ok', value: await load() };
    } catch (error) {
      return { status: 'failed', message: messageOf(error) };
    }
  })();
  cache.set(target.id, pending);
  return pending;
}

interface EffortProbe {
  catalog(client: CliClient): Promise<DiscoveryOutcome<CliModelCatalog>>;
  source(client: CliClient): CatalogSource;
  which: Which;
  run: RunCommand;
}

/** Effort values for one catalog model: the catalog's own, else probed (an empty list when the probe finds none). */
async function effortValues(
  probe: EffortProbe,
  target: CliClient,
  request: { option: string; model: string; catalog: CliModelCatalog },
): Promise<readonly string[]> {
  const { option, model, catalog } = request;
  const known = catalog.valuesFor(model, option);
  if (known !== null) return known;
  const probed = await loadOptionValues(
    { source: probe.source(target), name: option, model, catalog },
    { which: probe.which, runCommand: probe.run },
  );
  return probed ?? [];
}

/**
 * Effort values for one model, `null` when the model is not in the client's
 * catalog, or a known (possibly empty) value list. A model the catalog does
 * not list is never probed, so a per-model command cannot invent a row for
 * an arbitrary name.
 */
async function modelEffort(
  probe: EffortProbe,
  target: CliClient,
  model: string,
): Promise<DiscoveryOutcome<readonly string[] | null>> {
  const option = target.effortOption;
  if (option === undefined) return { status: 'ok', value: null };
  const loaded = await probe.catalog(target);
  if (loaded.status !== 'ok') return loaded;
  if (!loaded.value.ids.includes(model)) return { status: 'ok', value: null };
  try {
    return { status: 'ok', value: await effortValues(probe, target, { option, model, catalog: loaded.value }) };
  } catch (error) {
    return { status: 'failed', message: messageOf(error) };
  }
}

async function clientEfforts(probe: EffortProbe, target: CliClient): Promise<DiscoveryOutcome<EffortRow[]>> {
  const option = target.effortOption;
  // A client with no effort option is not probed at all.
  if (option === undefined) return { status: 'ok', value: [] };
  const loaded = await probe.catalog(target);
  if (loaded.status !== 'ok') return loaded;
  const rows: EffortRow[] = [];
  for (const model of loaded.value.ids) {
    try {
      rows.push({ model, option, values: await effortValues(probe, target, { option, model, catalog: loaded.value }) });
    } catch (error) {
      return { status: 'failed', message: messageOf(error) };
    }
  }
  return { status: 'ok', value: rows };
}
