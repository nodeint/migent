
import { SCHEMA_V2 } from './constants.js';
import type { WorkflowDocument, WorkflowRequires } from './model.js';

/** A cross-workflow finding. `workflow` is the id it concerns; `files` the declaring files, when known. */
export interface CatalogProblem {
  code: 'duplicate-id' | 'no-stages' | 'unknown-downstream' | 'requires-invalid';
  message: string;
  workflow: string;
  files?: string[];
  /** Author-coordinate path of the node the problem is about, when the rule can name one. */
  path?: (string | number)[];
  /** The problem concerns the external entry passed to `checkWorkflowCatalog`, whatever id it shares. */
  external?: true;
}

/** A catalog fact the draft parser may not have been able to read. */
export type CatalogFact<T> = { known: true; value: T } | { known: false };

/**
 * One workflow as the catalog rules see it. `document` is set when the workflow parsed completely;
 * the draft leaves it null and exposes only the parts it could read. Unknown parts skip the rules
 * that read them, so a broken draft never produces a follow-on catalog finding.
 */
export interface WorkflowCatalogEntry {
  file: string;
  document: WorkflowDocument | null;
  id: CatalogFact<string>;
  stagesDeclared: boolean;
  requires: CatalogFact<WorkflowRequires | null>;
  /** `index` is the entry's position in the author's list, kept when earlier entries were unreadable. */
  downstream: readonly { workflow: CatalogFact<string>; index?: number }[];
}

/** Adapts a parsed document to a fully known catalog entry. */
export function catalogEntryFromDocument(file: string, document: WorkflowDocument): WorkflowCatalogEntry {
  return {
    file,
    document,
    id: { known: true, value: document.id },
    stagesDeclared: Object.keys(document.stages).length > 0,
    requires: { known: true, value: document.requires },
    downstream: (document.downstream ?? []).map((entry) => ({ workflow: { known: true, value: entry.workflow } })),
  };
}

/**
 * The cross-file rules of the catalog: duplicate ids, empty stages, `requires` and `downstream`.
 * Pure; `failedIds` names workflows that could not be parsed. Rules skip the facts an entry does not
 * know, so the results for fully parsed documents are unchanged.
 */
export function checkWorkflowCatalog(
  entries: readonly WorkflowCatalogEntry[],
  failedIds: ReadonlySet<string> = new Set(),
  external: WorkflowCatalogEntry | null = null,
): { documents: Record<string, WorkflowDocument>; problems: CatalogProblem[] } {
  const failed = new Set(failedIds);
  const problems: CatalogProblem[] = [];
  const grouped = new Map<string, WorkflowCatalogEntry[]>();
  for (const entry of entries) {
    if (!entry.id.known) continue;
    const list = grouped.get(entry.id.value);
    if (list === undefined) grouped.set(entry.id.value, [entry]);
    else list.push(entry);
  }
  const documents: Record<string, WorkflowDocument> = {};
  for (const [workflowId, group] of grouped) {
    if (group.length > 1) {
      const files = group.map((entry) => entry.file);
      problems.push({ code: 'duplicate-id', message: `${workflowId}: id is declared by ${files.join(', ')}.`, workflow: workflowId, files });
      failed.add(workflowId);
      continue;
    }
    const [entry] = group;
    if (entry.document !== null) documents[workflowId] = entry.document;
    if (!entry.stagesDeclared) {
      problems.push({ code: 'no-stages', message: `${workflowId}: declares no stages.`, workflow: workflowId });
    }
  }
  for (const [workflowId, group] of grouped) {
    if (group.length > 1) continue;
    checkEntryReferences(group[0], workflowId, { entries, documents, failed, problems, external: false });
  }
  // An external entry (a session draft) is checked against the catalog but is never part of it, so it
  // may share an id with a catalog workflow without a duplicate-id finding.
  if (external !== null) {
    const workflowId = external.id.known ? external.id.value : '';
    if (external.id.known && !external.stagesDeclared) {
      problems.push({ code: 'no-stages', message: `${workflowId}: declares no stages.`, workflow: workflowId, external: true });
    }
    checkEntryReferences(external, workflowId, { entries, documents, failed, problems, external: true });
  }
  return { documents, problems };
}

export interface EntryReferenceContext {
  readonly entries: readonly WorkflowCatalogEntry[];
  readonly documents: Record<string, WorkflowDocument>;
  readonly failed: Set<string>;
  readonly problems: CatalogProblem[];
  readonly external: boolean;
}

export function checkEntryReferences(
  entry: WorkflowCatalogEntry,
  workflowId: string,
  context: EntryReferenceContext,
): void {
  const { entries, documents, failed, problems, external } = context;
  const mark = external ? { external: true as const } : {};
  if (entry.requires.known && entry.requires.value !== null && !isDraftEntry(entries, entry.requires.value.workflow)) {
    for (const message of checkRequires(workflowId, entry.requires.value, { documents, failedIds: failed })) problems.push({ code: 'requires-invalid', message, workflow: workflowId, ...mark });
  }
  for (const [index, next] of entry.downstream.entries()) {
    if (!next.workflow.known) continue;
    if (!Object.hasOwn(documents, next.workflow.value) && !isDraftEntry(entries, next.workflow.value)) {
      problems.push({
        code: 'unknown-downstream',
        message: `${workflowId}: downstream workflow ${next.workflow.value} is not in .migent/workflows.`,
        workflow: workflowId,
        path: ['downstream', next.index ?? index, 'workflow'],
        ...mark,
      });
    }
  }
}

/** True when `workflowId` names an entry the catalog could not fully parse (for example the draft). */
export function isDraftEntry(entries: readonly WorkflowCatalogEntry[], workflowId: string): boolean {
  return entries.some((entry) => entry.document === null && entry.id.known && entry.id.value === workflowId);
}

export function checkRequires(
  workflowId: string,
  requires: WorkflowRequires,
  lookup: { readonly documents: Record<string, WorkflowDocument>; readonly failedIds: Set<string> },
): string[] {
  const { documents, failedIds } = lookup;
  const problems: string[] = [];
  const required = documents[requires.workflow];
  if (required === undefined) {
    if (failedIds.has(requires.workflow)) {
      problems.push(`${workflowId}: requires ${requires.workflow}, which failed to load.`);
    } else {
      problems.push(
        `${workflowId}: requires workflow ${requires.workflow}, which is not in .migent/workflows.`,
      );
    }
    return problems;
  }
  if ((documents[workflowId]?.schemaVersion ?? 1) >= SCHEMA_V2) return problems;
  const decision = required.completion === null ? null : required.completion.decision;
  if (requires.decision === null || decision === null || decision.toLowerCase() !== requires.decision) {
    const actual = decision === null ? 'no decision' : decision;
    problems.push(
      `${workflowId}: requires ${requires.workflow} to complete with ${requires.decision}, but it completes with ${actual}.`,
    );
  }
  return problems;
}
