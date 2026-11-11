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
  if (!isDirectory(sessionDirectory)) {
    selection.problems.push(`Session not found: ${sessionId}.`);
    return selection;
  }
  const manifestPath = path.join(sessionDirectory, 'manifest.yaml');
  if (!isFile(manifestPath)) {
    selection.problems.push(`Session manifest is missing: ${display(workspace, manifestPath)}.`);
    return selection;
  }
  let manifest;
  try {
    manifest = readSessionManifest(sessionDirectory);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    selection.problems.push(error.message);
    return selection;
  }
  selection.workflowPath = manifest.workflowPath;
  selection.manifestWorkflowId = manifest.workflowId;
  if (manifest.workflowId === 'agent' || manifest.role !== null) {
    selection.problems.push(`Session ${sessionId} is a role session; it has no workflow to validate.`);
    return selection;
  }

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
    selection.source = source;
    try {
      const freeze = readWorkflowFreeze(sessionDirectory);
      if (freeze === null) {
        selection.problems.push(`Workflow freeze is not a file: ${source.path}.`);
        return selection;
      }
      selection.freeze = freeze;
      selection.document = freeze.workflow;
      source.workflowId = freeze.workflow.id;
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      selection.problems.push(error.message);
    }
    return selection;
  }

  const draftPath = `.migent/sessions/${sessionId}/workflow.yaml`;
  const recorded = manifest.workflowPath;
  if (!recorded && !manifest.workflowId) {
    selection.problems.push(
      `Session manifest names no workflow: ${display(workspace, manifestPath)} has no workflow_id or workflow_path.`,
    );
    return selection;
  }
  const kind: SessionWorkflowKind = recorded === draftPath ? 'draft' : 'live';
  const filePath = recorded ? (path.isAbsolute(recorded) ? recorded : path.join(workspace, recorded)) : null;
  if (filePath !== null && (kind === 'draft' || isFile(filePath))) {
    selection.source = { sessionId, workflowId: manifest.workflowId, kind, path: display(workspace, filePath) };
    try {
      selection.document = loadSessionFile(filePath);
    } catch (error) {
      selection.problems.push(authoringMessage(error));
      return selection;
    }
  } else {
    // The recorded file is gone or unrecorded: the runtime then looks the workflow up by id.
    if (!manifest.workflowId) {
      selection.problems.push(`Workflow file is missing: ${recorded ?? ''}.`);
      return selection;
    }
    if (recorded) selection.warnings.push(`Recorded workflow file ${recorded} is missing; using workflow ${manifest.workflowId} by id.`);
    selection.source = { sessionId, workflowId: manifest.workflowId, kind: 'live', path: `.migent/workflows (${manifest.workflowId})` };
    try {
      selection.document = loadNamedWorkflow(workspace, manifest.workflowId, { quiet: true });
    } catch (error) {
      selection.problems.push(authoringMessage(error));
      return selection;
    }
    if (selection.document.source !== null) selection.source.path = display(workspace, selection.document.source);
  }
  const {document} = selection;
  if (document === null) return selection;
  selection.source!.workflowId = document.id;
  if (kind === 'draft' && manifest.workflowId && document.id !== manifest.workflowId) {
    selection.problems.push(
      `Session workflow id is ${document.id}, not ${manifest.workflowId}. Do not change id in workflow.yaml.`,
    );
  }
  return selection;
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
