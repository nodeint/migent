import type { Question } from './questions.js';

export const outcomeStatuses = new Set(['complete', 'blocked', 'question']);

import type { AskTarget } from '@nodeint/migent-workflow';
export type { AskTarget };

/** The reply broke the response contract (status or decision header). The agent can fix it by replying again. */
export class ResponseContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseContractError';
  }
}

export class StageOutcome {
  constructor(
    public readonly status: string,
    public readonly blocker: string | null = null,
    public readonly decision: string | null = null,
    public readonly question: string | null = null,
    public readonly questions: Question[] = [],
  ) {}

  public toJson(): Record<string, unknown> {
    const outcome: Record<string, unknown> = { status: this.status };
    if (this.blocker) outcome.blocker = this.blocker;
    if (this.decision) outcome.decision = this.decision;
    if (this.question) outcome.question = this.question;
    if (this.questions.length > 0) outcome.questions = this.questions;
    return outcome;
  }
}

/** Parses response headers only. A `question` outcome has no questions until the request file is loaded. */
export function parseStageOutcome(
  response: string,
  required: boolean,
  decisionValues: readonly string[] = [],
  ask: AskTarget | null = null,
): StageOutcome | null {
  const headers = leadingHeaders(response);
  const rawStatus = headers.get('status');
  if (rawStatus === undefined) {
    if (required) {
      const statuses = ask === null ? ['complete', 'blocked'] : ['complete', 'blocked', 'question'];
      throw new ResponseContractError(
        `Workflow stage response must start with ${statuses.map((item) => `\`status: ${item}\``).join(', ').replace(/, ([^,]*)$/, ' or $1')}.`,
      );
    }
    return null;
  }
  const status = rawStatus.toLowerCase();
  if (!outcomeStatuses.has(status)) {
    const allowed = [...outcomeStatuses].sort().join(', ');
    throw new ResponseContractError(`Invalid workflow stage status: ${rawStatus}. Allowed: ${allowed}.`);
  }
  const decision = parseDecision(headers.get('decision'), status, decisionValues);
  if (status === 'question') {
    if (ask === null) throw new ResponseContractError('status: question requires ask: human.');
    // Questions come from the question request file; see resolveStageOutcome.
    return new StageOutcome(status);
  }
  return new StageOutcome(status, headers.get('blocker') ?? null, decision);
}

function parseDecision(
  rawDecision: string | undefined,
  status: string,
  decisionValues: readonly string[],
): string | null {
  const allowed = decisionValues.filter((value) => value).map((value) => value.toLowerCase());
  if (status !== 'complete') return null;
  if (allowed.length === 0) return rawDecision ? rawDecision.toLowerCase() : null;
  if (rawDecision === undefined || rawDecision.trim() === '') {
    const allowedLabel = allowed.join('|');
    throw new ResponseContractError(
      'Workflow stage response must include ' +
        `\`decision: ${allowedLabel}\` when status is complete.`,
    );
  }
  const decision = rawDecision.trim().toLowerCase();
  if (!allowed.includes(decision)) {
    const allowedLabel = allowed.join(', ');
    throw new ResponseContractError(
      `Invalid workflow stage decision: ${rawDecision}. Allowed: ${allowedLabel}.`,
    );
  }
  return decision;
}

export function leadingHeaders(response: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of response.split(/\r\n|\n|\r/)) {
    if (line.trim() === '') break;
    const separator = line.indexOf(':');
    if (separator <= 0) break;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === '' || value === '') break;
    headers.set(key, value);
  }
  return headers;
}
