import { parseQuestionBody, type Question } from "./questions.js";

export const outcomeStatuses = new Set(["complete", "blocked", "question"]);

/** The recipient is separate from the question outcome; more recipients can be added later. */
export type AskTarget = "human";

export class StageOutcome {
  constructor(
    readonly status: string,
    readonly blocker: string | null = null,
    readonly decision: string | null = null,
    readonly question: string | null = null,
    readonly questions: Question[] = [],
  ) {}

  toJson(): Record<string, unknown> {
    const outcome: Record<string, unknown> = { status: this.status };
    if (this.blocker) outcome.blocker = this.blocker;
    if (this.decision) outcome.decision = this.decision;
    if (this.question) outcome.question = this.question;
    if (this.questions.length > 0) outcome.questions = this.questions;
    return outcome;
  }
}

export function parseStageOutcome(
  response: string,
  required: boolean,
  decisionValues: readonly string[] = [],
  ask: AskTarget | null = null,
): StageOutcome | null {
  const headers = leadingHeaders(response);
  const rawStatus = headers.get("status");
  if (rawStatus === undefined) {
    if (required) {
      throw new Error(
        "Workflow stage response must start with `status: complete` or `status: blocked`.",
      );
    }
    return null;
  }
  const status = rawStatus.toLowerCase();
  if (!outcomeStatuses.has(status)) {
    const allowed = [...outcomeStatuses].sort().join(", ");
    throw new Error(`Invalid workflow stage status: ${rawStatus}. Allowed: ${allowed}.`);
  }
  const decision = parseDecision(headers.get("decision"), status, decisionValues);
  if (status === "question") {
    if (ask === null) throw new Error("status: question requires ask: human.");
    const questions = parseQuestionBody(response);
    return new StageOutcome(status, null, null, questions[0]!.question, questions);
  }
  return new StageOutcome(status, headers.get("blocker") ?? null, decision);
}

function parseDecision(
  rawDecision: string | undefined,
  status: string,
  decisionValues: readonly string[],
): string | null {
  const allowed = decisionValues.filter((value) => value).map((value) => value.toLowerCase());
  if (status !== "complete") return null;
  if (allowed.length === 0) return rawDecision ? rawDecision.toLowerCase() : null;
  if (rawDecision === undefined || rawDecision.trim() === "") {
    const allowedLabel = allowed.join("|");
    throw new Error(
      "Workflow stage response must include " +
        `\`decision: ${allowedLabel}\` when status is complete.`,
    );
  }
  const decision = rawDecision.trim().toLowerCase();
  if (!allowed.includes(decision)) {
    const allowedLabel = allowed.join(", ");
    throw new Error(
      `Invalid workflow stage decision: ${rawDecision}. Allowed: ${allowedLabel}.`,
    );
  }
  return decision;
}

function leadingHeaders(response: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of response.split(/\r\n|\n|\r/)) {
    if (line.trim() === "") break;
    const separator = line.indexOf(":");
    if (separator <= 0) break;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "" || value === "") break;
    headers.set(key, value);
  }
  return headers;
}
