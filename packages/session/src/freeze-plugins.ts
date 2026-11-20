import type { EntryClassifier, SessionEventRecord } from '@nodeint/migent-contracts';
import { utcNow } from '@nodeint/migent-kernel';

import { sessionEventLog } from './event-log.js';

/** What `plugins.frozen` lists: every pinned entry and every advisory entry, as plain data. */
export type PluginsFrozenEntries = SessionEventRecord<'plugins.frozen'>['data']['plugins'];

/**
 * What a freeze write needs from the plugin host, supplied as plain functions so session never imports the
 * host or the plugins: the classifier of the `plugins` section, and the validation that yields the snapshot.
 */
export interface PluginFreezeInput {
  readonly classify: EntryClassifier;
  /**
   * Adds the entries the config does not name but that run by default (design D1, D4), so the freeze pins them.
   * Returns the config unchanged when there are none.
   */
  readonly withDefaults?: (config: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Validates the merged config's plugin entries, and the workflow's inline agents and stage keys when given,
   * and returns the snapshot. Throws a `ConfigurationError`.
   */
  readonly snapshot: (config: Record<string, unknown>, workflow?: Record<string, unknown>) => PluginsFrozenEntries;
}

/**
 * Records `plugins.frozen` for a freeze that was just written, bound to its hash. The caller holds the session
 * lock and owns the commit. Does nothing when the freeze carried no plugin snapshot.
 */
export function recordPluginsFrozen(
  sessionDirectory: string,
  written: { readonly hash: string; readonly plugins?: PluginsFrozenEntries },
): void {
  if (written.plugins === undefined) return;
  sessionEventLog.record(sessionDirectory, {
    event: 'plugins.frozen',
    timestamp: utcNow(),
    data: { freeze_hash: written.hash, plugins: [...written.plugins] },
  });
}
