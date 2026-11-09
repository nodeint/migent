import { WorkflowDecisionEntry, WorkflowDocumentInput, WorkflowSession, WorkflowStage } from "@nodeint/migent-contracts";
import { isRecord } from "./record.js";

/**
 * Authoring feedback. These helpers report what Migent cannot use in a workflow or config document.
 * They never rewrite or reinterpret the author's text.
 */

/**
 * Key lists derive from the workflow contract (schema_version 7). Keys the contract no longer
 * declares but older documents still carry stay listed here so the version-gated readers keep
 * their "removed in schema_version N, run `migent migrate`" messages instead of "not used".
 */
const keysOf = (schema: { properties: object }): string[] => Object.keys(schema.properties);
const WORKFLOW_KEYS = [...keysOf(WorkflowDocumentInput), "outputs", "requires"];
const STAGE_KEYS_COMMON_LEGACY = ["produces"];
/** Stage keys through schema_version 4 select a model alias and tune options. */
const STAGE_KEYS_V4 = [...keysOf(WorkflowStage).filter((key) => key !== "agent"), ...STAGE_KEYS_COMMON_LEGACY, "model", "options"];
/** Schema_version 5 and later select an agent instead. */
const STAGE_KEYS_V5 = [...keysOf(WorkflowStage), ...STAGE_KEYS_COMMON_LEGACY];
const STAGE_V5_RENAMED: Readonly<Record<string, string>> = {
  model: "was renamed to {location}.agent in schema_version 5. Run `migent migrate`.",
  options: "was removed in schema_version 5. Set options on an inline {location}.agent under client.options.",
};
const PRODUCES_KEYS = ["artifact"];
const SESSION_KEYS = keysOf(WorkflowSession);
const DECISION_ENTRY_KEYS = keysOf(WorkflowDecisionEntry);

/** From this schema version on, unknown keys are errors instead of warnings. */
export const UNKNOWN_KEYS_ERROR_SCHEMA_VERSION = 5;

export function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

export function closest(key: string, valid: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Math.max(2, Math.floor(key.length / 3)) + 1;
  for (const candidate of valid) {
    const d = distance(key.toLowerCase(), candidate);
    if (d < bestDistance) { best = candidate; bestDistance = d; }
  }
  return best;
}

/** A key Migent does not use, with where it sits. */
export interface UnknownKey {
  code: "unknown-key";
  message: string;
  path: (string | number)[];
}

export function unknownKeyEntries(
  value: Record<string, unknown>,
  valid: readonly string[],
  location: string,
  base: readonly (string | number)[],
  renamed: Readonly<Record<string, string>> = {},
): UnknownKey[] {
  const entries: UnknownKey[] = [];
  for (const key of Object.keys(value)) {
    if (valid.includes(key)) continue;
    const suggestion = closest(key, valid);
    const path = location === "" ? key : `${location}.${key}`;
    const hint = Object.hasOwn(renamed, key) ? renamed[key]!.replaceAll("{location}", location) : null;
    entries.push({
      code: "unknown-key",
      message: hint !== null
        ? `${path} ${hint}`
        : `${path} is not used by Migent.${suggestion === null ? "" : ` Did you mean ${location === "" ? suggestion : `${location}.${suggestion}`}?`}`,
      path: [...base, key],
    });
  }
  return entries;
}

export function unknownKeys(value: Record<string, unknown>, valid: readonly string[], location: string): string[] {
  const messages: string[] = [];
  for (const key of Object.keys(value)) {
    if (valid.includes(key)) continue;
    const suggestion = closest(key, valid);
    const path = location === "" ? key : `${location}.${key}`;
    messages.push(`${path} is not used by Migent.${suggestion === null ? "" : ` Did you mean ${location === "" ? suggestion : `${location}.${suggestion}`}?`}`);
  }
  return messages;
}

/** Unknown keys at the top level, stages, `produces`, `session` and decision entries, with author-coordinate paths. */
export function unknownWorkflowKeyEntries(data: Record<string, unknown>): UnknownKey[] {
  const entries = unknownKeyEntries(data, WORKFLOW_KEYS, "", []);
  const version = typeof data.schema_version === "number" ? data.schema_version : 0;
  if (!Array.isArray(data.stages)) return entries;
  data.stages.forEach((stage, index) => {
    if (!isRecord(stage) || typeof stage.id !== "string") return;
    const location = `stages.${stage.id}`;
    const base = ["stages", index];
    entries.push(...(version >= 5
      ? unknownKeyEntries(stage, STAGE_KEYS_V5, location, base, STAGE_V5_RENAMED)
      : unknownKeyEntries(stage, STAGE_KEYS_V4, location, base)));
    if (isRecord(stage.produces)) entries.push(...unknownKeyEntries(stage.produces, PRODUCES_KEYS, `${location}.produces`, [...base, "produces"]));
    if (isRecord(stage.session)) entries.push(...unknownKeyEntries(stage.session, SESSION_KEYS, `${location}.session`, [...base, "session"]));
    if (!Array.isArray(stage.decision)) return;
    stage.decision.forEach((entry, entryIndex) => {
      if (!isRecord(entry) || Object.keys(entry).length !== 1) return;
      const name = Object.keys(entry)[0]!;
      const body = entry[name];
      if (isRecord(body)) entries.push(...unknownKeyEntries(body, DECISION_ENTRY_KEYS, `${location}.decision.${name}`, [...base, "decision", entryIndex, name]));
    });
  });
  return entries;
}

/** Unknown keys of a workflow mapping as messages. */
export function unknownWorkflowKeys(data: Record<string, unknown>): string[] {
  return unknownWorkflowKeyEntries(data).map((entry) => entry.message);
}

const RULES: ReadonlyArray<[RegExp, string]> = [
  [/^Unknown workflow keys/, "unknown-key"],
  [/newer than this Migent/, "schema-newer"],
  [/schema_version/, "schema-version-invalid"],
  [/^Duplicate stage id/, "duplicate-stage-id"],
  [/is required\.$/, "missing-required"],
  [/depends on unknown|unknown stage|Unknown stage|unknown dependency|not a stage/i, "unknown-stage"],
  [/cycle|circular/i, "dependency-cycle"],
  [/must be a (list|mapping|string|non-negative|positive|integer|boolean)|must be (one of|a)|invalid/i, "invalid-value"],
  [/unknown output|unknown artifact|artifact/i, "invalid-artifact"],
  [/downstream/i, "invalid-downstream"],
  [/verify/i, "invalid-verify"],
  [/decision|route|navigate/i, "invalid-decision"],
];

/** Stable code for a parser message that carries none. */
export function workflowRuleCode(message: string): string {
  for (const [pattern, code] of RULES) if (pattern.test(message)) return code;
  return "workflow-invalid";
}

/** Key and index segments at the start of `rest` (`.options.foo`, `[2]`), followed only while the data has them. */
function fieldPathWithin(item: unknown, rest: string): { path: (string | number)[]; confirmed: number } {
  const out: (string | number)[] = [];
  let confirmed = 0;
  let current = item;
  let text = rest;
  for (;;) {
    const match = /^(?:\.([A-Za-z_][\w-]*)|\[(\d+)\])/.exec(text);
    if (match === null) break;
    text = text.slice(match[0].length);
    const key: string | number = match[1] !== undefined ? match[1] : Number(match[2]);
    if (out.length > 0) {
      const present = typeof key === "number"
        ? Array.isArray(current) && key < current.length
        : isRecord(current) && Object.hasOwn(current, key);
      if (!present) break;
    }
    out.push(key);
    if (typeof key === "number" ? Array.isArray(current) && key < current.length : isRecord(current) && Object.hasOwn(current, key)) confirmed += 1;
    current = typeof key === "number" ? (current as unknown[])[key] : (current as Record<string, unknown>)[key];
  }
  return { path: out, confirmed };
}

const MISSING_STAGE_ID = /^Missing or invalid stages\.id\.$/;

/**
 * The parser reports decision routes as `.decision.routes.<name>` on normalized data; the draft keeps a list
 * (`decision: [{ <name>: { navigate } }]`). Maps such a message tail back to the draft's own coordinates.
 */
function routeAuthorPath(item: Record<string, unknown>, rest: string): (string | number)[] | undefined {
  const match = /^\.decision\.routes\.([^.\[\s]+)((?:\[\d+\])*)/.exec(rest);
  if (match === null || !Array.isArray(item.decision)) return undefined;
  const name = match[1]!;
  const index = item.decision.findIndex((entry) =>
    isRecord(entry) && Object.keys(entry).length === 1 && Object.keys(entry)[0]!.trim().toLowerCase() === name);
  if (index === -1) return ["decision"];
  const tail = [...(match[2] ?? "").matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  return ["decision", index, Object.keys(item.decision[index] as object)[0]!, "navigate", ...tail];
}

/** Path for a message raised while reading the stage at `index`: the stage is known, so only the field is derived. */
export function stageErrorPath(message: string, index: number, item: unknown): (string | number)[] {
  const base: (string | number)[] = ["stages", index];
  if (!isRecord(item)) return base;
  if (/^Duplicate stage id\b/.test(message) || MISSING_STAGE_ID.test(message)) return [...base, "id"];
  const id = item.id;
  if (typeof id === "string" && id.trim() !== "") {
    const needle = `stages.${id}`;
    for (let at = message.indexOf(needle); at !== -1; at = message.indexOf(needle, at + 1)) {
      const rest = message.slice(at + needle.length);
      if (!/^[\w-]/.test(rest)) return [...base, ...routeAuthorPath(item, rest) ?? fieldPathWithin(item, rest).path];
    }
  }
  return base;
}

/**
 * Author-coordinate path for a parser message. The parser names stages by id (`stages.<id>.<field>`);
 * this finds the stage by exact id (the longest match wins, so ids may contain dots), then follows the
 * named fields only as far as the draft actually has them.
 */
export function workflowErrorPath(message: string, data: Record<string, unknown>): (string | number)[] | undefined {
  const stages = Array.isArray(data.stages) ? (data.stages as unknown[]) : [];
  const duplicate = /^Duplicate stage id: (.*)$/.exec(message);
  if (duplicate) {
    const at = stages.flatMap((stage, index) => (isRecord(stage) && stage.id === duplicate[1] ? [index] : []));
    if (at.length > 1) return ["stages", at[1]!, "id"];
  }
  if (MISSING_STAGE_ID.test(message)) {
    const at = stages.findIndex((stage) => isRecord(stage) && (typeof stage.id !== "string" || stage.id.trim() === ""));
    if (at !== -1) return ["stages", at, "id"];
  }
  if (message.startsWith("Workflow stage must be a mapping")) {
    const at = stages.findIndex((stage) => !isRecord(stage));
    if (at !== -1) return ["stages", at];
  }
  // Several ids can prefix one message (`a` and `a.options`): take the one whose fields the draft really has.
  let best: { path: (string | number)[]; confirmed: number; length: number } | null = null;
  stages.forEach((stage, index) => {
    if (!isRecord(stage) || typeof stage.id !== "string" || stage.id.trim() === "") return;
    const needle = `stages.${stage.id}`;
    for (let at = message.indexOf(needle); at !== -1; at = message.indexOf(needle, at + 1)) {
      const rest = message.slice(at + needle.length);
      if (/^[\w-]/.test(rest)) continue;
      const mapped = routeAuthorPath(stage, rest);
      const found = mapped !== undefined ? { path: mapped, confirmed: mapped.length } : fieldPathWithin(stage, rest);
      if (best === null || found.confirmed > best.confirmed || (found.confirmed === best.confirmed && needle.length > best.length)) {
        best = { path: ["stages", index, ...found.path], confirmed: found.confirmed, length: needle.length };
      }
      break;
    }
  });
  if (best !== null) return (best as { path: (string | number)[] }).path;
  const top = /^(downstream|outputs|constraints|concurrency|completion|requires|id)\b/.exec(message);
  return top ? [top[1]!] : undefined;
}
