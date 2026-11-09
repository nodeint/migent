export { ConfigurationError } from "@nodeint/migent-workflow";
export type { ConfigurationErrorDetails, SourcePosition } from "@nodeint/migent-workflow";

/** The completing execution is saved. The run stops because an output file is missing. */
export class OutputsMissing extends Error {
  constructor(readonly names: readonly string[]) {
    super(`Completion outputs missing or empty: ${names.join(", ")}.`);
    this.name = "OutputsMissing";
  }
}
