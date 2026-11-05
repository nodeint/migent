import { parse, YAMLParseError } from "yaml";
import { ConfigurationError } from "./errors.js";

export function parseYamlDocument(text: string): unknown {
  try {
    return parse(text);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const [position] = error.linePos ?? [];
      throw new ConfigurationError(error.message, {
        code: error.code === "DUPLICATE_KEY" ? "duplicate-key" : "yaml-syntax",
        ...(position === undefined ? {} : { position: { line: position.line, column: position.col } }),
      });
    }
    throw error;
  }
}
