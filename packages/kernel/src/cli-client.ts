import type { BuildCommandInput, ProviderOption, TurnUsage, UsageCapture } from "./provider-contract.js";
import type { CommandSpec } from "./command-executor.js";

/** What a client extracted from a failed run, before any provider policy. */
export interface RawFailure {
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

  options(): readonly ProviderOption[];
  validateOptions(options: Readonly<Record<string, string>>): void;

  runCommand(input: BuildCommandInput): CommandSpec;
  modelsCommand(): CommandSpec;
  versionCommand(): CommandSpec;

  parseRun(stdout: string, lastMessageFile: string): CliRunOutput;
  parseModels(stdout: string): CliModelCatalog;
  parseVersion(stdout: string): string | null;
  /** One parser per run: it may keep state between lines. */
  createEventParser(): (line: string) => Record<string, unknown> | null;
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
