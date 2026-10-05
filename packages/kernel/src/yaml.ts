import { parse, YAMLParseError } from "yaml";
import { ConfigurationError } from "./errors.js";

export function parseYamlDocument(text: string): unknown {
  try {
    return parse(text);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      throw new ConfigurationError(error.message);
    }
    throw error;
  }
}
