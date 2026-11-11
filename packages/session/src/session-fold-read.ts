import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { ConfigurationError, EXECUTIONS_DIRNAME, isAtomicTempName } from '@nodeint/migent-kernel';
import { isRecord, loadNamedWorkflow, loadWorkflowDocument, type WorkflowDocument } from '@nodeint/migent-workflow';

import { executionClientReader } from './legacy-execution-client.js';
import type { FoldExecution, } from './session-fold-types.js';
import { asInt, textOr } from './session-fold-util.js';
import { loadFrozenWorkflow } from './session-freeze.js';

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
    const filePath = path.join(directory, entry.name, 'execution.json');
    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ConfigurationError(`Execution file is corrupt: ${filePath}.`);
    }
    if (!isRecord(parsed)) throw new ConfigurationError(`Execution file is corrupt: ${filePath}.`);
    executions.push(executionFromRecord(sessionDirectory, entry.name, parsed, clientOf(entry.name, parsed).client));
  }
  return executions;
}

export function executionFromRecord(
  sessionDirectory: string,
  executionId: string,
  metadata: Record<string, unknown>,
  client: string | null,
): FoldExecution {
  const outcome = isRecord(metadata.outcome) ? metadata.outcome : null;
  return {
    executionId,
    executionOrder: asInt(metadata.execution_order),
    stageId: textOr(metadata.stage_id) ?? '',
    stageAttempt: asInt(metadata.stage_attempt),
    client: client ?? '',
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

export function loadSessionWorkflow(
  workspace: string,
  sessionDirectory: string,
  status: Record<string, unknown>,
): WorkflowDocument | null {
  if (status.workflow_id === 'agent') return null;
  const frozen = loadFrozenWorkflow(sessionDirectory);
  if (frozen) return frozen;
  const workflowPath = status.workflow_path;
  if (typeof workflowPath === 'string' && workflowPath) {
    const filePath = path.isAbsolute(workflowPath) ? workflowPath : path.join(workspace, workflowPath);
    if (isReadableFile(filePath)) {
      try {
        return loadWorkflowDocument(filePath);
      } catch (error) {
        if (!(error instanceof ConfigurationError)) throw error;
      }
    }
  }
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
