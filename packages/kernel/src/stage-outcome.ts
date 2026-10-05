export const outcomeStatuses = new Set(["complete", "blocked"]);

export class StageOutcome {
  constructor(
    readonly status: string,
    readonly blocker: string | null = null,
    readonly decision: string | null = null,
  ) {}

  toJson(): Record<string, string> {
    const outcome: Record<string, string> = { status: this.status };
    if (this.blocker) outcome.blocker = this.blocker;
    if (this.decision) outcome.decision = this.decision;
    return outcome;
  }
}

export function parseStageOutcome(
  response: string,
  required: boolean,
  decisionValues: readonly string[] = [],
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
