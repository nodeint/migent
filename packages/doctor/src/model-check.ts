import {
  type AgentDefinitionEntry,
  type CliClient,
  type ClientRegistry,
  listAgentDefinitions,
  loadWorkspaceConfig,
} from '@nodeint/migent-kernel';

import {
  cached,
  catalogLookupName,
  type ClientCatalogInput,
  clientCatalogSource,
  knownModel,
  loadCatalog,
  type RunCommand,
  type Which,
} from './catalog.js';
import type { ModelEffortCheck } from './check.js';
import { agentClientType } from './client-type.js';
import { checkModelEfforts } from './effort-check.js';

/**
 * A name missing from the catalog is a hard error only for these client CLIs, keyed by command.
 * Each prints every model it can run:
 * - opencode: `opencode models` lists every provider/model pair it can route to.
 * - grok: `grok models` prints the full "Available models" list.
 * - agy: `agy models` prints the full model list.
 * The others are warning-only because a missing name does not prove the model is unusable:
 * - claude: the catalog is the subscription's picker. It lists aliases (`sonnet`, `opus`) and their
 *   resolved ids, but omits older or pinned full ids that `--model` still accepts.
 * - codex: the catalog drops entries whose visibility is not "list" (hidden models still run) and
 *   depends on the signed-in account.
 * An unknown client command defaults to warning-only.
 */
const RELIABLE_CATALOGS: ReadonlySet<string> = new Set(['opencode', 'grok', 'agy']);

function catalogName(client: CliClient, model: string): string {
  return catalogLookupName(client.command, model);
}

/** Checks model availability, then efforts (skipped for unknown models), and merges both per key. */
/** Name check and effort check, behind one entry. */
export interface ModelCheckOptions {
  readonly which: Which;
  readonly runCommand: RunCommand;
  readonly only?: ReadonlySet<string>;
  /** Inline stage agents, checked like named ones. */
  readonly extra?: readonly AgentDefinitionEntry[];
}

export async function checkModels(
  workspace: string,
  clients: ClientRegistry,
  options: ModelCheckOptions,
): Promise<Record<string, ModelEffortCheck>> {
  const { which, runCommand, only, extra } = options;
  const run = cached(runCommand);
  const unreadable = new Set<string>();
  const missed = new Set<string>();
  const availability = await checkModelAvailability(
    workspace,
    clients,
    { which, runCommand: run, only, unreadable, missed, extra },
  );
  // One root cause, one message: skip the effort check for any model the catalog does not list.
  const skip = new Set([...missed, ...Object.keys(availability).filter((key) => availability[key]?.problem)]);
  const efforts = await checkModelEfforts(workspace, clients, { which, runCommand: run, only, skip, extra });
  const merged: Record<string, ModelEffortCheck> = {};
  for (const key of new Set([...Object.keys(availability), ...Object.keys(efforts)])) {
    const problem = [availability[key]?.problem, efforts[key]?.problem].filter((item) => item !== undefined);
    // A catalog that cannot be read yields one root cause: keep the model warning, drop the effort one.
    const effortWarning = unreadable.has(key) ? undefined : efforts[key]?.warning;
    const warning = [availability[key]?.warning, effortWarning].filter((item) => item !== undefined);
    const check: ModelEffortCheck = {};
    if (problem.length > 0) check.problem = problem.join('\n');
    if (warning.length > 0) check.warning = warning.join('\n');
    if (check.problem !== undefined || check.warning !== undefined) merged[key] = check;
  }
  return merged;
}

export interface AvailabilityCheckOptions extends ModelCheckOptions {
  /** Receives the keys whose client catalog could not be read. */
  readonly unreadable?: Set<string>;
  /** Receives the keys the catalog was read for but does not list, whatever the severity. */
  readonly missed?: Set<string>;
}

export async function checkModelAvailability(
  workspace: string,
  clients: ClientRegistry,
  options: AvailabilityCheckOptions,
): Promise<Record<string, ModelEffortCheck>> {
  const { which, runCommand, only, unreadable = new Set<string>(), missed = new Set<string>(), extra = [] } = options;
  let config: Record<string, unknown>;
  try { config = loadWorkspaceConfig(workspace); } catch { return {}; }
  const definitions = [...listAgentDefinitions(config), ...extra];
  const run = cached(runCommand);
  const sinks = { unreadable, missed };
  const results = await Promise.all(definitions.map(async (entry) => {
    if (only !== undefined && !only.has(entry.key)) return null;
    const target = availabilityTarget(entry.value, clients);
    if (target === null) return null;
    const check = await lookupModel(entry, target, { which, run, ...sinks });
    return check === null ? null : [entry.key, check] as const;
  }));
  return Object.fromEntries(results.filter((entry) => entry !== null));
}

/** The client and trimmed model name to look up, or null when the structural check explains the definition. */
interface AvailabilityTarget {
  client: CliClient;
  name: string;
  value: string;
}

function availabilityTarget(model: unknown, clients: ClientRegistry): AvailabilityTarget | null {
  // Unmapped agents (empty definitions) are reported by the structural check.
  if (!isRecord(model) || Object.keys(model).length === 0) return null;
  if (typeof model.model !== 'string' || !model.model.trim()) return null;
  if (clientUnusable(model)) return null;
  const type = agentClientType(model, clients);
  if (type === undefined) return null; // The structural check explains the missing client.
  try {
    return { client: clients.get(type), name: model.model.trim(), value: JSON.stringify(model.model) };
  } catch { return null; } // The structural check explains an unsupported client.
}

/** Looks one model up in its client's catalog; null when the catalog lists it. */
async function lookupModel(
  entry: AgentDefinitionEntry,
  target: AvailabilityTarget,
  machine: { which: Which; run: RunCommand; unreadable: Set<string>; missed: Set<string> },
): Promise<ModelEffortCheck | null> {
  const { client, name, value } = target;
  const field = `${entry.field}.model`;
  const source = clientCatalogSource(client as unknown as ClientCatalogInput);
  const lookup = catalogName(client, name);
  let catalog;
  try {
    catalog = await loadCatalog(source, machine.which, machine.run);
  } catch (error) {
    machine.unreadable.add(entry.key);
    return { warning: `Could not validate ${field}: ${value}\n${error instanceof Error ? error.message : String(error)}` };
  }
  try { knownModel(lookup, catalog); return null; } catch (error) {
    machine.missed.add(entry.key);
    if (!RELIABLE_CATALOGS.has(client.command)) {
      return { warning: `Could not validate ${field}: ${value}\n${client.command} does not list ${name}; its model list may be incomplete.` };
    }
    const near = closest(lookup, catalog.ids);
    const hint = near.length > 0 ? `\nDid you mean: ${near.join(', ')}` : '';
    return { problem: `Invalid ${field}: ${value}\n${error instanceof Error ? error.message : String(error)}${hint}` };
  }
}

/** Edit-distance budget: at least this, growing with name length. */
const MIN_TYPO_DISTANCE = 2;
const TYPO_LENGTH_DIVISOR = 4;
const MAX_SUGGESTIONS = 5;

/** Up to five catalog names that share a prefix with, or sit a few edits from, the typo. */
export function closest(name: string, ids: readonly string[]): string[] {
  const target = name.toLowerCase();
  const limit = Math.max(MIN_TYPO_DISTANCE, Math.ceil(target.length / TYPO_LENGTH_DIVISOR));
  return ids
    .map((id) => {
      const lower = id.toLowerCase();
      const prefix = lower.startsWith(target) || target.startsWith(lower);
      return { id, score: prefix ? 0 : distance(target, lower) };
    })
    .filter((entry) => entry.score <= limit)
    .sort((left, right) => left.score - right.score || left.id.localeCompare(right.id))
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.id);
}

function distance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `client` is present but is not a mapping with a usable `type`: the structural check explains it. */
function clientUnusable(definition: Record<string, unknown>): boolean {
  const {client} = definition;
  if ((client === null || client === undefined)) return false;
  if (!isRecord(client)) return true;
  return (client.type !== null && client.type !== undefined) && (typeof client.type !== 'string' || client.type.trim() === '');
}
