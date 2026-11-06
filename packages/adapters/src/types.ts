// ============ CommandSpec từ command-executor.ts ============
export interface CommandSpec {
  argv: string[];
  stdin?: string | null;
}

// ============ Các type từ provider-contract.ts ============

/** Methods doctor and config resolution call. Migrations are out of scope. */
export interface ProviderInfo {
  readonly command: string;
  readonly effortOption?: string;
  validateOptions(options: Readonly<Record<string, string>>): void;
  /** True when the provider has no default CLI client and every model must name one. */
  readonly requiresClient?: boolean;
  /** The same provider driving another CLI client, named by its id. Throws on an unknown id. */
  withClient?(clientId: string): ProviderInfo;
}

/** Resolve the provider with its selected CLI client already bound. */
export type ProviderResolver = (providerId: string, clientId?: string) => ProviderInfo;

export interface ProviderOption {
  name: string;
  prompt?: boolean;
  allowDefault?: boolean;
  overridable?: boolean;
}

export interface NewSession {
  agentId?: string | null;
  agentIdSource?: string | null;
}

export interface BuildCommandInput {
  model: string;
  workspace: string;
  prompt: string;
  agentId: string | null;
  newAgentId: string | null;
  promptFile: string;
  lastMessageFile: string;
  options: Readonly<Record<string, string>>;
}

/** Provider-shaped JSON selected from one process's stdout. Stored verbatim. */
export type UsageCapture = Record<string, unknown>;

export interface TurnUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
}

/**
 * Where a failure was observed. `provider-error`: the CLI protocol reported an error (an error event,
 * `is_error`, a failed result). `exit-only`: a non-zero exit with no reported error. `start`: no usable
 * exit code at all (spawn failure, an unpassable argument, signal death).
 */
export type FailureOrigin = "provider-error" | "exit-only" | "start";

/**
 * What the reply text of one run is. `model`: assistant output. `error`: text from an error payload or
 * unparsed stdout. `none`: no text.
 */
export type ResponseSource = "model" | "error" | "none";

export interface QuotaClassification {
  kind: "quota";
  origin: FailureOrigin;
  message: string;
  /** UTC ISO instant, or null when the provider did not name one. */
  resetAt: string | null;
  window: string | null;
}

export interface ProviderClassification {
  kind: "provider";
  origin: FailureOrigin;
  message: string;
}

/** `null` means this finished process is not a provider failure. */
export type FailureClassification = QuotaClassification | ProviderClassification;

/**
 * What an explicit server-side interrupt found. `interrupted`: a running turn was stopped.
 * `idle`: the server holds the session and nothing was running. `not-found`: the server does not
 * know the session (yet). `failed`: the interrupt could not be completed or verified.
 */
export type InterruptOutcome = "interrupted" | "idle" | "not-found" | "failed";

/** Provider CLI surface used by the workflow runner. Not the providers package. */
export interface Provider extends ProviderInfo {
  providerOptions?(): readonly ProviderOption[];
  profileOptions?(options: Readonly<Record<string, string>>): Record<string, string>;
  createNewSession?(): NewSession;
  /** Command that stops the server-side turn of `agentId`, for providers whose turn outlives the client. */
  interruptCommand?(agentId: string): CommandSpec | null;
  classifyInterrupt?(stdout: string, exitCode: number | null): InterruptOutcome;
  /** The session identity one output line carries, if any. */
  sessionIdFromLine?(line: string): string | null;
  buildCommand(input: BuildCommandInput): CommandSpec;
  /**
   * `[text, session id, source]`. A provider that omits `source` cannot attest where its text came from,
   * so the runner never accepts a failed turn on its reply.
   */
  parseResponse(stdout: string, lastMessageFile: string): [string, string | null, ResponseSource?];
  /** Classify one finished process. Absent means the runner uses its fallback. */
  classifyFailure?(stdout: string, exitCode: number): FailureClassification | null;
  parseProgressEvent?(line: string): Record<string, unknown> | null;
  /** The client's short label for one output line, for the stream summary of a diagnostics record. */
  eventLabel?(line: string): string | null;
  captureUsage?(stdout: string): UsageCapture | null;
  normalizeUsage?(current: UsageCapture, previous: UsageCapture | null): TurnUsage;
  versionCommand?(): string[];
  parseVersion?(stdout: string): string | null;
}

// ============ Các type từ cli-client.ts ============

/** What a client extracted from a failed run, before any provider policy. */
export interface RawFailure {
  /** `provider-error`: the CLI reported an error. `exit-only`: a non-zero exit and nothing else. */
  origin: "provider-error" | "exit-only";
  message: string | null;
  exitCode: number | null;
  /** Set only when the CLI's own protocol states the limit. */
  rateLimit?: {
    /** UTC ISO instant, or null when the CLI did not name one. */
    resetAt: string | null;
    window: string | null;
  };
}

export interface CliModelCatalog {
  readonly ids: readonly string[];
  readonly defaultId: string | null;
  readonly optionValues: ReadonlyArray<readonly [string, string, readonly string[]]>;
  valuesFor(modelId: string, option: string): readonly string[] | null;
}

/** A capture's figures as the CLI reported them, one field per `TurnUsage` metric. */
export interface CliUsage {
  readonly values: TurnUsage;
  /** Fields that are running totals across the session, not this turn's own. */
  readonly cumulative: readonly (keyof TurnUsage)[];
}

export interface CliRunOutput {
  text: string;
  /** What `text` is: assistant output, an error payload (or unparsed stdout), or nothing. */
  source: ResponseSource;
  sessionId: string | null;
}

/**
 * The CLI itself: how to invoke it and how to read what it prints. A client
 * knows nothing about migent defaults, usage accounting or failure policy.
 */
export interface CliClient {
  readonly id: string;
  readonly command: string;
  /** Native option used for the model-level effort alias; absent when unsupported. */
  readonly effortOption?: string;

  optionsCommand(): CommandSpec;
  parseOptions(help: string): HeadlessOption[];
  options(): readonly ProviderOption[];
  validateOptions(options: Readonly<Record<string, string>>): void;

  runCommand(input: BuildCommandInput): CommandSpec;
  modelsCommand(): CommandSpec;
  versionCommand(): CommandSpec;

  parseRun(stdout: string, lastMessageFile: string): CliRunOutput;
  /** A fresh session identity the CLI accepts on its first run; absent when the CLI picks its own. */
  newSessionId?(): string | null;
  interruptCommand?(sessionId: string): CommandSpec | null;
  classifyInterrupt?(stdout: string, exitCode: number | null): InterruptOutcome;
  sessionIdFromLine?(line: string): string | null;
  parseModels(stdout: string): CliModelCatalog;
  parseVersion(stdout: string): string | null;
  /** One parser per run: it may keep state between lines. */
  createEventParser(): (line: string) => Record<string, unknown> | null;
  /**
   * A short label for one output line from this client's own vocabulary (for example `text` or
   * `result:error`), or `null` when the line is not an event. Never a piece of the line's content.
   */
  eventLabel?(line: string): string | null;
  /** `null` means the run succeeded. A non-zero exit never yields `null`. */
  extractFailure(stdout: string, exitCode: number): RawFailure | null;
  /** The CLI's own usage figures, unmodified. */
  captureUsage(stdout: string): UsageCapture | null;
  /** Reads a stored capture. A field the CLI did not report is `null`. */
  readUsage(capture: UsageCapture): CliUsage;
  /** Command whose output lists the values `option` accepts, or `null` if the CLI lists none. */
  optionValuesCommand(option: string, model: string): CommandSpec | null;
  parseOptionValues(option: string, stdout: string, model: string): readonly string[];
}

// ============ Constant và hàm từ kernel ============

export const KERNEL_PLACEHOLDER = "kernel";

export const STATUS_PROVIDER_EVENTS = new Set([
  "provider.stage_started",
  "provider.turn_completed",
  "provider.turn_failed",
  "provider.quota",
  "provider.cancelled",
  "provider.error",
  "provider.warning",
  "provider.heartbeat",
  "verify.started",
  "verify.heartbeat",
  "verify.failed",
  "verify.passed",
]);

const CONTROL_PLANE_WARNING_MARKERS = ["failed to refresh available models"];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function providerErrorMessage(payload: Record<string, unknown>): string | null {
  const message = payload.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  const error = payload.error;
  if (isRecord(error)) {
    const nested = error.message;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  if (typeof error === "string" && error.trim()) return error.trim();
  return null;
}

export function classifyProviderError(message: string | null): { event: string; summary: string } {
  let summary = typeof message === "string" && message.trim() ? message.trim() : "";
  if (!summary) summary = "provider emitted an error";
  const lowered = summary.toLowerCase();
  let event = CONTROL_PLANE_WARNING_MARKERS.some((marker) => lowered.includes(marker))
    ? "provider.warning"
    : "provider.error";
  if (!STATUS_PROVIDER_EVENTS.has(event)) event = "provider.error";
  return { event, summary };
}

/** Help-derived facts only. Unknown types must not be treated as boolean flags. */
export interface HeadlessOption {
  name: string;
  flags: string[];
  description: string;
  argument: string | null;
  valueMode: "required" | "optional" | "none" | "unknown";
  type: "string" | "number" | "boolean" | "array" | "unknown";
  choices: string[] | null;
  defaultValue: string | null;
}
