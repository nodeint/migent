import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { ConfigurationError, EXECUTIONS_DIRNAME, isAtomicTempName } from '@nodeint/migent-kernel';
import { isRecord, loadNamedWorkflow, loadWorkflowDocument, parseYamlDocument, type WorkflowDocument } from '@nodeint/migent-workflow';

import { executionClientReader } from './legacy-execution-client.js';
import { readStatusFileState, type StatusFileState } from './query.js';
import { readParsedEvents } from './session-events.js';
import type { FoldExecution, FoldInputs, SessionManifest } from './session-fold-types.js';
import { asInt, identityText, textOr } from './session-fold-util.js';
import { loadFrozenWorkflow } from './session-freeze.js';
import { readTitleRecord } from './session-title.js';

/** One execution.json: null when unreadable, a ConfigurationError when not a JSON object. */
function readExecutionRecord(filePath: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ConfigurationError(`Execution file is corrupt: ${filePath}.`);
  }
  if (!isRecord(parsed)) throw new ConfigurationError(`Execution file is corrupt: ${filePath}.`);
  return parsed;
}

export function readExecutions(sessionDirectory: string): FoldExecution[] {
  const directory = path.join(sessionDirectory, EXECUTIONS_DIRNAME);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const executions: FoldExecution[] = [];
  const clientOf = executionClientReader(sessionDirectory);
  for (const entry of entries) {
    if (!entry.isDirectory() || isAtomicTempName(entry.name)) continue;
    const parsed = readExecutionRecord(path.join(directory, entry.name, 'execution.json'));
    if (parsed === null) continue;
    executions.push(
      executionFromRecord(
        sessionDirectory,
        { executionId: entry.name, metadata: parsed, client: clientOf(entry.name, parsed).client },
      ),
    );
  }
  return executions;
}

export function executionFromRecord(
  sessionDirectory: string,
  record: { executionId: string; metadata: Record<string, unknown>; client: string | null },
): FoldExecution {
  const { executionId, metadata, client } = record;
  const outcome = isRecord(metadata.outcome) ? metadata.outcome : null;
  return {
    executionId,
    executionOrder: asInt(metadata.execution_order),
    stageId: textOr(metadata.stage_id) ?? '',
    stageAttempt: asInt(metadata.stage_attempt),
    client: client === null ? '' : client,
    model: textOr(metadata.model) ?? '',
    resumesExecutionId: textOr(metadata.resumes_execution_id),
    status: textOr(metadata.status) ?? '',
    outcome,
    error: textOr(metadata.error),
    failureReason: textOr(metadata.failure_reason),
    createdAt: textOr(metadata.created_at),
    completedAt: textOr(metadata.completed_at),
    artifactDirectory: path.join(sessionDirectory, EXECUTIONS_DIRNAME, executionId, 'artifacts'),
  };
}

/** Finder, Explorer, and editor backups are not published artifacts. */
export function isIgnoredOutputName(name: string): boolean {
  if (name.startsWith('.') || name.endsWith('~')) return true;
  const lower = name.toLowerCase();
  return lower === 'thumbs.db' || lower === 'desktop.ini';
}

export function listOutputFiles(sessionDirectory: string): string[] {
  const directory = path.join(sessionDirectory, 'outputs');
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || isIgnoredOutputName(entry.name)) continue;
    names.push(entry.name);
  }
  names.sort();
  return names;
}

/** The workflow at the recorded path; null when it is absent, unreadable, or invalid. */
function loadRecordedWorkflowPath(workspace: string, workflowPath: unknown): WorkflowDocument | null {
  if (typeof workflowPath !== 'string' || !workflowPath) return null;
  const filePath = path.isAbsolute(workflowPath) ? workflowPath : path.join(workspace, workflowPath);
  if (!isReadableFile(filePath)) return null;
  try {
    return loadWorkflowDocument(filePath);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return null;
  }
}

export function loadSessionWorkflow(
  workspace: string,
  sessionDirectory: string,
  status: Record<string, unknown>,
): WorkflowDocument | null {
  if (status.workflow_id === 'agent') return null;
  const frozen = loadFrozenWorkflow(sessionDirectory);
  if (frozen) return frozen;
  const fromPath = loadRecordedWorkflowPath(workspace, status.workflow_path);
  if (fromPath !== null) return fromPath;
  const workflowId = status.workflow_id;
  if (typeof workflowId !== 'string' || workflowId === '') return null;
  try {
    return loadNamedWorkflow(workspace, workflowId);
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

export function isReadableFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** A missing schema_version is 1. This is not config documentVersion, which maps a missing version to 0. */
export function sessionSchemaVersion(document: Record<string, unknown> | null): number {
  if (document === null || !Object.hasOwn(document, 'schema_version') || (document.schema_version === null || document.schema_version === undefined)) return 1;
  const raw = document.schema_version;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) return raw;
  if (typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw)) return Number(raw);
  return 1;
}

export function readSessionManifest(sessionDirectory: string): SessionManifest {
  const manifestPath = path.join(sessionDirectory, 'manifest.yaml');
  let text: string;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch {
    return emptyManifest(path.basename(sessionDirectory));
  }
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(text);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`Session manifest is corrupt: ${manifestPath}.`);
  }
  if (!isRecord(parsed)) throw new ConfigurationError(`Session manifest is corrupt: ${manifestPath}.`);
  return {
    sessionId: identityText(parsed.session_id) ?? path.basename(sessionDirectory),
    title: textOr(parsed.title),
    workflowId: textOr(parsed.workflow_id),
    workflowPath: textOr(parsed.workflow_path),
    role: textOr(parsed.role),
    task: textOr(parsed.task),
    createdAt: textOr(parsed.created_at),
    priorSessionId: identityText(parsed.prior_session_id),
    manifestStatus: textOr(parsed.status),
    schemaVersion: sessionSchemaVersion(parsed),
  };
}

export function loadFoldInputs(workspace: string, sessionDirectory: string): FoldInputs {
  const manifest = readSessionManifest(sessionDirectory);
  const previous = readStatusFileState(path.join(sessionDirectory, 'status.json'));
  const previousStatus = previous.state === 'ok' ? previous.status : null;
  const executions = readExecutions(sessionDirectory);
  const identity = statusIdentity(manifest, previousStatus);
  return {
    schemaVersion: manifest.schemaVersion,
    manifest,
    events: readParsedEvents(path.join(sessionDirectory, 'events.jsonl')),
    executions,
    presentExecutionIds: new Set(executions.map((execution) => execution.executionId)),
    previousStatus,
    outputFiles: listOutputFiles(sessionDirectory),
    workflow: loadSessionWorkflow(workspace, sessionDirectory, identity),
    titleRecord: readTitleRecord(sessionDirectory),
  };
}

export function statusFileState(sessionDirectory: string): StatusFileState {
  return readStatusFileState(path.join(sessionDirectory, 'status.json'));
}

export function statusIdentity(
  manifest: SessionManifest,
  previous: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    workflow_id: manifest.workflowId ?? previous?.workflow_id ?? null,
    workflow_path: manifest.workflowPath ?? previous?.workflow_path ?? null,
  };
}

export function emptyManifest(sessionId: string): SessionManifest {
  return {
    sessionId,
    title: null,
    workflowId: null,
    workflowPath: null,
    role: null,
    task: null,
    createdAt: null,
    priorSessionId: null,
    manifestStatus: null,
    schemaVersion: 1,
  };
}
