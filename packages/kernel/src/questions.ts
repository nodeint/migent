import { z } from "zod";
import { ConfigurationError } from "./errors.js";

const text = z.string().trim().min(1);
const questionId = text.regex(/^[1-9][0-9]*$/);
const optionId = text.regex(/^[A-Z]$/);
const questionSchema = z.object({
  id: questionId.optional(),
  question: text,
  context: text,
  selection: z.enum(["single", "multiple"]),
  options: z.array(z.object({ id: optionId.optional(), label: text, description: text.optional() }).strict()).min(2).max(26),
  recommended: z.array(optionId).min(1).optional(),
}).strict().superRefine((question, ctx) => {
  const ids = question.options.map((_, index) => String.fromCharCode(65 + index));
  if (question.options.some((option, index) => option.id !== undefined && option.id !== ids[index])) {
    ctx.addIssue({ code: "custom", message: "Option IDs must follow order A, B, C, ..." });
  }
  const recommended = question.recommended ?? [];
  if (recommended.some((value) => !ids.includes(value)) || new Set(recommended).size !== recommended.length) {
    ctx.addIssue({ code: "custom", message: "recommended must contain distinct option IDs." });
  }
  if (question.selection === "single" && recommended.length > 1) {
    ctx.addIssue({ code: "custom", message: "single selection permits only one recommendation." });
  }
});

export const questionDocumentSchema = z.object({
  schema_version: z.literal(1),
  questions: z.array(questionSchema).min(1),
}).strict().superRefine((document, ctx) => {
  const ids = document.questions.map((question) => question.id).filter((id) => id !== undefined);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Duplicate question id." });
  if (document.questions.some((question, index) => question.id !== undefined && question.id !== String(index + 1))) {
    ctx.addIssue({ code: "custom", message: "Question IDs must follow order 1, 2, 3, ..." });
  }
}).transform((document) => ({ ...document, questions: document.questions.map((question, index) => ({
  ...question, id: String(index + 1), options: question.options.map((option, optionIndex) => ({
    ...option, id: String.fromCharCode(65 + optionIndex),
  })),
})) }));

export type Question = z.output<typeof questionDocumentSchema>["questions"][number];
export interface QuestionAnswer {
  question_id: string;
  selected: string[];
  text?: string;
}

export function storedQuestions(outcome: Record<string, unknown> | null): Question[] {
  if (!Array.isArray(outcome?.questions)) return [];
  return questionDocumentSchema.parse({ schema_version: 1, questions: outcome.questions }).questions;
}

export function parseQuestionBody(response: string): Question[] {
  const separator = /\r?\n\s*\r?\n/.exec(response);
  if (!separator) throw new Error("status: question requires a JSON question document after the headers.");
  const body = response.slice(separator.index + separator[0].length).trim()
    .replace(/^```json\s*\n([\s\S]*?)\n```$/, "$1");
  const parsed = questionDocumentSchema.safeParse(JSON.parse(body));
  if (!parsed.success) throw new Error(`Invalid questions: ${parsed.error.message}`);
  return parsed.data.questions;
}

/** Validate a complete answer batch before unlocking the stage. */
export function answerQuestions(questions: readonly Question[], reply: string): QuestionAnswer[] {
  let value: unknown = reply;
  try {
    const parsed: unknown = JSON.parse(reply);
    // Numeric/boolean/null-looking replies are still free text for one question.
    if (typeof parsed === "string" || (typeof parsed === "object" && parsed !== null)) value = parsed;
  } catch { /* Plain option IDs and free text are allowed for one question. */ }
  if (typeof value === "string") {
    const numbered = numberedAnswers(questions, value);
    if (numbered !== null) value = numbered;
  }
  let values: Record<string, unknown>;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    values = value as Record<string, unknown>;
  } else if (questions.length === 1) {
    values = { [questions[0]!.id]: typeof value === "string" && /^[A-Za-z](?:\s*\+\s*[A-Za-z])+$/.test(value.trim())
      ? value.trim().toUpperCase().split(/\s*\+\s*/) : value };
  } else {
    throw new ConfigurationError("Answer every question using its number, for example: 1A, 2B, 3 explain further.");
  }
  if (Object.keys(values).length !== questions.length || Object.keys(values).some((key) => !questions.some((question) => question.id === key))) {
    throw new ConfigurationError("The reply must answer exactly the pending question IDs.");
  }
  return questions.map((question) => {
    const rawAnswer = values[question.id];
    const answer = typeof rawAnswer === "string" && /^[a-z]$/.test(rawAnswer) ? rawAnswer.toUpperCase() : rawAnswer;
    const ids = question.options.map((option) => option.id);
    if (typeof answer === "string" && !ids.includes(answer) && answer.trim()) {
      return { question_id: question.id, selected: [], text: answer };
    }
    const selected = typeof answer === "string" ? [answer] : Array.isArray(answer)
      ? answer.map((value) => typeof value === "string" && /^[a-z]$/.test(value) ? value.toUpperCase() : value) : answer;
    if (!Array.isArray(selected) || selected.length === 0 || selected.some((option) => typeof option !== "string" || !ids.includes(option)) || new Set(selected).size !== selected.length) {
      throw new ConfigurationError(`Question ${question.id}: select distinct IDs from its options.`);
    }
    if (question.selection === "single" && selected.length !== 1) {
      throw new ConfigurationError(`Question ${question.id}: select exactly one option.`);
    }
    return { question_id: question.id, selected: selected as string[] };
  });
}

/** Commas/newlines before numbered entries delimit answers; other commas stay in free text. */
function numberedAnswers(questions: readonly Question[], reply: string): Record<string, unknown> | null {
  const entries = reply.trim().split(/[,\n]\s*(?=[1-9][0-9]*(?:[A-Za-z]|\s|[.):]))/);
  const pattern = /^([1-9][0-9]*)(?:[.):]\s*|\s+|(?=[A-Za-z]))([\s\S]+)$/;
  if (!pattern.test(entries[0] ?? "")) return null;
  const values: Record<string, unknown> = {};
  for (const entry of entries) {
    const match = pattern.exec(entry.trim());
    if (!match) throw new ConfigurationError("Use a question number followed by a letter or free text.");
    const number = match[1]!;
    if (!questions.some((question) => question.id === number)) throw new ConfigurationError(`Unknown question number: ${number}.`);
    if (Object.hasOwn(values, number)) throw new ConfigurationError(`Question ${number} is answered more than once. Use A+C for multiple selections.`);
    const answer = match[2]!.trim();
    values[number] = /^[A-Za-z](?:\s*\+\s*[A-Za-z])*$/.test(answer)
      ? answer.toUpperCase().split(/\s*\+\s*/) : answer;
  }
  return values;
}

export function formatQuestionAnswers(questions: readonly Question[], answers: readonly QuestionAnswer[]): string {
  return JSON.stringify({ answers: answers.map((answer) => ({
    ...answer,
    question: questions.find((question) => question.id === answer.question_id)!.question,
    labels: answer.selected.map((id) => questions.find((question) => question.id === answer.question_id)!.options.find((option) => option.id === id)!.label),
  })) }, null, 2);
}
