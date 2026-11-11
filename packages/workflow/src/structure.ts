import {
  isValid,
  schemaIssues,
  type TSchema,
  WorkflowDecisionEntry,
  WorkflowDecisionItem,
  WorkflowDecisionList,
  WorkflowDocumentInput,
  WorkflowDownstream,
  WorkflowRunWhen,
  WorkflowStage,
} from '@nodeint/migent-contracts';

import { ConfigurationError } from './errors.js';

/**
 * Translates the workflow contract in `@nodeint/migent-contracts` into Migent errors. The contract
 * decides whether a node has the right structural type; this module owns the message. Both the strict
 * reader and the draft collector read fields through these helpers, so they cannot drift.
 *
 * Only the node's type is judged here. Value rules the contract does not express (one-line text,
 * ranges, id syntax, globs) and every cross-node rule stay in `workflow.ts`.
 */

/** Stage keys, derived from the contract. */
export const STAGE_FIELD_SCHEMAS = WorkflowStage.properties;
export const DOCUMENT_FIELD_SCHEMAS = WorkflowDocumentInput.properties;
export const RUN_WHEN_KEYS: readonly string[] = Object.keys(WorkflowRunWhen.properties);
export const DOWNSTREAM_KEYS: readonly string[] = Object.keys(WorkflowDownstream.properties);

const typeIssue = (schema: TSchema, value: unknown): string | null =>
  schemaIssues(schema, value).find((issue) => issue.path.length === 0 && issue.keyword === 'type')?.message ?? null;

/** `must be a list.` / `must be a mapping.` for a node of the wrong container type; null when it is fine. */
export function containerError(schema: TSchema, value: unknown, field: string): ConfigurationError | null {
  if ((value === null || value === undefined) || isValid(schema, value)) return null;
  const problem = typeIssue(schema, value);
  if (problem === 'must be array') return new ConfigurationError(`${field} must be a list.`);
  if (problem === 'must be object') return new ConfigurationError(`${field} must be a mapping.`);
  return null;
}

/** Throws when an optional node is present with the wrong container type. */
export function requireContainer(schema: TSchema, value: unknown, field: string): void {
  const error = containerError(schema, value, field);
  if (error !== null) throw error;
}

/**
 * Throws `message` when `value` does not satisfy `schema`. The contract decides validity; the caller
 * supplies the wording and the code/path Migent reports for that field.
 */
export function requireValid(schema: TSchema, value: unknown, message: string): void {
  if (!isValid(schema, value)) throw new ConfigurationError(message);
}

/** The contract node for one stage field. */
export const stageField = (key: keyof typeof WorkflowStage.properties): TSchema => WorkflowStage.properties[key];

// ---- decision shape: the contract decides, the readers word the error --------------------------

/** The `decision` value is not a non-empty list. */
export const decisionListProblem = (raw: unknown): boolean =>
  schemaIssues(WorkflowDecisionList, raw).some((issue) => issue.path.length === 0);

/** One list item is not a mapping with exactly one decision. */
export const decisionEntryProblem = (entry: unknown): boolean =>
  schemaIssues(WorkflowDecisionItem, entry).some((issue) => issue.path.length === 0);

export type DecisionBodyProblem =
  | { kind: 'body' }
  | { kind: 'key'; key: string }
  | { kind: 'when' }
  | { kind: 'navigate' };

/**
 * Problems of one decision body, in reading order: a body that is not a mapping stops the rest, then
 * unknown keys (`artifacts` only from schema_version 7), `when`, and a missing `navigate`. A present
 * but malformed `navigate` is left to route resolution.
 */
export function decisionBodyProblems(body: unknown, version7: boolean): DecisionBodyProblem[] {
  const issues = schemaIssues(WorkflowDecisionEntry, body);
  if (issues.some((issue) => issue.path.length === 0 && issue.keyword === 'type')) return [{ kind: 'body' }];
  const record = body as Record<string, unknown>;
  const problems: DecisionBodyProblem[] = [];
  for (const key of Object.keys(record)) {
    const unknown = issues.some((issue) => issue.keyword === 'boolean' && issue.path.length === 1 && issue.path[0] === key);
    if (unknown || (key === 'artifacts' && !version7)) problems.push({ kind: 'key', key });
  }
  if (issues.some((issue) => issue.path[0] === 'when')) problems.push({ kind: 'when' });
  if ((record.navigate === null || record.navigate === undefined)) problems.push({ kind: 'navigate' });
  return problems;
}

// ---- stage mapping, run_when and downstream: the contract decides ------------------------------

/** A stage list item that is not a mapping. */
export const stageMappingProblem = (raw: unknown): boolean =>
  schemaIssues(WorkflowStage, raw).some((issue) => issue.path.length === 0 && issue.keyword === 'type');

/** `run_when.changed_paths` is absent (or null), which the contract requires. */
export const runWhenPathsMissing = (runWhen: Record<string, unknown>, key: string): boolean => {
  const { [key]: paths, ...rest } = runWhen;
  return (paths === null || paths === undefined) && schemaIssues(WorkflowRunWhen, rest).some((issue) => issue.path.length === 0 && issue.keyword === 'required');
};

export type DownstreamProblem =
  | { kind: 'entry' }
  | { kind: 'key'; key: string }
  | { kind: 'workflow' }
  | { kind: 'task-missing' }
  | { kind: 'task-line' }
  | { kind: 'artifacts' };

/**
 * Structural problems of one downstream entry in reading order. Id syntax, uniqueness and outputs
 * stay with the readers.
 */
export function downstreamProblems(entry: unknown): DownstreamProblem[] {
  const issues = schemaIssues(WorkflowDownstream, entry);
  if (issues.some((issue) => issue.path.length === 0 && issue.keyword === 'type')) return [{ kind: 'entry' }];
  const record = entry as Record<string, unknown>;
  const problems: DownstreamProblem[] = [];
  for (const key of Object.keys(record)) {
    if (issues.some((issue) => issue.keyword === 'boolean' && issue.path.length === 1 && issue.path[0] === key)) problems.push({ kind: 'key', key });
  }
  const missing = (name: string): boolean =>
    issues.some((issue) => issue.keyword === 'required' && issue.path.length === 0 && JSON.stringify(issue.params).includes(`"${name}"`));
  if (missing('workflow') || issues.some((issue) => issue.path[0] === 'workflow')) problems.push({ kind: 'workflow' });
  if (missing('task') || issues.some((issue) => issue.path[0] === 'task')) {
    problems.push(typeof record.task === 'string' && record.task.trim() !== '' ? { kind: 'task-line' } : { kind: 'task-missing' });
  }
  if (issues.some((issue) => issue.path[0] === 'artifacts' && issue.path.length === 1)) problems.push({ kind: 'artifacts' });
  return problems;
}

/** The `downstream` value is not a list. */
export const downstreamListProblem = (raw: unknown): boolean =>
  schemaIssues(DOCUMENT_FIELD_SCHEMAS.downstream, raw).some((issue) => issue.path.length === 0 && issue.keyword === 'type');

/** A downstream artifact source that is not a non-blank string. */
export const downstreamArtifactSourceProblem = (source: unknown): boolean =>
  !isValid(WorkflowDownstream, { workflow: 'w', task: 't', artifacts: { a: source } });
