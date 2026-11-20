import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { type Question,questionBatchSchema } from './questions.js';
import type { AskTarget } from './stage-outcome.js';

const text = z.string().trim().min(1);

/** The handoff document an agent writes under response protocol 3. */
const handoffSchema = z.discriminatedUnion('status', [
  z.object({
    schema_version: z.literal(1), status: z.literal('complete'),
    decision: text.optional(), summary: z.string().optional(),
  }).strict(),
  z.object({ schema_version: z.literal(1), status: z.literal('blocked'), blocker: text }).strict(),
  z.object({ schema_version: z.literal(1), status: z.literal('question'), questions: questionBatchSchema }).strict(),
]);

export type HandoffFileErrorKind =
  'missing' | 'empty' | 'invalid_json' | 'invalid_schema' | 'invalid_decision' | 'question_not_allowed'
  | 'invalid_extension';

/** The handoff file cannot be used. The kind and detail are safe to show to the agent. */
export class HandoffFileError extends Error {
  constructor(
    public readonly kind: HandoffFileErrorKind,
    public readonly detail: string,
    public readonly file: string,
  ) {
    super(`Handoff file ${file} is invalid (${kind}): ${detail}`);
    this.name = 'HandoffFileError';
  }
}

/** One active response extension: a top-level key of the `complete` document, checked against its frozen schema. */
export interface ExtensionRule {
  key: string;
  required: boolean;
  instructions: string;
  check(value: unknown): { path: string; message: string }[];
}

export interface HandoffRules {
  decisionValues: readonly string[];
  ask: AskTarget | null;
  /** Active extensions of the stage. Empty or omitted gives the closed core contract. */
  extensions?: readonly ExtensionRule[];
}

export interface LoadedHandoff {
  status: 'complete' | 'blocked' | 'question';
  blocker: string | null;
  decision: string | null;
  questions: Question[];
  /** Extension payloads as written, by key; empty except on `complete`. */
  extensions: Readonly<Record<string, unknown>>;
}

/** Read the handoff file and run the shape and stage-dependent checks in one pass. */
export function loadHandoffFile(file: string, rules: HandoffRules): LoadedHandoff {
  const active = rules.extensions ?? [];
  const { handoff, present } = readHandoffDocument(file, active);
  if (handoff.status === 'question') {
    if (rules.ask === null) throw new HandoffFileError('question_not_allowed', 'status: question requires a stage with ask: human.', file);
    rejectExtensions(present, file);
    return { status: 'question', blocker: null, decision: null, questions: handoff.questions, extensions: {} };
  }
  if (handoff.status === 'blocked') {
    rejectExtensions(present, file);
    return { status: 'blocked', blocker: handoff.blocker, decision: null, questions: [], extensions: {} };
  }
  const decision = completedDecision(handoff.decision, rules, file);
  const extensions = checkedExtensions(active, present, file);
  return { status: 'complete', blocker: null, decision, questions: [], extensions };
}

/** An extension key is allowed only with `complete`. */
function rejectExtensions(present: Readonly<Record<string, unknown>>, file: string): void {
  const [key] = Object.keys(present);
  if (key !== undefined) throw new HandoffFileError('invalid_extension', `${key}: allowed only with status complete`, file);
}

/** The required and schema checks of every active extension, with all issues of a key joined. */
function checkedExtensions(
  rules: readonly ExtensionRule[],
  present: Readonly<Record<string, unknown>>,
  file: string,
): Record<string, unknown> {
  const checked: Record<string, unknown> = {};
  for (const rule of rules) {
    if (!Object.hasOwn(present, rule.key)) {
      if (rule.required) throw new HandoffFileError('invalid_extension', `${rule.key} is required: ${rule.instructions}`, file);
      continue;
    }
    const issues = rule.check(present[rule.key]);
    if (issues.length > 0) {
      const detail = issues.map((issue) => `${rule.key}${issue.path}: ${issue.message}`).join('; ');
      throw new HandoffFileError('invalid_extension', detail, file);
    }
    checked[rule.key] = present[rule.key];
  }
  return checked;
}

/** Active extension keys come off the document first; any other unknown key stays an invalid_schema error. */
function splitExtensions(
  value: unknown,
  rules: readonly ExtensionRule[],
): { core: unknown; present: Record<string, unknown> } {
  const present: Record<string, unknown> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { core: value, present };
  const core: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const { key } of rules) {
    if (!Object.hasOwn(core, key)) continue;
    present[key] = core[key];
    delete core[key];
  }
  return { core, present };
}

/** Read, parse and shape-check the handoff file, or throw the matching HandoffFileError. */
function readHandoffDocument(file: string, rules: readonly ExtensionRule[]) {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch (error) {
    const {code} = (error as { code?: unknown });
    throw new HandoffFileError('missing', code === 'ENOENT' ? 'the file was not written' : `the file cannot be read (${String(code ?? error)})`, file);
  }
  if (content.trim() === '') throw new HandoffFileError('empty', 'the file has no content', file);
  let value: unknown;
  try {
    value = JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new HandoffFileError('invalid_json', error instanceof Error ? error.message : String(error), file);
  }
  const { core, present } = splitExtensions(value, rules);
  const parsed = handoffSchema.safeParse(core);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'document'}: ${issue.message}`).join('; ');
    throw new HandoffFileError('invalid_schema', detail, file);
  }
  return { handoff: parsed.data, present };
}

/** Normalize a completed handoff's decision and check it against the stage's allowed values. */
function completedDecision(raw: string | null | undefined, rules: HandoffRules, file: string): string | null {
  const allowed = rules.decisionValues.filter((item) => item).map((item) => item.toLowerCase());
  const decision = raw?.toLowerCase() ?? null;
  if (allowed.length > 0) {
    if (decision === null) {
      throw new HandoffFileError('invalid_decision', `decision is required when status is complete. Allowed: ${allowed.join(', ')}.`, file);
    }
    if (!allowed.includes(decision)) {
      throw new HandoffFileError('invalid_decision', `Invalid decision: ${raw}. Allowed: ${allowed.join(', ')}.`, file);
    }
  }
  return decision;
}
