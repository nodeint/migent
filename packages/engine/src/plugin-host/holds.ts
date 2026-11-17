import path from 'node:path';

import type { PLUGIN_FAILURE_REASONS, PLUGIN_ON_ERROR } from '@nodeint/migent-contracts';
import { utcNow } from '@nodeint/migent-kernel';
import { PLUGIN_HOLD_RESOLUTION, readParsedEvents, sessionEventLog, unresolvedPluginHolds } from '@nodeint/migent-session';
import { isRecord } from '@nodeint/migent-workflow';

/** One recorded plugin failure. The core records it under the session lock. */
export interface PluginFailure {
  readonly plugin: string;
  readonly hook: string | null;
  readonly invocationId: string | null;
  readonly reason: (typeof PLUGIN_FAILURE_REASONS)[number];
  readonly error: string | null;
  readonly onError: (typeof PLUGIN_ON_ERROR)[number];
}

const sessionDirectoryOf = (workspace: string, sessionId: string): string =>
  path.join(workspace, '.migent', 'sessions', sessionId);

/**
 * Records `plugin.failed` and commits it, so `status.json` shows the hold before the next dispatch. A `stop` or
 * `fail` failure is a hold; an `ignore` failure is recorded and never folds. Internal to the host: the caller
 * holds the session lock.
 */
export function recordPluginFailure(workspace: string, sessionId: string, failure: PluginFailure): void {
  const directory = sessionDirectoryOf(workspace, sessionId);
  sessionEventLog.record(directory, {
    event: 'plugin.failed',
    timestamp: utcNow(),
    data: {
      plugin: failure.plugin,
      invocation_id: failure.invocationId,
      ...(failure.hook === null ? {} : { hook: failure.hook }),
      reason: failure.reason,
      error: failure.error,
      on_error: failure.onError,
    },
  });
  sessionEventLog.commit(workspace, directory);
}

/** Whether `status.json` lists an unresolved plugin hold. The scheduler dispatches nothing new while it does. */
export function holdsPending(status: Readonly<Record<string, unknown>>): boolean {
  return Array.isArray(status.plugin_holds) && status.plugin_holds.some(isRecord);
}

/**
 * Resolves every unresolved hold with `session.active` (`from: 'plugin_hold'`), under the lock and before any
 * dispatch. Returns whether it recorded a resolution.
 */
export function resolvePluginHolds(workspace: string, sessionId: string): boolean {
  const directory = sessionDirectoryOf(workspace, sessionId);
  if (unresolvedPluginHolds(readParsedEvents(path.join(directory, 'events.jsonl'))).length === 0) return false;
  sessionEventLog.record(directory, {
    event: 'session.active',
    timestamp: utcNow(),
    data: { from: PLUGIN_HOLD_RESOLUTION },
  });
  sessionEventLog.commit(workspace, directory);
  return true;
}
