import path from 'node:path';

import type { PluginRegistry } from '@nodeint/migent-contracts';
import type { ClientRegistry } from '@nodeint/migent-kernel';
import { ConfigurationError } from '@nodeint/migent-kernel';
import { type ManualCompletionResult, requireSessionDirectory, SessionLock, SessionLockHeldError, SessionStore } from '@nodeint/migent-session';

import { withPluginScope } from './plugin-host/scope.js';
import { NO_PLUGINS, selectPlugins } from './plugin-host/selection.js';

export interface ManualCompletionOutcome {
  readonly result: ManualCompletionResult;
  /** Why plugins did not run, when plugin selection failed and the session was completed without them. */
  readonly pluginWarning: string | null;
}

/**
 * Completes a stopped workflow session by hand, inside a plugin scope so the `session.completed` plugins run
 * before the lock is released. A plugin selection failure never blocks the completion: the session is completed
 * without plugins and the cause is returned as a warning.
 */
export async function completeSessionManually(
  workspace: string,
  sessionId: string,
  services: { readonly pluginRegistry: PluginRegistry; readonly clients: ClientRegistry },
): Promise<ManualCompletionOutcome> {
  const store = new SessionStore(workspace);
  const directory = requireSessionDirectory(path.join(workspace, '.migent', 'sessions'), sessionId);
  const lock = SessionLock.tryAcquire(directory);
  if (lock === null) {
    throw new SessionLockHeldError(
      `Session ${sessionId} is being run by another process. Stop it first with: migent session cancel ${sessionId}`,
    );
  }
  try {
    let selection = NO_PLUGINS;
    let pluginWarning: string | null = null;
    try {
      selection = selectPlugins(workspace, path.resolve(directory), {
        registry: services.pluginRegistry, clients: services.clients, enforceExtensions: false,
      });
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      pluginWarning = error.message;
    }
    const result = await withPluginScope(
      { workspace, sessionId },
      { selection, plugins: services.pluginRegistry, clients: services.clients },
      () => Promise.resolve(store.completeManuallyHeld(sessionId)),
    );
    return { result, pluginWarning };
  } finally {
    lock.release();
  }
}
