import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { PluginManifest, PluginRegistry } from '@nodeint/migent-contracts';
import type { ClientRegistry } from '@nodeint/migent-kernel';
import { ConfigurationError, loadWorkspaceConfig, pluginEntryIssues, registryManifests, resolvePluginTarget } from '@nodeint/migent-kernel';
import type { InspectedPlugin, PluginsInspection } from '@nodeint/migent-session';
import { effectiveConfigSection, readParsedEvents, readWorkflowFreeze, WORKFLOW_FREEZE_FILE } from '@nodeint/migent-session';
import { isRecord } from '@nodeint/migent-workflow';

import { declaresAgent, isEnabledEntry, pluginClassifier } from './freeze.js';

/** One plugin entry that runs in a session. */
export interface SelectedPlugin {
  readonly id: string;
  readonly version: string;
  readonly manifest: PluginManifest;
  /** `frozen` runs the frozen config and target; `live` (advisory) runs the live config. */
  readonly source: 'frozen' | 'live';
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
  if (frozenSection === null && !Object.hasOwn(config, 'plugins')) return NO_PLUGINS;
  const frozen = frozenSection === null
    ? null
    : assertFreezeMatches(sessionDirectory, lastFrozenRecord(sessionDirectory));
  const classify = pluginClassifier(context.registry, frozenSection?.liveEntries ?? []);
  const effective = effectiveConfigSection(freeze, config, { key: 'plugins', classifiers: { plugins: classify } });
  if (effective?.kind !== 'per_entry') return NO_PLUGINS;
  const fromFreeze = frozen === null ? [] : frozenSelection(effective.entries, frozen, context.registry);
  const live = liveSelection(effective.live, { ...context, config });
  return {
    selected: [...fromFreeze, ...live.selected].sort((a, b) => a.id.localeCompare(b.id)),
    unavailable: live.unavailable,
    addedAfterFreeze: effective.addedAfterFreeze,
  };
}

/** The live facts of `session show`: the live advisory entries, and the unpinned ids. Never validates dispatch. */
function resolveLive(
  workspace: string,
  sessionDirectory: string,
  registry: PluginRegistry,
): { keep: ReadonlySet<string>; live: InspectedPlugin[]; added: string[] } | null {
  const freeze = readWorkflowFreeze(sessionDirectory);
  if (freeze === null) return null;
  const section = freeze.config.plugins?.kind === 'per_entry' ? freeze.config.plugins : null;
  const config = readLiveConfig(workspace, true);
  if (section === null && !Object.hasOwn(config, 'plugins')) return null;
  const classify = pluginClassifier(registry, section?.liveEntries ?? []);
  const effective = effectiveConfigSection(freeze, config, { key: 'plugins', classifiers: { plugins: classify } });
  if (effective?.kind !== 'per_entry') return null;
  const live = effective.live.map(({ id, value }): InspectedPlugin => ({
    id, version: registry.get(id)?.manifest.version ?? null, enabled: isEnabledEntry(value), advisory: true,
  }));
  return { keep: new Set(Object.keys(effective.entries)), live, added: [...effective.addedAfterFreeze] };
}

/**
 * Adds the facts that need the live config and the registry to an inspection: the live advisory entries replace
 * the frozen advisory rows, and `added_after_freeze` lists the ids the freeze never pinned. These checks do not
 * depend on the freeze hash, the frozen versions or the registered plugins, so a mismatch or a missing plugin
 * never hides them. When the live config cannot be read or is invalid, the cause is recorded in
 * `live_unavailable` and the frozen rows stay.
 */
export function withLivePlugins(
  inspection: PluginsInspection,
  context: { workspace: string; sessionDirectory: string; registry: PluginRegistry },
): PluginsInspection {
  try {
    const resolved = resolveLive(context.workspace, context.sessionDirectory, context.registry);
    if (resolved === null) return { ...inspection, added_after_freeze: [] };
    const frozen = inspection.active.filter((row) => resolved.keep.has(row.id));
    const active = [...frozen, ...resolved.live].sort((a, b) => a.id.localeCompare(b.id));
    return { ...inspection, active, added_after_freeze: resolved.added };
  } catch (caught) {
    if (!(caught instanceof ConfigurationError)) throw caught;
    return { ...inspection, live_unavailable: caught.message };
  }
}
