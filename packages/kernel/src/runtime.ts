import { renderPrompt } from "./prompt-renderer.js";
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

export interface ProviderPromptOptions {
  contract?: boolean;
  decisionValues?: readonly string[];
  decisionInstructions?: Readonly<Record<string, string>>;
  ask?: AskTarget | null;
  artifactDirectory?: string;
  artifactName?: string | null;
  previousVerifyReport?: string | null;
}

export function renderProviderPrompt(prompt: string, options: ProviderPromptOptions = {}): string {
  const instructions = options.decisionInstructions ?? {};
  const decisions = (options.decisionValues ?? []).filter(Boolean).map((value) => {
    const name = value.toLowerCase();
    return { name, instruction: instructions[name] ?? "undefined" };
  });
  return renderPrompt("provider-turn", {
    prompt,
    contract: options.contract ?? false,
    canAsk: options.ask != null,
    decisions,
    decisionLabel: decisions.map(({ name }) => name).join("|"),
    hasDecisionInstructions: Object.keys(instructions).length > 0,
    artifactDirectory: options.artifactDirectory ?? "",
    artifactName: options.artifactName ?? null,
    previousVerifyReport: options.previousVerifyReport ?? null,
  });
}

export function addArtifactContext(prompt: string, artifactDirectory: string, artifactName?: string | null): string {
  return renderProviderPrompt(prompt, { artifactDirectory, artifactName });
}

export function addStageOutcomeContract(
  prompt: string,
  decisionValues: readonly string[] = [],
  decisionInstructions: Readonly<Record<string, string>> = {},
  ask: AskTarget | null = null,
): string {
  return renderProviderPrompt(prompt, { contract: true, decisionValues, decisionInstructions, ask });
}

export function flattenHistory(history: readonly { role: string; content: string }[]): string {
  return renderPrompt("history", { history });
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
