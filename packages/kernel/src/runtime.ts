import type { AskTarget } from "./stage-outcome.js";
export const MIGENT_DIRNAME = ".migent";
export const EXECUTIONS_DIRNAME = "executions";
export const SESSIONS_DIRNAME = "sessions";
export const CONVERSATION_FILENAME = "conversation.json";
export const LEGACY_CONVERSATION_FILENAME = "session.json";
export const EXECUTION_SCHEMA_VERSION = 1;

export function log(message: string): void {
  process.stderr.write(`[migent] ${message}\n`);
}

/** Local time, `HH:MM:SS`. */
export function formatClock(date = new Date()): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** Whole seconds, as `12s`, `3m 4s`, or `1h 2m 3s`. */
export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Local time, matching `datetime.now().astimezone().strftime("%H:%M:%S")`. */
export function logProgress(message: string): void {
  process.stderr.write(`[${formatClock()}] ${message}\n`);
}

/** Python `datetime.now(timezone.utc).isoformat()` uses `+00:00`. */
export function utcNow(): string {
  return new Date().toISOString().replace(/Z$/, "+00:00");
}

export function addArtifactContext(
  prompt: string,
  artifactDirectory: string,
  artifactName?: string | null,
): string {
  if (!artifactName) return prompt;
  return (
    `${prompt}\n\n` +
    "Migent artifact directory:\n" +
    `${artifactDirectory}\n` +
    `Write the file artifact as \`${artifactName}\` in that directory.`
  );
}

export function addStageOutcomeContract(
  prompt: string,
  decisionValues: readonly string[] = [],
  decisionInstructions: Readonly<Record<string, string>> = {},
  ask: AskTarget | null = null,
): string {
  const lines = [
    "Workflow stage response contract:",
    ask === null
      ? "Start the final response with `status: complete` or `status: blocked`."
      : "Start the final response with `status: complete`, `status: blocked`, or `status: question`.",
    "When blocked, put `blocker: <concise reason>` on the next line.",
  ];
  if (ask !== null) {
    lines.push('To ask the human, return status: question, a blank line, and a JSON document: {"schema_version":1,"questions":[{"question":"Include existing sessions?","context":"Migration adds work.","selection":"single","options":[{"label":"New sessions only"},{"label":"Include existing sessions"}]}]}.');
    lines.push("Each question requires question, context, selection (single or multiple), and 2 to 26 options with labels. Migent assigns question IDs 1, 2, 3, ... and option IDs A, B, C, ... by order. Omit IDs. Put every choice and its explanation in the JSON, not in prose.");
    lines.push("Optional fields: option.description and question.recommended (array of option IDs; at most one for single selection). Free-text answers are always allowed for every question. Never choose on the recipient's behalf.");
    lines.push("Migent writes validated questions to questions.json. You may ask several questions in one document. Every question must be answered before the stage continues.");
    lines.push("Use blocked for an obstacle you cannot resolve; use question when you need an answer. Do not choose a decision while asking.");
  }
  const allowed = decisionValues.filter((value) => value).map((value) => value.toLowerCase());
  if (allowed.length > 0) {
    lines.push(`When complete, put \`decision: ${allowed.join("|")}\` on the next line.`);
    lines.push("Do not put the decision only in prose.");
    if (Object.keys(decisionInstructions).length > 0) {
      lines.push("Choose exactly one decision using these instructions:");
      for (const value of allowed) lines.push(`- ${value}: ${decisionInstructions[value]}`);
    }
  }
  lines.push("Use a blank line before the report body.");
  return `${prompt}\n\n${lines.join("\n")}`;
}

export function flattenHistory(history: readonly { role: string; content: string }[]): string {
  return history.map((item) => `${item.role}: ${item.content}`).join("\n");
}

export function isUnicodeAlnum(character: string): boolean {
  return /^[\p{L}\p{N}]$/u.test(character);
}

export function safeComponent(value: string): string {
  let normalized = "";
  for (const character of value) {
    normalized +=
      isUnicodeAlnum(character) || character === "-" || character === "_" ? character : "-";
  }
  normalized = normalized.replace(/^[-_]+/u, "").replace(/[-_]+$/u, "");
  if (!normalized) throw new Error("Stage ID must contain at least one letter or number.");
  return normalized;
}
