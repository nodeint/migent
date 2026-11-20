import path from 'node:path';

import type { StageTarget } from '@nodeint/migent-kernel';
import { ensureRoleFreeze } from '@nodeint/migent-session';

import type { AgentToolRunner } from './agent-runner.js';
import { logHostProblem } from './plugin-host/dispatch.js';
import { pluginFreezeInput } from './plugin-host/freeze.js';
import { withPluginScope } from './plugin-host/scope.js';
import { selectPlugins } from './plugin-host/selection.js';

/**
 * Records the role freeze of an agent session before anything gates or starts an execution. The caller holds the
 * session lock. Idempotent, and a no-op for a session that already has an execution (a legacy role session).
 */
export function ensureRoleSessionFreeze(
  session: { workspace: string; sessionId: string },
  runner: AgentToolRunner,
  target: StageTarget,
): void {
  const { workspace, sessionId } = session;
  ensureRoleFreeze(workspace, sessionId, {
    plugins: pluginFreezeInput(runner.pluginRegistry, runner.registry),
    target,
  });
}

/**
 * Runs a role action inside a plugin scope that selects its plugins from the role freeze. The runner carries the
 * host's interceptors while the action runs, so the resume gate and every turn see them. The caller holds the
 * session lock, and every invocation settles before this returns. `session.started` fires only when `started` is
 * set (the run created the session); `session.stopped` fires after the action, also when it throws.
 */
export async function withRolePluginScope<T>(
  session: { workspace: string; sessionId: string; started?: boolean },
  runner: AgentToolRunner,
  action: () => Promise<T>,
): Promise<T> {
  const { workspace, sessionId, started = false } = session;
  const selection = selectPlugins(workspace, path.join(workspace, '.migent', 'sessions', sessionId), {
    registry: runner.pluginRegistry, clients: runner.registry,
  });
  return withPluginScope(
    { workspace, sessionId },
    { selection, plugins: runner.pluginRegistry, clients: runner.registry },
    async (host) => {
      if (started) host.fireSessionStarted();
      const previous = runner.interceptors;
      Object.assign(runner, { interceptors: host.interceptors() });
      let result: T;
      try {
        result = await action();
      } catch (error) {
        await host.finish({ fireStopped: true }).catch(logHostProblem);
        throw error;
      } finally {
        Object.assign(runner, { interceptors: previous });
      }
      await host.finish({ fireStopped: true });
      return result;
    },
  );
}
