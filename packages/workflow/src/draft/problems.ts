import path from 'node:path';

import { z } from 'zod';

import type { WorkflowCatalogEntry } from '../catalog.js';
import type { UnknownKey } from '../diagnostics.js';
import { workflowErrorPath, workflowRuleCode } from '../diagnostics.js';
import { ConfigurationError } from '../errors.js';
import type { RoleStageSpec, RunWhen, StageAgent, StageSpec, WorkflowDocument, WorkflowRequires } from '../model.js';

/* ------------------------------------------------------------------------------------------------
 * Collecting draft parse
 *
 * The authoring path reports every independent problem instead of stopping at the first. The rules
 * are shared with `parseWorkflowMapping`: each field is read by the same helper, but a failure is
 * recorded and the next field is read. The full `WorkflowDocument` is still built by
 * `parseWorkflowMapping`, so runtime parsing and its messages are unchanged.
 * ---------------------------------------------------------------------------------------------- */

/** One problem found while collecting a workflow draft. `path` uses author coordinates. */
export interface DraftProblem {
  code: string;
  message: string;
  path?: (string | number)[];
}

/** One leaf value: written, omitted (its default applies), or unreadable. */
export type DraftUnit<T> =
  | { state: 'valid'; value: T }
  | { state: 'absent'; value: T }
  | { state: 'invalid' };

/** One stage as far as the draft could be read. `spec` is set when every field parsed. */
export interface DraftStage {
  index: number;
  id: string;
  kind: 'role' | 'verify' | null;
  role: DraftUnit<string>;
  options: DraftUnit<Record<string, string>>;
  dependsOn: DraftUnit<string[]>;
  verify: DraftUnit<string[]>;
  maxRevisions: DraftUnit<number | null>;
  maxVerify: DraftUnit<number>;
  verifyTimeoutSec: DraftUnit<number | null>;
  artifact: DraftUnit<string | null>;
  resumeFrom: DraftUnit<string | null>;
  runWhen: DraftUnit<RunWhen | null>;
  routes: DraftUnit<Record<string, string | string[]>>;
  /** The stage's agent selection: empty for schema <=4 when `model` is absent. */
  agent: DraftUnit<StageAgent | null>;
  spec: StageSpec | null;
  /** A role spec that config resolution can read when role, agent and options are readable. */
  roleStage: RoleStageSpec | null;
}

export interface DraftDownstreamEntry {
  index: number;
  workflow: DraftUnit<string>;
}

/** The result of collecting a workflow draft. Nothing here changes runtime parsing. */
export interface WorkflowDraftParse {
  problems: DraftProblem[];
  /** The full document, set only when nothing is incomplete. */
  document: WorkflowDocument | null;
  id: DraftUnit<string>;
  schemaVersion: number;
  stagesDeclared: boolean;
  declaredStageIds: Set<string>;
  stages: DraftStage[];
  requires: DraftUnit<WorkflowRequires | null>;
  downstream: DraftDownstreamEntry[];
  outputNames: Set<string>;
  /** True when every output entry parsed. */
  outputsComplete: boolean;
  unknownKeys: UnknownKey[];
  catalogEntry: WorkflowCatalogEntry;
}

export class DraftProblems {
  readonly items: DraftProblem[] = [];

  add(error: unknown, fallbackPath?: readonly (string | number)[]): void {
    if (error instanceof z.ZodError) {
      this.items.push({
        code: 'invalid-value',
        message: error.issues.map((issue) => issue.message).join('; '),
        ...(fallbackPath === undefined ? {} : { path: [...fallbackPath] }),
      });
      return;
    }
    if (!(error instanceof ConfigurationError)) throw error;
    const path = error.path ?? fallbackPath;
    this.items.push({
      code: error.code ?? workflowRuleCode(error.message),
      message: error.message,
      ...(path === undefined ? {} : { path: [...path] }),
    });
  }

  addMessage(code: string, message: string, path: readonly (string | number)[]): void {
    this.items.push({ code, message, path: [...path] });
  }
}

export function draftUnit<T>(
  read: () => T,
  problems: DraftProblems,
  fallbackPath?: readonly (string | number)[],
): DraftUnit<T> {
  try {
    return { state: 'valid', value: read() };
  } catch (error) {
    problems.add(error, fallbackPath);
    return { state: 'invalid' };
  }
}

/** Placeholder stages for route parsing: only membership is read, never a field. */
export function declaredStagePlaceholders(ids: Iterable<string>): Record<string, StageSpec> {
  const stages = Object.create(null) as Record<string, StageSpec>;
  for (const id of ids) stages[id] = null as unknown as StageSpec;
  return stages;
}

/** Author-coordinate path for a message raised after the per-stage reads. */
export function draftPathFor(message: string, data: Record<string, unknown>): (string | number)[] {
  return workflowErrorPath(message, data) ?? ['stages'];
}
