import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { PluginManifest, PluginRegistry } from '@nodeint/migent-contracts';
import type { ClientRegistry } from '@nodeint/migent-kernel';
import { ConfigurationError, loadWorkspaceConfig, pluginEntryIssues, registryManifests, resolvePluginTarget } from '@nodeint/migent-kernel';
import type { InspectedPlugin, PluginsInspection } from '@nodeint/migent-session';
import { effectiveConfigSection, readParsedEvents, readWorkflowFreeze, WORKFLOW_FREEZE_FILE } from '@nodeint/migent-session';
import { isRecord } from '@nodeint/migent-workflow';

import { declaresAgent, defaultEnabledIds, isEnabledEntry, pluginClassifier } from './freeze.js';

/** One plugin entry that runs in a session. */
export interface SelectedPlugin {
  readonly id: string;
  readonly version: string;
  readonly manifest: PluginManifest;
  /**
   * `frozen` runs the frozen config and target; `live` (advisory) runs the live config; `implicit` is a default
   * entry the freeze never recorded, run enabled with empty options at the current version.
   */
  readonly source: 'frozen' | 'live' | 'implicit';
  readonly config: Record<string, unknown>;
  /** The frozen agent target of a non-advisory `invokeAgent` plugin. Bound in a later phase. */
  readonly target: Record<string, unknown> | null;
}

/** A live entry that cannot run. The host records one `unavailable` failure for it at its first trigger. */
export interface UnavailablePlugin {
  readonly id: string;
  readonly error: string;
}

export interface PluginSelection {
  readonly selected: readonly SelectedPlugin[];
  readonly unavailable: readonly UnavailablePlugin[];
  /** Unregistered ids the freeze never saw. They run for no hook. */
  readonly addedAfterFreeze: readonly string[];
}

export const NO_PLUGINS: PluginSelection = { selected: [], unavailable: [], addedAfterFreeze: [] };

interface FrozenRecord {
  readonly hash: string;
  readonly plugins: ReadonlyMap<string, { version: string | null; target: Record<string, unknown> | null }>;
}

function lastFrozenRecord(sessionDirectory: string): FrozenRecord | null {
  const events = readParsedEvents(path.join(sessionDirectory, 'events.jsonl')).filter((event) => event.event === 'plugins.frozen');
  const last = events.at(-1);
  if (last === undefined) return null;
  const list = Array.isArray(last.data.plugins) ? last.data.plugins as Record<string, unknown>[] : [];
  const plugins = new Map(list.map((row) => [String(row.id), {
    version: typeof row.version === 'string' ? row.version : null,
    target: isRecord(row.target) ? row.target : null,
  }] as const));
  return { hash: String(last.data.freeze_hash), plugins };
}

/**
 * Chain order (design D5). Defaults the freeze never recorded come first, then the recorded order of
 * `plugins.frozen`, which is the configuration order and includes advisory entries, then anything else.
 */
export function chainOrder<T>(
  recorded: readonly string[],
  byId: ReadonlyMap<string, T>,
  implicit: ReadonlySet<string>,
): T[] {
  const seen = new Set(recorded);
  const unrecorded = [...implicit].filter((id) => !seen.has(id));
  const ids = [...new Set([...unrecorded, ...recorded, ...byId.keys()])];
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id) as T] : []));
}

/**
 * The default plugins that run implicitly: not frozen, not named by a live entry, and not disabled by the
 * live config. This covers an unrecorded default (old freeze) and an advisory default the live config omits.
 */
function implicitDefaults(
  registry: PluginRegistry,
  config: Record<string, unknown>,
  taken: ReadonlySet<string>,
): string[] {
  const live = isRecord(config.plugins) ? config.plugins : {};
  const disabled = (id: string): boolean => Object.hasOwn(live, id) && !isEnabledEntry(live[id]);
  return defaultEnabledIds(registry).filter((id) => !taken.has(id) && !disabled(id));
}

const refreshHint = (file: string): string => `Run: migent session continue --refresh-workflow (rewrites ${file}).`;

function assertFreezeMatches(sessionDirectory: string, frozen: FrozenRecord | null): FrozenRecord {
  const file = path.join(sessionDirectory, WORKFLOW_FREEZE_FILE);
  if (frozen === null) {
    throw new ConfigurationError(`${file} has a plugins section but the session recorded no plugins.frozen event. ${refreshHint(WORKFLOW_FREEZE_FILE)}`, { code: 'plugins-freeze-missing' });
  }
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (hash !== frozen.hash) {
    throw new ConfigurationError(`${file} does not match the recorded plugins.frozen event. ${refreshHint(WORKFLOW_FREEZE_FILE)}`, { code: 'plugins-freeze-mismatch' });
  }
  return frozen;
}

function frozenSelection(
  entries: Readonly<Record<string, unknown>>,
  frozen: FrozenRecord,
  registry: PluginRegistry,
): SelectedPlugin[] {
  const selected: SelectedPlugin[] = [];
  for (const [id, entry] of Object.entries(entries)) {
    if (!isEnabledEntry(entry)) continue;
    const pinned = frozen.plugins.get(id);
    const manifest = registry.get(id)?.manifest;
    if (manifest === undefined) {
      throw new ConfigurationError(`Plugin "${id}" is enabled in this session's freeze but is no longer registered.`, { code: 'plugin-unregistered', path: ['plugins', id] });
    }
    if (pinned === undefined || pinned.version !== manifest.version) {
      throw new ConfigurationError(
        `Plugin "${id}" changed version since the session was frozen (frozen ${pinned?.version ?? 'unknown'}, now ${manifest.version}).`,
        { code: 'plugin-version-changed', path: ['plugins', id] },
      );
    }
    selected.push({ id, version: manifest.version, manifest, source: 'frozen', config: entry as Record<string, unknown>, target: pinned.target });
  }
  return selected;
}

/** The message of a target that does not resolve; null when it resolves. */
function targetError(
  config: Record<string, unknown>,
  plugin: { id: string; entry: unknown },
  clients: ClientRegistry,
): string | null {
  try {
    resolvePluginTarget(config, plugin, clients);
    return null;
  } catch (caught) {
    if (!(caught instanceof ConfigurationError)) throw caught;
    return caught.message;
  }
}

/** A default entry with empty options: `live` when the freeze recorded it as advisory, else `implicit`. */
function implicitPlugin(id: string, registry: PluginRegistry, recordedLive: ReadonlySet<string>): SelectedPlugin {
  const manifest = registry.get(id)?.manifest as PluginManifest;
  const source = recordedLive.has(id) ? 'live' : 'implicit';
  return { id, version: manifest.version, manifest, source, config: {}, target: null };
}

function liveSelection(
  live: readonly { id: string; value: unknown }[],
  context: { registry: PluginRegistry; clients: ClientRegistry; config: Record<string, unknown> },
): { selected: SelectedPlugin[]; unavailable: UnavailablePlugin[] } {
  const { registry, clients, config } = context;
  const manifests = registryManifests(registry);
  const selected: SelectedPlugin[] = [];
  const unavailable: UnavailablePlugin[] = [];
  for (const { id, value } of live) {
    if (!isEnabledEntry(value)) continue;
    const [issue] = pluginEntryIssues({ plugins: { [id]: value }, manifests });
    const manifest = registry.get(id)?.manifest;
    const needsTarget = issue === undefined && manifest !== undefined && declaresAgent(manifest);
    const error = issue?.message ?? (needsTarget ? targetError(config, { id, entry: value }, clients) : null);
    if (error !== null || manifest === undefined) unavailable.push({ id, error: error ?? `Plugin "${id}" is not registered.` });
    else {
      selected.push({
        id, version: manifest.version, manifest, source: 'live', config: value as Record<string, unknown>, target: null,
      });
    }
  }
  return { selected, unavailable };
}

/**
 * The live config. A session frozen without plugins keeps resuming while the live config is unreadable, as a
 * frozen workflow does; one frozen with plugins needs it for its live entries.
 */
function readLiveConfig(workspace: string, required: boolean): Record<string, unknown> {
  if (required) return loadWorkspaceConfig(workspace);
  try {
    return loadWorkspaceConfig(workspace);
  } catch {
    return {};
  }
}

/**
 * Which plugin entries run in an existing session, computed before any dispatch. Checks the freeze against the
 * recorded `plugins.frozen`, then each enabled frozen entry against the registry, then classifies and validates
 * the live entries. Throws a `ConfigurationError` (exit 2) for a mismatch, a missing or changed plugin.
 * Sessions whose freeze has no `plugins` section skip the freeze checks (older sessions).
 */
export function selectPlugins(
  workspace: string,
  sessionDirectory: string,
  context: { registry: PluginRegistry; clients: ClientRegistry },
): PluginSelection {
  const freeze = readWorkflowFreeze(sessionDirectory);
  if (freeze === null) return NO_PLUGINS;
  const record = freeze.config.plugins;
  const frozenSection = record?.kind === 'per_entry' ? record : null;
  const config = readLiveConfig(workspace, frozenSection !== null);
  const defaults = defaultEnabledIds(context.registry);
  if (frozenSection === null && !Object.hasOwn(config, 'plugins') && defaults.length === 0) return NO_PLUGINS;
  const frozen = frozenSection === null
    ? null
    : assertFreezeMatches(sessionDirectory, lastFrozenRecord(sessionDirectory));
  const classify = pluginClassifier(context.registry, frozenSection?.liveEntries ?? []);
  const effective = effectiveConfigSection(freeze, config, { key: 'plugins', classifiers: { plugins: classify } });
  const entries = effective?.kind === 'per_entry' ? effective : { entries: {}, live: [], addedAfterFreeze: [] };
  const fromFreeze = frozen === null ? [] : frozenSelection(entries.entries, frozen, context.registry);
  const live = liveSelection(entries.live, { ...context, config });
  const taken = new Set([...Object.keys(entries.entries), ...entries.live.map((entry) => entry.id)]);
  const implicit = implicitDefaults(context.registry, config, taken)
    .map((id) => implicitPlugin(id, context.registry, new Set(frozenSection?.liveEntries ?? [])));
  const byId = new Map([...fromFreeze, ...live.selected, ...implicit].map((entry) => [entry.id, entry] as const));
  return {
    selected: chainOrder([...(frozen?.plugins.keys() ?? [])], byId, new Set(implicit.filter((entry) => entry.source === 'implicit').map((entry) => entry.id))),
    unavailable: live.unavailable,
    addedAfterFreeze: [...entries.addedAfterFreeze],
  };
}

/** The live facts of `session show`: the live advisory entries, and the unpinned ids. Never validates dispatch. */
interface ResolvedLive {
  keep: ReadonlySet<string>;
  live: InspectedPlugin[];
  implicit: InspectedPlugin[];
  added: string[];
  /** Why the live config could not be read when selection still runs the implicit defaults; else null. */
  unreadable: string | null;
}

/**
 * The live config for inspection. Like selection, a freeze without a plugins section tolerates an unreadable
 * config and still lists the implicit defaults, so the cause is returned for `live_unavailable`.
 */
function readInspectionConfig(
  workspace: string,
  required: boolean,
): { config: Record<string, unknown>; unreadable: string | null } {
  try {
    return { config: loadWorkspaceConfig(workspace), unreadable: null };
  } catch (caught) {
    if (required || !(caught instanceof ConfigurationError)) throw caught;
    return { config: {}, unreadable: caught.message };
  }
}

function resolveLive(
  workspace: string,
  sessionDirectory: string,
  registry: PluginRegistry,
): ResolvedLive | null {
  const freeze = readWorkflowFreeze(sessionDirectory);
  if (freeze === null) return null;
  const section = freeze.config.plugins?.kind === 'per_entry' ? freeze.config.plugins : null;
  const defaults = defaultEnabledIds(registry);
  const { config, unreadable } = readInspectionConfig(workspace, section !== null || defaults.length === 0);
  if (section === null && !Object.hasOwn(config, 'plugins') && defaults.length === 0) return null;
  const classify = pluginClassifier(registry, section?.liveEntries ?? []);
  const effective = effectiveConfigSection(freeze, config, { key: 'plugins', classifiers: { plugins: classify } });
  const per = effective?.kind === 'per_entry' ? effective : { entries: {}, live: [], addedAfterFreeze: [] };
  const live = per.live.map(({ id, value }): InspectedPlugin => ({
    id, version: registry.get(id)?.manifest.version ?? null, enabled: isEnabledEntry(value), advisory: true,
  }));
  const recordedLive = new Set(section?.liveEntries ?? []);
  const taken = new Set([...Object.keys(per.entries), ...per.live.map((entry) => entry.id)]);
  const implicit = implicitDefaults(registry, config, taken).map((id): InspectedPlugin => ({
    id,
    version: registry.get(id)?.manifest.version ?? null,
    enabled: true,
    advisory: registry.get(id)?.manifest.advisory === true,
    ...(recordedLive.has(id) ? {} : { source: 'implicit' as const }),
  }));
  return { keep: new Set(Object.keys(per.entries)), live, implicit, added: [...per.addedAfterFreeze], unreadable };
}

/**
 * Adds the facts that need the live config and the registry to an inspection: the live advisory entries replace
 * the frozen advisory rows, implicit default entries are listed, rows follow chain order, and `added_after_freeze`
 * lists the ids the freeze never pinned. These checks do not depend on the freeze hash, the frozen versions or
 * the registered plugins, so a mismatch or a missing plugin never hides them. When the live config cannot be read
 * or is invalid, the cause is recorded in `live_unavailable` and the frozen rows stay. With no inspection (a
 * session that recorded no plugin data), a section appears only when an implicit default is active.
 */
export function withLivePlugins(
  inspection: PluginsInspection | null,
  context: { workspace: string; sessionDirectory: string; registry: PluginRegistry },
): PluginsInspection | null {
  try {
    const resolved = resolveLive(context.workspace, context.sessionDirectory, context.registry);
    if (resolved === null) return inspection === null ? null : { ...inspection, added_after_freeze: [] };
    const base = inspection ?? EMPTY_INSPECTION;
    const frozen = base.active.filter((row) => resolved.keep.has(row.id));
    const byId = new Map([...frozen, ...resolved.live, ...resolved.implicit].map((row) => [row.id, row] as const));
    const active = chainOrder(base.active.map((row) => row.id), byId, new Set(resolved.implicit.filter((row) => row.source === 'implicit').map((row) => row.id)));
    if (inspection === null && active.length === 0) return null;
    return { ...base, active, added_after_freeze: resolved.added, live_unavailable: resolved.unreadable };
  } catch (caught) {
    if (!(caught instanceof ConfigurationError)) throw caught;
    return inspection === null ? null : { ...inspection, live_unavailable: caught.message };
  }
}

const EMPTY_INSPECTION: PluginsInspection = {
  active: [], invocations: [], added_after_freeze: null, live_unavailable: null, holds: [], freeze_mismatch: null,
  unrecorded: [],
};
