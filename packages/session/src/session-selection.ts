import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { ConfigurationError } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';
import {
  loadNamedWorkflow,
  parseWorkflowMapping,
  type WorkflowDocument,
} from '@nodeint/migent-workflow';
import { parseYamlDocument } from '@nodeint/migent-workflow';
import { ZodError } from 'zod';

import { readStatusFileState } from './query.js';
import { readSessionManifest } from './session-fold-read.js';
import {
  readWorkflowFreeze,
  WORKFLOW_FREEZE_FILE,
  type WorkflowFreeze,
} from './session-freeze.js';

export type SessionWorkflowKind = 'draft' | 'live' | 'frozen';

export interface SessionSource {
  sessionId: string;
  workflowId: string | null;
  kind: SessionWorkflowKind;
  /** Workspace-relative with forward slashes, or absolute when the file lives outside the workspace. */
  path: string;
}

/** Which workflow a session runs, read without writing anything. */
export interface SessionSelection {
  sessionId: string;
  /** Null when no workflow source could be determined. */
  source: SessionSource | null;
  document: WorkflowDocument | null;
  freeze: WorkflowFreeze | null;
  /** Manifest fields the live-drift comparison needs. */
  workflowPath: string | null;
  manifestWorkflowId: string | null;
  problems: string[];
  warnings: string[];
}

const SESSION_ID_ERROR = (sessionId: string): string => `Invalid session id: ${sessionId}.`;

/** Rejects ids that could leave `.migent/sessions`. The rule matches the one used for `--prior`. */
export function assertSessionId(sessionId: string): void {
  if (!sessionId || sessionId === '.' || sessionId === '..' || /[\\/]/.test(sessionId) || path.isAbsolute(sessionId)) {
    throw new ConfigurationError(SESSION_ID_ERROR(sessionId));
  }
}

type SessionManifestRecord = ReturnType<typeof readSessionManifest>;
type SelectedWorkflow = Pick<SessionSelection, 'source' | 'document' | 'freeze'>;

/** Reads the freeze behind a selected frozen source; a broken freeze is a problem, never a fallback. */
function loadFrozenSelection(
  selection: SessionSelection,
  sessionDirectory: string,
  source: SessionSource,
): SelectedWorkflow {
  const unloaded: SelectedWorkflow = { source, document: null, freeze: null };
  try {
    const freeze = readWorkflowFreeze(sessionDirectory);
    if (freeze === null) {
      selection.problems.push(`Workflow freeze is not a file: ${source.path}.`);
      return unloaded;
    }
    return { source: { ...source, workflowId: freeze.workflow.id }, document: freeze.workflow, freeze };
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    selection.problems.push(error.message);
  }
  return unloaded;
}

/** Selects the session's freeze when the runtime would use it; the selected fields when that settled the selection. */
function selectFrozenWorkflow(
  selection: SessionSelection,
  session: { workspace: string; sessionDirectory: string; manifest: SessionManifestRecord },
): SelectedWorkflow | null {
  const { workspace, sessionDirectory, manifest } = session;
  const { sessionId } = selection;
  // Activation writes the freeze before it records the start, so an interrupted one leaves a stale
  // freeze on a session that is still prepared. Activation would re-read the draft, so check that.
  const status = readStatusFileState(path.join(sessionDirectory, 'status.json'));
  const prepared = status.state === 'ok' && status.status.status === 'prepared';
  const freezePath = path.join(sessionDirectory, WORKFLOW_FREEZE_FILE);
  if (existsSync(freezePath) && prepared) {
    selection.warnings.push(`${display(workspace, freezePath)} is left from an interrupted start and is ignored while the session is prepared.`);
  } else if (existsSync(freezePath)) {
    const source: SessionSource = {
      sessionId,
      workflowId: manifest.workflowId,
      kind: 'frozen',
      path: display(workspace, freezePath),
    };
    return loadFrozenSelection(selection, sessionDirectory, source);
  }
  return null;
}

/** Loads the recorded workflow file; null after recording a problem. */
function selectRecordedFile(
  selection: SessionSelection,
  recorded: { workspace: string; filePath: string; kind: SessionWorkflowKind; manifest: SessionManifestRecord },
): SelectedWorkflow | null {
  const { workspace, filePath, kind, manifest } = recorded;
  const source: SessionSource = {
    sessionId: selection.sessionId, workflowId: manifest.workflowId, kind, path: display(workspace, filePath),
  };
  try {
    return { source, document: loadSessionFile(filePath), freeze: null };
  } catch (error) {
    selection.problems.push(authoringMessage(error));
    return { source, document: null, freeze: null };
  }
}

/** The recorded file is gone or unrecorded: the runtime then looks the workflow up by id. */
function selectWorkflowById(
  selection: SessionSelection,
  missing: { workspace: string; recorded: string | null; manifest: SessionManifestRecord },
): SelectedWorkflow | null {
  const { workspace, recorded, manifest } = missing;
  const { workflowId } = manifest;
  if (!workflowId) {
    selection.problems.push(`Workflow file is missing: ${recorded ?? ''}.`);
    return null;
  }
  if (recorded) selection.warnings.push(`Recorded workflow file ${recorded} is missing; using workflow ${workflowId} by id.`);
  const source: SessionSource = {
    sessionId: selection.sessionId, workflowId, kind: 'live', path: `.migent/workflows (${workflowId})`,
  };
  let document: WorkflowDocument;
  try {
    document = loadNamedWorkflow(workspace, workflowId, { quiet: true });
  } catch (error) {
    selection.problems.push(authoringMessage(error));
    return { source, document: null, freeze: null };
  }
  if (document.source !== null) source.path = display(workspace, document.source);
  return { source, document, freeze: null };
}

function resolveRecordedPath(workspace: string, recorded: string): string {
  return path.isAbsolute(recorded) ? recorded : path.join(workspace, recorded);
}

/** Selects the recorded workflow source, or the project workflow by id when the recorded file is gone. */
function selectRecordedWorkflow(
  selection: SessionSelection,
  session: { workspace: string; manifestPath: string; manifest: SessionManifestRecord },
): SelectedWorkflow {
  const { workspace, manifestPath, manifest } = session;
  const { sessionId } = selection;
  const found: SelectedWorkflow = { source: null, document: null, freeze: null };
  const draftPath = `.migent/sessions/${sessionId}/workflow.yaml`;
  const recorded = manifest.workflowPath;
  if (!recorded && !manifest.workflowId) {
    selection.problems.push(
      `Session manifest names no workflow: ${display(workspace, manifestPath)} has no workflow_id or workflow_path.`,
    );
    return found;
  }
  const kind: SessionWorkflowKind = recorded === draftPath ? 'draft' : 'live';
  const filePath = recorded ? resolveRecordedPath(workspace, recorded) : null;
  const selected = filePath !== null && (kind === 'draft' || isFile(filePath))
    ? selectRecordedFile(selection, { workspace, filePath, kind, manifest })
    : selectWorkflowById(selection, { workspace, recorded, manifest });
  if (selected === null) return found;
  Object.assign(found, selected);
  const {document} = found;
  if (document === null || found.source === null) return found;
  found.source.workflowId = document.id;
  if (kind === 'draft' && manifest.workflowId && document.id !== manifest.workflowId) {
    selection.problems.push(
      `Session workflow id is ${document.id}, not ${manifest.workflowId}. Do not change id in workflow.yaml.`,
    );
  }
  return found;
}

/** The session manifest; null after recording why it cannot be read. */
function readSelectionManifest(
  selection: SessionSelection,
  workspace: string,
  sessionDirectory: string,
): SessionManifestRecord | null {
  if (!isDirectory(sessionDirectory)) {
    selection.problems.push(`Session not found: ${selection.sessionId}.`);
    return null;
  }
  const manifestPath = path.join(sessionDirectory, 'manifest.yaml');
  if (!isFile(manifestPath)) {
    selection.problems.push(`Session manifest is missing: ${display(workspace, manifestPath)}.`);
    return null;
  }
  try {
    return readSessionManifest(sessionDirectory);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    selection.problems.push(error.message);
    return null;
  }
}

/**
 * Pick the workflow the runtime would use: a freeze when the file exists (a corrupt one is a
 * problem, never a reason to fall back), otherwise the recorded live source. Throws only for an
 * invalid id; every other failure is returned as a problem.
 */
export function selectSessionWorkflow(workspace: string, sessionId: string): SessionSelection {
  assertSessionId(sessionId);
  const selection: SessionSelection = {
    sessionId,
    source: null,
    document: null,
    freeze: null,
    workflowPath: null,
    manifestWorkflowId: null,
    problems: [],
    warnings: [],
  };
  const sessionDirectory = path.join(workspace, '.migent', 'sessions', sessionId);
  const manifestPath = path.join(sessionDirectory, 'manifest.yaml');
  const manifest = readSelectionManifest(selection, workspace, sessionDirectory);
  if (manifest === null) return selection;
  selection.workflowPath = manifest.workflowPath;
  selection.manifestWorkflowId = manifest.workflowId;
  if (manifest.workflowId === 'agent' || manifest.role !== null) {
    selection.problems.push(`Session ${sessionId} is a role session; it has no workflow to validate.`);
    return selection;
  }

  const frozen = selectFrozenWorkflow(selection, { workspace, sessionDirectory, manifest });
  return Object.assign(selection, frozen ?? selectRecordedWorkflow(selection, { workspace, manifestPath, manifest }));
}

/**
 * The workflow a new session would freeze, read without creating anything. A workflow that
 * cannot be loaded is returned as a problem, so the caller reports it like any other check.
 */
export function selectRunWorkflow(workspace: string, workflowId: string): SessionSelection {
  const selection: SessionSelection = {
    sessionId: '(new)',
    source: null,
    document: null,
    freeze: null,
    workflowPath: null,
    manifestWorkflowId: null,
    problems: [],
    warnings: [],
  };
  try {
    selection.document = loadNamedWorkflow(workspace, workflowId, { quiet: true });
  } catch (error) {
    selection.problems.push(authoringMessage(error));
    return selection;
  }
  const {document} = selection;
  selection.source = {
    sessionId: selection.sessionId,
    workflowId: document.id,
    kind: 'live',
    path: document.source === null ? `.migent/workflows (${document.id})` : display(workspace, document.source),
  };
  return selection;
}

/** Same parsing as `loadWorkflowDocument`, without its stderr warnings, plus the empty-workflow rule. */
function loadSessionFile(filePath: string): WorkflowDocument {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`Unable to read workflow: ${filePath} (${reason})`);
  }
  const data = parseYamlDocument(text);
  if (!isRecord(data)) throw new ConfigurationError(`Workflow must be a mapping: ${filePath}`);
  return parseWorkflowMapping(data, filePath);
}

/** Message of a workflow loading failure; rethrows anything that is not an authoring error. */
export function authoringMessage(error: unknown): string {
  if (error instanceof ConfigurationError) return error.message;
  if (error instanceof ZodError) return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw error;
}

function display(workspace: string, target: string): string {
  const relative = path.relative(workspace, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return target;
  return relative.split(path.sep).join('/');
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}
