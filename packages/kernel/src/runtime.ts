export const MIGENT_DIRNAME = ".migent";
export const EXECUTIONS_DIRNAME = "executions";
export const SESSIONS_DIRNAME = "sessions";
export const CONVERSATION_FILENAME = "conversation.json";
export const LEGACY_CONVERSATION_FILENAME = "session.json";
export const EXECUTION_SCHEMA_VERSION = 1;

export function log(message: string): void {
  process.stderr.write(`[migent] ${message}\n`);
}

/** Local time, matching `datetime.now().astimezone().strftime("%H:%M:%S")`. */
export function logProgress(message: string): void {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  process.stderr.write(`[${hh}:${mm}:${ss}] ${message}\n`);
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

export function addStageOutcomeContract(prompt: string, decisionValues: readonly string[] = []): string {
  const lines = [
    "Workflow stage response contract:",
    "Start the final response with `status: complete` or `status: blocked`.",
    "When blocked, put `blocker: <concise reason>` on the next line.",
  ];
  const allowed = decisionValues.filter((value) => value).map((value) => value.toLowerCase());
  if (allowed.length > 0) {
    lines.push(`When complete, put \`decision: ${allowed.join("|")}\` on the next line.`);
    lines.push("Do not put the decision only in prose.");
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
