import { createHash } from "node:crypto";
import { parseDocument, stringify, visit } from "yaml";
import { ConfigurationError } from "./errors.js";
import { documentVersion, isRecord } from "./record.js";
import { SCHEMA_VERSION } from "./workflow.js";
import { parseYamlDocument } from "./yaml.js";

export type DraftFormat = "yaml" | "json";

/** SHA-256 of raw bytes, lowercase hex. The hash `save --base-hash` compares. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function jsonErrorPosition(text: string, message: string): { line: number; column: number } | undefined {
  const lineColumn = /\(line (\d+) column (\d+)\)/.exec(message);
  if (lineColumn) return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  const offset = /position (\d+)/.exec(message);
  if (!offset) return undefined;
  const lines = text.slice(0, Number(offset[1])).split("\n");
  return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
}

/**
 * Parses draft text into a mapping. JSON must satisfy the strict JSON grammar first; the data then
 * comes from the YAML parser so both formats treat duplicate keys the same way.
 */
export function parseDraftText(text: string, format: DraftFormat): Record<string, unknown> {
  if (format === "json") {
    try {
      JSON.parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const position = jsonErrorPosition(text, message);
      throw new ConfigurationError(message, { code: "json-syntax", ...(position === undefined ? {} : { position }) });
    }
  }
  const parsed = parseYamlDocument(text);
  if (!isRecord(parsed)) {
    throw new ConfigurationError("Invalid document: expected a mapping.", { code: "not-a-mapping" });
  }
  return parsed;
}

/**
 * The one canonical rendering. It depends only on the draft mapping, keeps its key order, and is what
 * both `render` and `save` emit. `base` is reserved for a future comment-preserving renderer.
 */
export function renderAuthoringYaml(mapping: Record<string, unknown>, _base?: string): string {
  return stringify(mapping, { lineWidth: 0 });
}

/** True when the YAML text carries any comment. */
export function yamlHasComments(text: string): boolean {
  try {
    const doc = parseDocument(text);
    if (doc.comment || doc.commentBefore) return true;
    let found = false;
    visit(doc, {
      Node(_key, node) {
        if (node.comment || node.commentBefore) found = true;
      },
      Pair(_key, pair) {
        const key = pair.key as { comment?: string; commentBefore?: string } | null;
        if (key && (key.comment || key.commentBefore)) found = true;
      },
    });
    return found;
  } catch {
    return false;
  }
}

export type SchemaVersionStatus =
  | { status: "current"; version: number }
  | { status: "outdated"; version: number }
  | { status: "newer"; version: number }
  | { status: "invalid"; message: string };

/** The per-document schema rule runtime applies: only the current version is accepted. Missing is 0. */
export function checkDocumentSchemaVersion(document: Record<string, unknown>): SchemaVersionStatus {
  let version: number;
  try {
    version = documentVersion(document);
  } catch (error) {
    return { status: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
  if (version === SCHEMA_VERSION) return { status: "current", version };
  return { status: version > SCHEMA_VERSION ? "newer" : "outdated", version };
}
