import { createHash } from 'node:crypto';
import path from 'node:path';

import type { ExtensionCatalog, ExtensionLevel, SessionEventRecord } from '@nodeint/migent-contracts';
import { EXTENSION_LEVELS, PLUGIN_EXTENSIONS } from '@nodeint/migent-contracts';
import { ConfigurationError, loadWorkspaceConfig, type StageTarget, utcNow } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';

import { sessionEventLog } from './event-log.js';
import { freezeConfigSections, type FrozenSection } from './freeze-config-sections.js';
import type { FrozenExtensions } from './freeze-extensions.js';
import type { PluginFreezeInput } from './freeze-plugins.js';
import { readParsedEvents } from './session-events.js';
import { readExecutions, readSessionManifest } from './session-fold-read.js';
import { canonical } from './session-fold-util.js';
import { sessionLockHeldLocally } from './session-lock.js';

/** The `role_freeze` object of a `plugins.frozen` event. */
export type RoleFreeze = NonNullable<SessionEventRecord<'plugins.frozen'>['data']['role_freeze']>;

/** What the plugin host reads from a role session's freeze, in the shape of a workflow freeze's equivalent fields. */
export interface ReadRoleFreeze {
  readonly role: string;
  readonly config: Record<string, FrozenSection>;
  readonly extensions: FrozenExtensions;
  readonly target: RoleFreeze['target'];
}

const hashOf = (freeze: RoleFreeze): string => createHash('sha256').update(canonical(freeze)).digest('hex');

function lastFrozen(sessionDirectory: string): SessionEventRecord<'plugins.frozen'> | null {
  const events = readParsedEvents(path.join(sessionDirectory, 'events.jsonl')).filter((event) => event.event === 'plugins.frozen');
  const last = events.at(-1);
  return last === undefined ? null : (last.raw as unknown as SessionEventRecord<'plugins.frozen'>);
}

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []);

function recordsOf(extensions: RoleFreeze['extensions']): FrozenExtensions['records'] {
  const records: Record<string, FrozenExtensions['records'][string]> = {};
  for (const [plugin, raw] of Object.entries(extensions)) {
    if (!isRecord(raw) || typeof raw.version !== 'number' || !isRecord(raw.keys)) continue;
    const recorded = raw.keys;
    const pairs = EXTENSION_LEVELS.map((level) => [level, stringList(recorded[level])] as const);
    const keys = Object.fromEntries(pairs) as Record<ExtensionLevel, string[]>;
    records[plugin] = { version: raw.version, keys };
  }
  return records;
}

function groupsOf(value: unknown): Record<string, Record<string, unknown>> {
  const groups: Record<string, Record<string, unknown>> = {};
  if (!isRecord(value)) return groups;
  for (const [owner, keys] of Object.entries(value)) {
    if (isRecord(keys)) groups[owner] = { ...keys };
  }
  return groups;
}

/**
 * The role freeze of a role session, or null when the session recorded none (a workflow session, a legacy role
 * session, or a role session that crashed before its freeze). Throws when the recorded hash does not match.
 */
export function readRoleFreeze(sessionDirectory: string): ReadRoleFreeze | null {
  const frozen = lastFrozen(sessionDirectory);
  const freeze = frozen?.data.role_freeze;
  if (frozen === null || freeze === undefined) return null;
  if (hashOf(freeze) !== frozen.data.freeze_hash) {
    throw new ConfigurationError(`The role freeze of session ${path.basename(path.resolve(sessionDirectory))} does not match its recorded hash.`, { code: 'plugins-freeze-mismatch' });
  }
  const role = readSessionManifest(sessionDirectory).role ?? '';
  const { target } = freeze;
  return {
    role,
    config: {
      plugins: { kind: 'per_entry', entries: { ...freeze.plugins.entries }, liveEntries: [...freeze.plugins.live_entries].sort() },
    },
    extensions: {
      records: recordsOf(freeze.extensions),
      targets: { [role]: groupsOf(target.extensions) },
      roles: { [role]: groupsOf(target.role_extensions) },
    },
    target,
  };
}

function extensionRecords(catalog: ExtensionCatalog, target: StageTarget): Record<string, unknown> {
  return Object.fromEntries(catalog.map((entry) => [entry.plugin, {
    version: entry.version,
    keys: {
      workflow: [],
      stage: [],
      agent: Object.keys(target.extensions?.[entry.plugin] ?? {}),
      role: Object.keys(target.roleExtensions?.[entry.plugin] ?? {}),
    },
  }]));
}

/** What `ensureRoleFreeze` needs from its caller: the host's freeze input and the role's resolved target. */
export interface RoleFreezeSource {
  readonly plugins: PluginFreezeInput;
  readonly target: StageTarget;
  readonly extensions?: ExtensionCatalog;
}

function buildRoleFreeze(
  workspace: string,
  source: RoleFreezeSource,
): { freeze: RoleFreeze; snapshot: SessionEventRecord<'plugins.frozen'>['data']['plugins'] } {
  const { plugins, target, extensions: catalog = PLUGIN_EXTENSIONS } = source;
  const loaded = loadWorkspaceConfig(workspace);
  const config = plugins.withDefaults?.(loaded) ?? loaded;
  const snapshot = Object.hasOwn(config, 'plugins') ? [...plugins.snapshot(config)] : [];
  const section = freezeConfigSections(config, { plugins: plugins.classify })?.plugins;
  const sectionValue = isRecord(section) ? section : undefined;
  const freeze: RoleFreeze = {
    plugins: { entries: groupsOf(sectionValue?.entries), live_entries: stringList(sectionValue?.live_entries) },
    target: {
      client: target.client,
      model: target.model,
      ...(target.extensions === undefined ? {} : { extensions: target.extensions }),
      ...(target.roleExtensions === undefined ? {} : { role_extensions: target.roleExtensions }),
    },
    extensions: extensionRecords(catalog, target),
  };
  return { freeze, snapshot };
}

/**
 * Records the role freeze of an agent session before its first execution. The caller holds the session lock.
 * It does nothing when the session already has a role freeze, or when it has an execution but no freeze (a legacy
 * role session). It is idempotent: the freeze is one appended event, so a crash leaves either all of it or none.
 * Returns whether it recorded one.
 */
export function ensureRoleFreeze(workspace: string, sessionId: string, source: RoleFreezeSource): boolean {
  const sessionDirectory = path.join(workspace, '.migent', 'sessions', sessionId);
  if (!sessionLockHeldLocally(sessionDirectory)) throw new Error(`Session ${sessionId} is not locked by this process.`);
  if (lastFrozen(sessionDirectory)?.data.role_freeze !== undefined) return false;
  if (readExecutions(sessionDirectory).length > 0) return false;
  const { freeze, snapshot } = buildRoleFreeze(workspace, source);
  sessionEventLog.record(sessionDirectory, {
    event: 'plugins.frozen',
    timestamp: utcNow(),
    data: { freeze_hash: hashOf(freeze), plugins: snapshot, role_freeze: freeze },
  });
  sessionEventLog.commit(workspace, sessionDirectory);
  return true;
}
