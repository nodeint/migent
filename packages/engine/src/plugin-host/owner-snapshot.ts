import { existsSync, readdirSync } from 'node:fs';

import type { PluginHookInput, PluginSessionSnapshot } from '@nodeint/migent-contracts';
import type { ExecutionSnapshot } from '@nodeint/migent-kernel';
/**
 * The snapshot as one plugin may read it. Each execution row keeps only the caller's own response extension, as
 * `responseExtension`; the stored map of every plugin's payloads is dropped, and the field is absent when the caller
 * has no payload. Only what the plugin is given changes, so freshness evidence is unaffected.
 */
export function snapshotForPlugin(snapshot: PluginSessionSnapshot, pluginId: string): PluginSessionSnapshot {
  return {
    ...snapshot,
    executions: snapshot.executions.map((row) => {
      const { responseExtensions, ...rest } = row;
      const own = (responseExtensions as Readonly<Record<string, unknown>> | undefined)?.[pluginId];
      return own === undefined ? rest : { ...rest, responseExtension: own };
    }),
  };
}

/** `PluginHookInput.execution` for `execution.finished`: the caller's own payload, or `null`. */
export function finishedExecutionInput(source: {
  executionId: string;
  stageId: string | null;
  pluginId: string;
  snapshot: ExecutionSnapshot | undefined;
}): NonNullable<PluginHookInput['execution']> {
  const { executionId, stageId, pluginId, snapshot } = source;
  const artifacts = snapshot !== undefined && existsSync(snapshot.artifactDirectory)
    ? readdirSync(snapshot.artifactDirectory).sort()
    : [];
  const outcome = snapshot === undefined
    ? null
    : { status: snapshot.outcomeStatus, decision: snapshot.outcomeDecision, execution_status: snapshot.status };
  return {
    id: executionId, stage_id: stageId, outcome, artifacts,
    response_extension: snapshot?.responseExtensions?.[pluginId] ?? null,
  };
}
