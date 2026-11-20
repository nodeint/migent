import type { PluginExecutionRow, PluginSessionSnapshot } from '@nodeint/migent-contracts';

/** One entry of `recommendations.json`. */
interface Recommendation {
  stage_id: string;
  execution_id: string;
  workflow: string | null;
  reason: string;
  warning?: string;
}

export interface RecommendationDocument {
  schema_version: 1;
  recommendations: Recommendation[];
}

interface Payload {
  workflow: string | null;
  reason: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isPayload(value: unknown): value is Payload {
  return isRecord(value) && (value.workflow === null || typeof value.workflow === 'string') && typeof value.reason === 'string';
}

function rowsOf(snapshot: PluginSessionSnapshot): PluginExecutionRow[] {
  return snapshot.executions as unknown as PluginExecutionRow[];
}

/** Whether any execution of the session has ever carried a payload. */
export function hasPayload(snapshot: PluginSessionSnapshot): boolean {
  return rowsOf(snapshot).some((row) => row.responseExtension !== undefined);
}

/** The workflow ids of the frozen `downstream`; empty when it is absent. */
export function downstreamIds(snapshot: PluginSessionSnapshot): string[] {
  const list = snapshot.workflow?.downstream;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown) => (isRecord(entry) && typeof entry.workflow === 'string' ? [entry.workflow] : []));
}

/**
 * One entry per stage whose latest completed execution carries a payload, in execution order. An older completed
 * execution's payload never stands in for a missing one. Values are copied unchanged; `warning` marks a
 * non-null workflow that is not in the frozen `downstream`.
 */
export function buildRecommendations(snapshot: PluginSessionSnapshot): RecommendationDocument {
  const known = new Set(downstreamIds(snapshot));
  const latest = new Map<string, { row: PluginExecutionRow; position: number }>();
  for (const [index, row] of rowsOf(snapshot).entries()) {
    if (row.outcomeStatus !== 'complete') continue;
    const position = row.order ?? index;
    const current = latest.get(row.stageId);
    if (current === undefined || position >= current.position) latest.set(row.stageId, { row, position });
  }
  const recommendations = [...latest.values()]
    .sort((left, right) => left.position - right.position)
    .flatMap(({ row }): Recommendation[] => {
      if (!isPayload(row.responseExtension)) return [];
      const { workflow, reason } = row.responseExtension;
      const entry: Recommendation = { stage_id: row.stageId, execution_id: row.id, workflow, reason };
      if (workflow !== null && !known.has(workflow)) entry.warning = `${workflow} is not in downstream`;
      return [entry];
    });
  return { schema_version: 1, recommendations };
}
