export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** The completing execution is saved. The run stops because an output file is missing. */
export class OutputsMissing extends Error {
  constructor(readonly names: readonly string[]) {
    super(`Completion outputs missing or empty: ${names.join(", ")}.`);
    this.name = "OutputsMissing";
  }
}
