import { existsSync, readdirSync,readFileSync } from 'node:fs';
import path from 'node:path';

import { EXECUTIONS_DIRNAME, MIGENT_DIRNAME,SESSIONS_DIRNAME } from '@nodeint/migent-kernel';

const DIAGNOSTICS_FILE = 'diagnostics.json';

function readObject(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Path of the latest recorded diagnostics of a session, relative to the session directory. */
export function latestDiagnosticsPath(workspace: string, sessionId: string): string | null {
  return latestDiagnosticsPathIn(path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME, sessionId));
}

/** Same, from a session directory. */
export function latestDiagnosticsPathIn(sessionDirectory: string): string | null {
  const last = latestPerStageIn(sessionDirectory).sort((a, b) => b.order - a.order)[0];
  return last ? last.relative : null;
}

function latestPerStage(workspace: string, sessionId: string) {
  return latestPerStageIn(path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME, sessionId));
}

function latestPerStageIn(sessionDirectory: string) {
  const root = path.join(sessionDirectory, EXECUTIONS_DIRNAME);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const byStage = new Map<string, { order: number; file: string; relative: string; data: Record<string, unknown> }>();
  for (const name of names) {
    const file = path.join(root, name, DIAGNOSTICS_FILE);
    if (!existsSync(file)) continue;
    const data = readObject(file);
    if (data === null) continue;
    const metadata = readObject(path.join(root, name, 'execution.json')) ?? {};
    const stage = typeof metadata.stage_id === 'string' ? metadata.stage_id : name;
    const order = typeof metadata.execution_order === 'number' ? metadata.execution_order : 0;
    const current = byStage.get(stage);
    if (current && current.order > order) continue;
    byStage.set(stage, {
      order,
      file,
      relative: path.posix.join(EXECUTIONS_DIRNAME, name, DIAGNOSTICS_FILE),
      data,
    });
  }
  return [...byStage.values()];
}

/** A recorded provider diagnostics file of one stage. */
export interface RecordedDiagnostics {
  /** Relative to the session directory, with forward slashes. */
  relative: string;
  data: Record<string, unknown>;
}

/** The latest recorded provider diagnostics of each stage of a session. */
export function readRecordedDiagnostics(workspace: string, sessionId: string): RecordedDiagnostics[] {
  return latestPerStage(workspace, sessionId).map(({ relative, data }) => ({ relative, data }));
}
