import type { PluginRegistry } from '@nodeint/migent-contracts';
import type { ClientRegistry } from '@nodeint/migent-kernel';

import { logHostProblem, PluginHost } from './dispatch.js';
import type { PluginSelection } from './selection.js';

/**
 * Runs `action` with a started, activated plugin host, for any caller that holds the session lock. The host
 * drains and closes before this returns, so every invocation settles before the caller releases the lock. A host
 * error from the final drain is thrown when the action succeeded, and logged when the action itself failed.
 */
export async function withPluginScope<T>(
  session: { readonly workspace: string; readonly sessionId: string },
  services: {
    readonly selection: PluginSelection;
    readonly plugins: PluginRegistry;
    readonly clients: ClientRegistry | null;
  },
  action: (host: PluginHost) => Promise<T>,
): Promise<T> {
  const host = new PluginHost(session, services.selection, services);
  host.start();
  let result: T;
  try {
    await host.ready();
    result = await action(host);
  } catch (error) {
    // The action's own failure wins; the drain still runs so the lock is not released under a live invocation.
    await host.close().catch(logHostProblem);
    throw error;
  }
  // A host error (a failed record or commit after an artifact write) must reach the caller.
  await host.close();
  return result;
}
