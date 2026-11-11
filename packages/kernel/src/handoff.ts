import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { type Question,questionBatchSchema } from './questions.js';
import type { AskTarget } from './stage-outcome.js';

const text = z.string().trim().min(1);

/** The handoff document an agent writes under response protocol 3. */
export const handoffSchema = z.discriminatedUnion('status', [
  z.object({
    schema_version: z.literal(1), status: z.literal('complete'),
    decision: text.optional(), summary: z.string().optional(),
  }).strict(),
  z.object({ schema_version: z.literal(1), status: z.literal('blocked'), blocker: text }).strict(),
  z.object({ schema_version: z.literal(1), status: z.literal('question'), questions: questionBatchSchema }).strict(),
]);

export type Handoff = z.output<typeof handoffSchema>;

export type HandoffFileErrorKind =
  'missing' | 'empty' | 'invalid_json' | 'invalid_schema' | 'invalid_decision' | 'question_not_allowed';

/** The handoff file cannot be used. The kind and detail are safe to show to the agent. */
export class HandoffFileError extends Error {
  constructor(readonly kind: HandoffFileErrorKind, readonly detail: string, readonly file: string) {
    super(`Handoff file ${file} is invalid (${kind}): ${detail}`);
    this.name = 'HandoffFileError';
  }
}

export interface HandoffRules {
  decisionValues: readonly string[];
  ask: AskTarget | null;
}

export interface LoadedHandoff {
  status: 'complete' | 'blocked' | 'question';
  blocker: string | null;
  decision: string | null;
  questions: Question[];
}

/** Read the handoff file and run the shape and stage-dependent checks in one pass. */
export function loadHandoffFile(file: string, rules: HandoffRules): LoadedHandoff {
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
    value = JSON.parse(content.replace(/^﻿/, ''));
  } catch (error) {
    throw new HandoffFileError('invalid_json', error instanceof Error ? error.message : String(error), file);
  }
  const parsed = handoffSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'document'}: ${issue.message}`).join('; ');
    throw new HandoffFileError('invalid_schema', detail, file);
  }
  const handoff = parsed.data;
  if (handoff.status === 'question') {
    if (rules.ask === null) throw new HandoffFileError('question_not_allowed', 'status: question requires a stage with ask: human.', file);
    return { status: 'question', blocker: null, decision: null, questions: handoff.questions };
  }
  if (handoff.status === 'blocked') return { status: 'blocked', blocker: handoff.blocker, decision: null, questions: [] };
  const allowed = rules.decisionValues.filter((item) => item).map((item) => item.toLowerCase());
  const decision = handoff.decision?.toLowerCase() ?? null;
  if (allowed.length > 0) {
    if (decision === null) {
      throw new HandoffFileError('invalid_decision', `decision is required when status is complete. Allowed: ${allowed.join(', ')}.`, file);
    }
    if (!allowed.includes(decision)) {
      throw new HandoffFileError('invalid_decision', `Invalid decision: ${handoff.decision}. Allowed: ${allowed.join(', ')}.`, file);
    }
  }
  return { status: 'complete', blocker: null, decision, questions: [] };
}
