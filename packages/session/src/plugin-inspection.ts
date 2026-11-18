import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ConfigurationError } from '@nodeint/migent-kernel';

import type { ParsedEvent } from './session-events.js';
import { readParsedEvents } from './session-events.js';
import { unresolvedPluginHolds } from './session-fold-holds.js';
import { readWorkflowFreeze, WORKFLOW_FREEZE_FILE } from './session-freeze.js';

/** One entry of the last `plugins.frozen` record. */
export interface InspectedPlugin {
  readonly id: string;
  readonly version: string | null;
  readonly enabled: boolean;
  readonly advisory: boolean;
  /** `implicit`: a default entry the freeze never recorded, run at the current version. Absent otherwise. */
  readonly source?: 'implicit';
}

/** One applied or rejected intent of a `plugin.decision`. */
export interface InspectedResult {
  readonly kind: string;
  readonly status: string;
  readonly reason: string | null;
  readonly path: string | null;
}

/**
 * One invocation. `interrupted` has `plugin.hook_invoked` and no result: the process died in between, so any
 * external effect of the plugin is in an unknown state.
 */
export interface InspectedInvocation {
  readonly invocation_id: string | null;
  readonly plugin: string;
  readonly hook: string | null;
  readonly status: 'succeeded' | 'failed' | 'interrupted';
  readonly results: readonly InspectedResult[];
  readonly failure: { readonly reason: string; readonly error: string | null; readonly on_error: string } | null;
  readonly agent_calls: number;
}

export interface InspectedHold {
  readonly plugin: string;
  readonly hook: string | null;
  readonly on_error: 'stop' | 'fail';
  readonly error: string | null;
}

/** A file under `plugins/<id>/` that the latest applied `plugin.decision` does not account for. */
export interface UnrecordedFile {
  readonly path: string;
  readonly reason: 'no_decision' | 'content_mismatch';
  readonly recorded_sha256?: string;
  readonly actual_sha256?: string;
}

export interface PluginsInspection {
  readonly active: readonly InspectedPlugin[];
  readonly invocations: readonly InspectedInvocation[];
  /** Null until the caller resolves the live config; see `live_unavailable`. */
  readonly added_after_freeze: readonly string[] | null;
  /** Why the live config could not be resolved, or null. The active advisory entries then stay as frozen. */
  readonly live_unavailable: string | null;
  readonly holds: readonly InspectedHold[];
  readonly freeze_mismatch: string | null;
  /** Plugin files with no applied decision, or whose content differs from it (the accepted crash window). */
  readonly unrecorded: readonly UnrecordedFile[];
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const isRow = (item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item);
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRow) : []);

function activeOf(frozen: ParsedEvent | undefined): InspectedPlugin[] {
  return records(frozen?.data.plugins).map((row) => ({
    id: String(row.id),
    version: text(row.version),
    enabled: row.enabled !== false,
    advisory: row.advisory === true,
  }));
}

function resultsOf(value: unknown): InspectedResult[] {
  return records(value).map((row) => ({
    kind: String(row.kind),
    status: String(row.status),
    reason: text(row.reason),
    path: text(row.path),
  }));
}

function callCount(event: ParsedEvent): number {
  return Array.isArray(event.data.agent_calls) ? event.data.agent_calls.length : 0;
}

function failedInvocation(event: ParsedEvent, hook: string | null): InspectedInvocation {
  return {
    invocation_id: text(event.data.invocation_id),
    plugin: String(event.data.plugin),
    hook: text(event.data.hook) ?? hook,
    status: 'failed',
    results: [],
    failure: {
      reason: String(event.data.reason), error: text(event.data.error), on_error: String(event.data.on_error),
    },
    agent_calls: callCount(event),
  };
}

function decidedInvocation(event: ParsedEvent, hook: string | null): InspectedInvocation {
  return {
    invocation_id: text(event.data.invocation_id), plugin: String(event.data.plugin), hook, status: 'succeeded',
    results: resultsOf(event.data.results), failure: null, agent_calls: callCount(event),
  };
}

function startedInvocation(event: ParsedEvent, id: string): InspectedInvocation {
  return {
    invocation_id: id, plugin: String(event.data.plugin), hook: text(event.data.hook),
    status: 'interrupted', results: [], failure: null, agent_calls: 0,
  };
}

function resultOf(event: ParsedEvent, hook: string | null): InspectedInvocation {
  return event.event === 'plugin.failed' ? failedInvocation(event, hook) : decidedInvocation(event, hook);
}

function invocationsOf(events: readonly ParsedEvent[]): InspectedInvocation[] {
  const rows: InspectedInvocation[] = [];
  const open = new Map<string, number>();
  for (const event of events) {
    const id = text(event.data.invocation_id);
    if (event.event === 'plugin.hook_invoked' && id !== null) {
      open.set(id, rows.length);
      rows.push(startedInvocation(event, id));
      continue;
    }
    if (event.event !== 'plugin.decision' && event.event !== 'plugin.failed') continue;
    const at = id === null ? undefined : open.get(id);
    const hook = at === undefined ? null : rows[at]?.hook ?? null;
    rows.splice(at ?? rows.length, at === undefined ? 0 : 1, resultOf(event, hook));
  }
  return rows;
}

const CALLS_DIRECTORY = 'calls';

/** Every file under `plugins/<id>/`, as session-relative posix paths. `calls/` is audited through `agent_calls`. */
function pluginFiles(sessionDirectory: string): string[] {
  const root = path.join(sessionDirectory, 'plugins');
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const plugin of readdirSync(root, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    for (const entry of readdirSync(path.join(root, plugin.name), { withFileTypes: true })) {
      if (entry.name === CALLS_DIRECTORY || !entry.isFile()) continue;
      files.push(path.posix.join('plugins', plugin.name, entry.name));
    }
  }
  return files.sort();
}

/** The sha256 of the latest applied artifact result per path. */
function recordedHashes(events: readonly ParsedEvent[]): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const event of events) {
    if (event.event !== 'plugin.decision') continue;
    for (const row of records(event.data.results)) {
      if (row.kind === 'artifact' && row.status === 'applied' && typeof row.path === 'string' && typeof row.sha256 === 'string') {
        hashes.set(row.path, row.sha256);
      }
    }
  }
  return hashes;
}

function unrecordedOf(sessionDirectory: string, events: readonly ParsedEvent[]): UnrecordedFile[] {
  const recorded = recordedHashes(events);
  const rows: UnrecordedFile[] = [];
  for (const file of pluginFiles(sessionDirectory)) {
    const expected = recorded.get(file);
    if (expected === undefined) {
      rows.push({ path: file, reason: 'no_decision' });
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(path.join(sessionDirectory, file))).digest('hex');
    if (actual !== expected) {
      rows.push({ path: file, reason: 'content_mismatch', recorded_sha256: expected, actual_sha256: actual });
    }
  }
  return rows;
}

const MISSING_RECORD = `${WORKFLOW_FREEZE_FILE} has a plugins section but the session recorded no plugins.frozen event.`;

/** Whether the freeze file carries a `plugins` section; a freeze that cannot be read counts as a finding. */
function freezePlugins(sessionDirectory: string): FreezeSection {
  try {
    return { present: readWorkflowFreeze(sessionDirectory)?.config.plugins?.kind === 'per_entry', error: null };
  } catch (caught) {
    if (!(caught instanceof ConfigurationError)) throw caught;
    return { present: false, error: caught.message };
  }
}

interface FreezeSection { present: boolean; error: string | null }

function mismatchOf(sessionDirectory: string, frozen: ParsedEvent | undefined, section: FreezeSection): string | null {
  if (section.error !== null) return section.error;
  if (frozen === undefined) return section.present ? MISSING_RECORD : null;
  let hash: string;
  try {
    hash = createHash('sha256').update(readFileSync(path.join(sessionDirectory, WORKFLOW_FREEZE_FILE))).digest('hex');
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code !== 'ENOENT') throw caught;
    return `${WORKFLOW_FREEZE_FILE} is missing.`;
  }
  return hash === frozen.data.freeze_hash ? null : `${WORKFLOW_FREEZE_FILE} does not match the recorded plugins.frozen.`;
}

/**
 * The plugin facts of a session, derived on read from `plugins.frozen` and `plugin.*`. Null when the log has
 * none, so a session without plugins shows no section. `added_after_freeze` is filled by the caller that
 * knows the registry.
 */
export function readPluginsInspection(sessionDirectory: string): PluginsInspection | null {
  const events = readParsedEvents(path.join(sessionDirectory, 'events.jsonl'));
  const pluginEvents = events.filter((event) => event.event.startsWith('plugin'));
  const section = freezePlugins(sessionDirectory);
  // Evidence of plugin data is a plugin record or a plugins-bearing freeze. An unreadable freeze alone is not.
  const unrecorded = unrecordedOf(sessionDirectory, pluginEvents);
  if (pluginEvents.length === 0 && !section.present && unrecorded.length === 0) return null;
  const frozen = pluginEvents.filter((event) => event.event === 'plugins.frozen').at(-1);
  return {
    active: activeOf(frozen),
    invocations: invocationsOf(pluginEvents),
    added_after_freeze: null,
    live_unavailable: null,
    holds: unresolvedPluginHolds(events).map(({ plugin, hook, on_error: onError, error }) => ({
      plugin, hook, on_error: onError, error,
    })),
    freeze_mismatch: mismatchOf(sessionDirectory, frozen, section),
    unrecorded,
  };
}
