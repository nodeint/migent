import type { CommandSpec } from "./command-executor.js";

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

export interface ClientOption {
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

/**
 * The CLI itself: how to invoke it and how to read what it prints. A client
 * knows nothing about migent defaults, usage accounting or failure policy.
 */
export interface CliClient {
  readonly id: string;
  readonly command: string;
  /** Native option used for the model-level effort alias; absent when unsupported. */
  readonly effortOption?: string;

  options(): readonly ClientOption[];
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

/** The narrow client surface config resolution and doctor need. */
export interface ClientInfo {
  readonly id: string;
  readonly command: string;
  readonly effortOption?: string;
  options(): readonly ClientOption[];
  validateOptions(options: Readonly<Record<string, string>>): void;
}

/**
 * The one selection entry point. The kernel only defines the interface; the CLI
 * composition root builds it from the adapters' `createClient`/`clientIds`.
 * `get` throws a `ConfigurationError` that names the supported IDs.
 */
export interface ClientRegistry {
  ids(): string[];
  get(id: string): CliClient;
}
