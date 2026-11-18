import { readFileSync } from 'node:fs';
import path from 'node:path';

import { MIGENT_DIRNAME, SESSIONS_DIRNAME } from '@nodeint/migent-kernel';
import { METRICS_ARTIFACT_NAME, METRICS_PLUGIN_ID } from '@nodeint/migent-plugins';
import { listSessionRows } from '@nodeint/migent-session';
import { isRecord } from '@nodeint/migent-workflow';

/** Name of the file the core sealed in the session root before the metrics plugin existed. */
const LEGACY_ROOT_METRICS_NAME = 'metrics.json';

export type SealedMetricsRead =
  | { state: 'ok'; metrics: Record<string, unknown> }
  | { state: 'missing' }
  | { state: 'corrupt' };

/** Plugin artifact path, then the legacy root path. */
function sealedMetricsPaths(workspace: string, sessionId: string): string[] {
  const sessionDirectory = path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME, sessionId);
  return [
    path.join(sessionDirectory, 'plugins', METRICS_PLUGIN_ID, METRICS_ARTIFACT_NAME),
    path.join(sessionDirectory, LEGACY_ROOT_METRICS_NAME),
  ];
}

function readMetricsFile(filePath: string): SealedMetricsRead {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return { state: 'missing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'corrupt' };
  }
  if (!isRecord(parsed)) return { state: 'corrupt' };
  return { state: 'ok', metrics: parsed };
}

/** The first present file wins; a corrupt plugin file does not fall back to the root file. */
export function readSealedMetrics(workspace: string, sessionId: string): SealedMetricsRead {
  for (const filePath of sealedMetricsPaths(workspace, sessionId)) {
    const read = readMetricsFile(filePath);
    if (read.state !== 'missing') return read;
  }
  return { state: 'missing' };
}

/** Sealed sessions, newest first. Sessions without a usable metrics file are omitted. */
export function listSealedMetrics(
  workspace: string,
  filters: { workflow: string | null; status: string | null; limit: number | null },
): Record<string, unknown>[] {
  const sealed: Record<string, unknown>[] = [];
  for (const row of listSessionRows(workspace)) {
    const read = readSealedMetrics(workspace, row[1] ?? '');
    if (read.state !== 'ok') continue;
    sealed.push(read.metrics);
  }
  let rows = sealed;
  if (filters.workflow !== null) rows = rows.filter((row) => row.workflow_id === filters.workflow);
  if (filters.status !== null) rows = rows.filter((row) => row.status === filters.status);
  if (filters.limit !== null) rows = rows.slice(0, filters.limit);
  return rows;
}
