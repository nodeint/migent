/** One-based start of a range and its exclusive one-based end. */
export interface SourcePosition {
  line: number;
  column: number;
  /** Exclusive end of the node, when the parser reports one. */
  end?: { line: number; column: number };
}

/** Structured context for a configuration problem. The message stays the user-facing text. */
export interface ConfigurationErrorDetails {
  /** Stable identifier of the rule that failed. */
  code?: string;
  /** Field path in the effective config, e.g. `["roles", "dev", "default_model"]`. */
  path?: readonly (string | number)[];
  /** Config layer the problem was found in, when a single file was read. */
  layer?: "project" | "local";
  /** One-based line and column, for YAML syntax errors. */
  position?: SourcePosition;
}

export class ConfigurationError extends Error {
  readonly code: string | undefined;
  readonly path: readonly (string | number)[] | undefined;
  readonly layer: "project" | "local" | undefined;
  readonly position: SourcePosition | undefined;

  constructor(message: string, details: ConfigurationErrorDetails = {}) {
    super(message);
    this.name = "ConfigurationError";
    this.code = details.code;
    this.path = details.path;
    this.layer = details.layer;
    this.position = details.position;
  }
}
